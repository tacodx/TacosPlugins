import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Returns {data, fresh} or null. Never throws. */
export function readCache(path, { now, ttlMs, maxStaleMs, readFile = readFileSync }) {
  let entry
  try { entry = JSON.parse(readFile(path, 'utf8')) } catch { return null } // file missing or unreadable
  if (!entry || typeof entry.fetchedAt !== 'number' || !entry.data) return null // corrupt cache
  const age = now - entry.fetchedAt
  if (age > maxStaleMs) return null
  return { data: entry.data, fresh: age <= ttlMs }
}

/** Never throws — a cache we cannot persist is a slow cache, not a broken session. */
export function writeCache(path, data, {
  now, writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  try {
    mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFile(tmp, JSON.stringify({ fetchedAt: now, data }), { mode: 0o600 })
    renameSync(tmp, path)
  } catch { /* ignore write failures */ }
}

const defaultFs = {
  writeLock: (p, body) => writeFileSync(p, body, { flag: 'wx' }),
  readLock: (p) => readFileSync(p, 'utf8'),
  removeLock: (p) => unlinkSync(p),
}

/**
 * Best-effort lock. If another process holds a live lock we run anyway:
 * a duplicate usage fetch is far cheaper than stalling a hook.
 */
export async function withLock(lockPath, fn, { now, staleMs, fs = defaultFs } = {}) {
  let held = false
  try {
    fs.writeLock(lockPath, JSON.stringify({ at: now, pid: process.pid }))
    held = true
  } catch (err) {
    if (err?.code === 'EEXIST') {
      let at = 0
      try { at = JSON.parse(fs.readLock(lockPath))?.at ?? 0 } catch { at = 0 } // lock file corrupt or unreadable
      if (now - at > staleMs) {
        try { fs.removeLock(lockPath) } catch { /* ignore removal failure */ }
        try { fs.writeLock(lockPath, JSON.stringify({ at: now, pid: process.pid })); held = true }
        catch { /* ignore retry failure */ }
      }
    }
  }
  try { return await fn() }
  finally { if (held) { try { fs.removeLock(lockPath) } catch { /* ignore cleanup failure */ } } }
}
