// The store: one summary per transcript file still on disk, a frozen total for
// files that are gone, and one row per session. A single JSON file.
import { randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addSummary } from './agg.mjs'

/** The shape of the file. Version 1 keyed files by their full path and was never released. */
export const STORE_VERSION = 2

const STORE_FILE = 'store.json'
const LOCK_FILE = 'store.lock'
// Longer than any run can take: the mod gives the command three minutes.
const STALE_LOCK_MS = 10 * 60 * 1000

export function emptyStore() {
  return { version: STORE_VERSION, root: null, scan: null, files: {}, frozen: { days: {} }, sessions: [] }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function isStore(value) {
  return (
    isObject(value) &&
    value.version === STORE_VERSION &&
    isObject(value.files) &&
    isObject(value.frozen) &&
    isObject(value.frozen.days) &&
    Array.isArray(value.sessions)
  )
}

/**
 * Reads the store and changes nothing on disk.
 * @returns {{ store: object, lost: null | 'unreadable' | 'wrong-version' | 'newer' }}
 *   an empty store and the reason when the file is there but cannot be used.
 *   `newer` is a store saved by a later version of this code: it is not ours to
 *   replace, and the caller must stop.
 */
export function readStore(dir) {
  let text
  try {
    text = readFileSync(join(dir, STORE_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { store: emptyStore(), lost: null }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { store: emptyStore(), lost: 'unreadable' }
  }
  if (isObject(parsed) && Number.isInteger(parsed.version) && parsed.version > STORE_VERSION) {
    return { store: emptyStore(), lost: 'newer' }
  }
  if (!isStore(parsed)) return { store: emptyStore(), lost: 'wrong-version' }
  return { store: parsed, lost: null }
}

/**
 * Saves through a temp file that is always newly created (`wx`), so the mode is
 * always applied and a reader never sees half a store. The data is flushed
 * before the rename: the frozen total exists nowhere else, and a rename that
 * outlives a power cut must not point at an empty file.
 *
 * @param {{ setAside?: number }} [options] `setAside`: the store being replaced
 *   is unusable; keep a copy of it as `store.corrupt-<setAside>.json`. The copy
 *   is made only once the new store is safely written, and the old file stays
 *   in place until the one rename that replaces it, so a save that fails at any
 *   point leaves it where the next run will find it and say so again.
 */
export function saveStore(dir, store, { setAside } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, STORE_FILE)
  const temp = join(dir, `store.${process.pid}.${Date.now()}.tmp`)
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      // writeFileSync writes all of it or throws. A bare write may stop short on a
      // full disk and report success, and the rename would then install a stump.
      writeFileSync(fd, JSON.stringify(store))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (setAside !== undefined) copyFileSync(path, join(dir, `store.corrupt-${setAside}.json`), constants.COPYFILE_EXCL)
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // it exists, it is just not ours to signal
  }
}

// A lock is abandoned when its owner is gone, or when it is older than any run.
function isAbandoned(path, now) {
  let text
  let age
  try {
    text = readFileSync(path, 'utf8')
    age = now - statSync(path).mtimeMs
  } catch (err) {
    if (err.code === 'ENOENT') return true // released between our two looks at it
    throw err
  }
  const pid = Number.parseInt(text, 10)
  if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return true
  return age > STALE_LOCK_MS
}

/**
 * Takes the index lock.
 * @returns {null | (() => void)} the function that releases it, or null while
 *   another live process holds it
 */
export function acquireLock(dir, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, LOCK_FILE)
  const mine = `${process.pid} ${randomUUID()}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, mine, { flag: 'wx', mode: 0o600 })
      return () => {
        // Only our own lock: if it was taken over, the one there now is someone else's.
        try {
          if (readFileSync(path, 'utf8') === mine) rmSync(path, { force: true })
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (!isAbandoned(path, now)) return null
      rmSync(path, { force: true }) // abandoned: take it on the second pass
    }
  }
  return null
}

/** Records a scanned file, and keeps the session row of a main file in step with it. */
export function upsertFile(store, key, { size, mtimeMs }, summary) {
  store.files[key] = { size, mtimeMs, summary }
  if (summary.kind !== 'main') return

  const at = store.sessions.findIndex((row) => row.id === summary.sessionId)
  if (summary.session === undefined) {
    if (at !== -1) store.sessions.splice(at, 1)
    return
  }
  const row = {
    id: summary.sessionId,
    project: summary.project,
    title: summary.title ?? null,
    entrypoint: summary.entrypoint ?? null,
    ...summary.session,
  }
  if (at === -1) store.sessions.push(row)
  else store.sessions[at] = row
}

/**
 * Moves a file's numbers into the frozen total and forgets the file. For a
 * transcript that no longer exists: its session row stays, and so does
 * everything it ever contributed.
 */
export function foldFile(store, key) {
  if (!Object.hasOwn(store.files, key)) return
  addSummary(store.frozen.days, store.files[key].summary)
  delete store.files[key]
}

/** Every day the store knows, frozen and live together. The store itself is not changed. */
export function mergedDays(store) {
  const days = structuredClone(store.frozen.days)
  for (const { summary } of Object.values(store.files)) addSummary(days, summary)
  return days
}
