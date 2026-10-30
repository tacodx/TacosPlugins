// Files that survive being killed mid-write. Every write goes to a temporary file
// in the same folder and is renamed into place, so a reader sees the old file or
// the new one, never half of one. Reads never throw: a missing or broken file
// is the fallback, because any night process may have been killed at any moment.
import {
  appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The parsed JSON at `path`, or `fallback` when it is missing or unreadable. */
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Writes `data` as JSON at `path` atomically, creating its folder. */
export function writeJson(path, data, { mode = 0o600 } = {}) {
  writeText(path, `${JSON.stringify(data, null, 2)}\n`, { mode })
}

/** Writes `text` at `path` atomically, creating its folder. */
export function writeText(path, text, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' })
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* never created */ }
    throw err
  }
}

/** Appends one JSON line. Lines under 4 KiB land whole even with several writers. */
export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

/** Every parseable line of a JSON-lines file; broken lines are skipped. */
export function readJsonl(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a line cut by a kill */ }
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a process with this pid is alive. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Runs `fn` while holding the lock folder `lock`. mkdir is atomic, so exactly one
 * process wins. A lock whose holder is dead, or older than `staleMs`, is taken
 * over. Waits up to `timeoutMs`, then throws: callers that must not run twice
 * (claiming a queue item) rely on that.
 */
export async function withLock(lock, fn, { timeoutMs = 30_000, staleMs = 120_000, now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  const owner = join(lock, 'owner.json')
  for (;;) {
    try {
      mkdirSync(dirname(lock), { recursive: true })
      mkdirSync(lock)
      writeFileSync(owner, JSON.stringify({ pid: process.pid, at: now() }))
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const holder = readJson(owner)
      let age = 0
      try { age = now() - statSync(lock).mtimeMs } catch { continue }
      const dead = holder ? !pidAlive(holder.pid) : age > 5_000
      if (dead || age > staleMs) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (now() > deadline) throw new Error(`lock busy: ${lock}`)
      await sleep(50 + Math.random() * 100)
    }
  }
  try {
    return await fn()
  } finally {
    try { unlinkSync(owner) } catch { /* already gone */ }
    try { rmdirSync(lock) } catch { /* already gone */ }
  }
}
