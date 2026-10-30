import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { emptyDay } from '../indexer/agg.mjs'
import {
  acquireLock,
  emptyStore,
  foldFile,
  mergedDays,
  readStore,
  saveStore,
  STORE_VERSION,
  upsertFile,
} from '../indexer/store.mjs'
import { tempDir } from './helpers.mjs'

const STORE_MODULE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'indexer', 'store.mjs')).href
const STAT = { size: 10, mtimeMs: 1000 }
const SESSION = { start: 100, end: 900, activeMs: 300, prompts: 2, out: 10 }
const DAY = '2026-03-01'
const MAIN = 'p/main.jsonl'
const SUB = 'p/main/subagents/agent-a.jsonl'

const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}
const usage = (msgs, out) => ({ msgs, out, inp: 0, cacheR: 0, cacheW: 0 })

function summary(kind, id, project, perDay, session) {
  const days = {}
  for (const [day, fields] of Object.entries(perDay)) days[day] = { ...emptyDay(), ...fields }
  const made = { kind, sessionId: id, project, days, bad: 0 }
  if (session !== undefined) made.session = session
  return made
}

/** A main file and a subagent file, both in project `demo`, both on the same day. */
function twoFiles() {
  const store = emptyStore()
  upsertFile(
    store,
    MAIN,
    STAT,
    summary(
      'main',
      'main',
      'demo',
      { [DAY]: { prompts: 2, hours: hoursAt(9, 2), msgs: 1, out: 10, tools: { Bash: 2 }, models: { opus: usage(1, 10) } } },
      SESSION,
    ),
  )
  upsertFile(
    store,
    SUB,
    STAT,
    summary('sub', 'agent-a', 'demo', {
      [DAY]: { subMsgs: 3, out: 5, tools: { Bash: 1, Read: 1 }, models: { opus: usage(3, 5) } },
    }),
  )
  return store
}

test('files on the same day add up, and only a main file counts as a session', () => {
  const day = mergedDays(twoFiles())[DAY]

  assert.equal(day.prompts, 2)
  assert.equal(day.out, 15)
  assert.equal(day.msgs, 1)
  assert.equal(day.subMsgs, 3)
  assert.equal(day.sessions, 1)
  assert.equal(day.hours[9], 2)
  assert.deepEqual(day.tools, { Bash: 3, Read: 1 })
  assert.deepEqual(day.models, { opus: usage(4, 15) })
  assert.deepEqual(day.projects, { demo: { prompts: 2, out: 15, sessions: 1 } })
})

test('folding a file moves its numbers into the frozen total exactly once', () => {
  const store = twoFiles()
  const before = mergedDays(store)

  foldFile(store, MAIN)
  assert.equal(store.files[MAIN], undefined)
  assert.deepEqual(mergedDays(store), before)

  foldFile(store, MAIN) // already folded: there is nothing left to add
  assert.deepEqual(mergedDays(store), before)
})

test('reading the merged days does not change the frozen total', () => {
  const store = twoFiles()
  foldFile(store, MAIN)
  const frozen = structuredClone(store.frozen)

  mergedDays(store)
  mergedDays(store)

  assert.deepEqual(store.frozen, frozen)
})

test('a main file keeps one session row, replaced on rescan and kept after a fold', () => {
  const store = twoFiles()
  assert.deepEqual(store.sessions, [{ id: 'main', project: 'demo', title: null, entrypoint: null, ...SESSION }])

  const again = summary('main', 'main', 'demo', {}, { ...SESSION, prompts: 5 })
  again.title = 'Named'
  again.entrypoint = 'cli'
  upsertFile(store, MAIN, STAT, again)
  assert.deepEqual(store.sessions, [{ id: 'main', project: 'demo', title: 'Named', entrypoint: 'cli', ...SESSION, prompts: 5 }])

  foldFile(store, MAIN)
  assert.equal(store.sessions.length, 1)
})

test('a main file whose rescan finds no records loses its row', () => {
  const store = twoFiles()

  upsertFile(store, MAIN, STAT, summary('main', 'main', 'demo', {}))

  assert.deepEqual(store.sessions, [])
})

test('a saved store reads back the same, is private, and leaves no temp file', (t) => {
  const dir = join(tempDir(t), 'nested', 'reflect')
  const store = twoFiles()

  saveStore(dir, store)

  assert.deepEqual(readStore(dir), { store, lost: null })
  assert.equal(statSync(join(dir, 'store.json')).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['store.json'])
})

test('a failed save removes its temp file', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'store.json')) // a directory where the file belongs makes the rename fail
  writeFileSync(join(dir, 'store.json', 'in-the-way'), '')

  assert.throws(() => saveStore(dir, emptyStore()))

  assert.deepEqual(readdirSync(dir), ['store.json'])
})

test('a missing store is an empty one, not a loss', (t) => {
  assert.deepEqual(readStore(tempDir(t)), { store: emptyStore(), lost: null })
})

test('an unusable store is reported and left in place until it is moved aside', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.json')

  writeFileSync(path, 'not json')
  assert.deepEqual(readStore(dir), { store: emptyStore(), lost: 'unreadable' })
  assert.equal(readFileSync(path, 'utf8'), 'not json')

  writeFileSync(path, JSON.stringify({ ...emptyStore(), version: STORE_VERSION - 1 }))
  assert.equal(readStore(dir).lost, 'wrong-version')

  // Saving over it sets it aside first, so the only copy of whatever it held is kept.
  writeFileSync(path, 'not json')
  saveStore(dir, emptyStore(), { setAside: 1234 })
  assert.deepEqual(readdirSync(dir).sort(), ['store.corrupt-1234.json', 'store.json'])
  assert.equal(readFileSync(join(dir, 'store.corrupt-1234.json'), 'utf8'), 'not json')
  assert.deepEqual(readStore(dir), { store: emptyStore(), lost: null })
})

// The new store goes in with one rename, so there is no moment without a store.json:
// the old file is copied aside, not moved. If the copy cannot be made, nothing changes.
test('setting a store aside never leaves the folder without one', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'store.json'), 'not json')
  writeFileSync(join(dir, 'store.corrupt-1234.json'), 'an earlier keepsake')

  assert.throws(() => saveStore(dir, emptyStore(), { setAside: 1234 }), { code: 'EEXIST' })

  assert.deepEqual(readdirSync(dir).sort(), ['store.corrupt-1234.json', 'store.json'])
  assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), 'not json')
  assert.equal(readFileSync(join(dir, 'store.corrupt-1234.json'), 'utf8'), 'an earlier keepsake')
})

/** Runs saveStore on a store far over the limit, in a child whose files may not grow past a few kilobytes. */
function saveUnderALimit(dir, options) {
  const script = `
    import { emptyStore, saveStore } from ${JSON.stringify(STORE_MODULE)}
    const big = emptyStore()
    big.sessions = Array.from({ length: 6000 }, (_, i) => ({ id: String(i).padStart(120, 'x') }))
    try {
      saveStore(${JSON.stringify(dir)}, big, ${JSON.stringify(options)})
      console.log('saved')
    } catch (err) {
      console.log('failed ' + err.code)
    }`
  return spawnSync('sh', ['-c', 'ulimit -f 64; exec "$0" --input-type=module -e "$1"', process.execPath, script], {
    encoding: 'utf8',
  }).stdout.trim()
}
const needsShell = process.platform === 'win32' && 'needs a POSIX shell'

// A file-size limit stands in for a full disk. A save that flushed but did not check
// how much it had written once replaced a good store with the first 32 KB of a new one,
// and said nothing.
test('a save that cannot write everything fails and leaves the good store alone', { skip: needsShell }, (t) => {
  const dir = tempDir(t)
  const good = twoFiles()
  saveStore(dir, good)

  assert.equal(saveUnderALimit(dir, {}), 'failed EFBIG')

  assert.deepEqual(readStore(dir), { store: good, lost: null })
  assert.deepEqual(readdirSync(dir), ['store.json'])
})

test('an unreadable store is set aside only once the new one is safely written', { skip: needsShell }, (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'store.json'), 'not json')

  assert.equal(saveUnderALimit(dir, { setAside: 1234 }), 'failed EFBIG')

  assert.deepEqual(readdirSync(dir), ['store.json'])
  assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), 'not json')
})

// An old copy of this code may still be running in another session after an
// upgrade. It must not take the newer store for a broken one and replace it.
test('a store saved by a newer version is reported as such, not as broken', (t) => {
  const dir = tempDir(t)
  const newer = JSON.stringify({ ...emptyStore(), version: STORE_VERSION + 1, files: 'a shape this version does not know' })
  writeFileSync(join(dir, 'store.json'), newer)

  assert.deepEqual(readStore(dir), { store: emptyStore(), lost: 'newer' })
  assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), newer)
})

test('the lock is held by one caller at a time and leaves nothing behind', (t) => {
  const dir = tempDir(t)

  const release = acquireLock(dir)
  assert.equal(typeof release, 'function')
  assert.equal(acquireLock(dir), null)

  release()
  const second = acquireLock(dir)
  assert.equal(typeof second, 'function')
  second()
  assert.deepEqual(readdirSync(dir), [])
})

test('a lock whose owner is gone is taken at once', (t) => {
  const dir = tempDir(t)
  const { pid } = spawnSync(process.execPath, ['-e', '']) // a process that has already exited
  writeFileSync(join(dir, 'store.lock'), `${pid} left-behind`)

  const release = acquireLock(dir)

  assert.equal(typeof release, 'function')
  release()
  assert.deepEqual(readdirSync(dir), [])
})

// The owner here is this test process, which is certainly alive. A run can take
// minutes on a large history, so only real age gives a live owner's lock away.
test("a live owner's lock is respected until it is older than any run", (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.lock')
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000)

  writeFileSync(path, `${process.pid} another-run`)
  utimesSync(path, minutesAgo(9), minutesAgo(9))
  assert.equal(acquireLock(dir), null)

  utimesSync(path, minutesAgo(11), minutesAgo(11))
  const release = acquireLock(dir)
  assert.equal(typeof release, 'function')
  release()
})

test('a lock file still being written is not mistaken for an abandoned one', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'store.lock'), '') // created, its owner not yet written into it

  assert.equal(acquireLock(dir), null)
})

test('releasing a lock that was taken over leaves the new owner\'s lock alone', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.lock')
  const release = acquireLock(dir)

  writeFileSync(path, `${process.pid} the-run-that-took-over`)
  release()

  assert.equal(readFileSync(path, 'utf8'), `${process.pid} the-run-that-took-over`)
})
