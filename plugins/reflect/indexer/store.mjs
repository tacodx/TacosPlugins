// The store: one summary per transcript file still on disk, a frozen total for
// files that are gone, and one row per session. A single JSON file.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addSummary } from './agg.mjs'

export const STORE_VERSION = 1

const STORE_FILE = 'store.json'
const LOCK_FILE = 'store.lock'
const STALE_LOCK_MS = 2 * 60 * 1000

export function emptyStore() {
  return { version: STORE_VERSION, root: null, files: {}, frozen: { days: {} }, sessions: [] }
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
 * @returns {{ store: object, lost: null | 'unreadable' | 'wrong-version' }} an
 *   empty store and the reason when the file is there but cannot be used
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
  if (!isStore(parsed)) return { store: emptyStore(), lost: 'wrong-version' }
  return { store: parsed, lost: null }
}

/** Moves an unusable store aside, so the next save does not overwrite the only copy of it. */
export function quarantine(dir, now) {
  renameSync(join(dir, STORE_FILE), join(dir, `store.corrupt-${now}.json`))
}

/**
 * Saves through a temp file that is always newly created (`wx`), so the mode is
 * always applied and a reader never sees half a store.
 */
export function saveStore(dir, store) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `store.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(store), { flag: 'wx', mode: 0o600 })
    renameSync(temp, join(dir, STORE_FILE))
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function isStale(path, now) {
  try {
    return now - statSync(path).mtimeMs > STALE_LOCK_MS
  } catch (err) {
    if (err.code === 'ENOENT') return true // released between our two looks at it
    throw err
  }
}

/**
 * Takes the index lock.
 * @returns {null | (() => void)} the function that releases it, or null while
 *   another process holds a lock younger than two minutes
 */
export function acquireLock(dir, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 })
      return () => rmSync(path, { force: true })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (!isStale(path, now)) return null
      rmSync(path, { force: true }) // abandoned: take it on the second pass
    }
  }
  return null
}

/** Records a scanned file, and keeps the session row of a main file in step with it. */
export function upsertFile(store, rel, { size, mtimeMs }, summary) {
  store.files[rel] = { size, mtimeMs, summary }
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
export function foldFile(store, rel) {
  if (!Object.hasOwn(store.files, rel)) return
  addSummary(store.frozen.days, store.files[rel].summary)
  delete store.files[rel]
}

/** Every day the store knows, frozen and live together. The store itself is not changed. */
export function mergedDays(store) {
  const days = structuredClone(store.frozen.days)
  for (const { summary } of Object.values(store.files)) addSummary(days, summary)
  return days
}
