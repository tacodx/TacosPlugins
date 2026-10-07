import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { emptyDay } from '../indexer/agg.mjs'
import {
  acquireLock,
  emptyStore,
  foldFile,
  mergedDays,
  quarantine,
  readStore,
  saveStore,
  upsertFile,
} from '../indexer/store.mjs'
import { tempDir } from './helpers.mjs'

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

  writeFileSync(path, JSON.stringify({ ...emptyStore(), version: 2 }))
  assert.equal(readStore(dir).lost, 'wrong-version')

  quarantine(dir, 1234)
  assert.deepEqual(readdirSync(dir), ['store.corrupt-1234.json'])
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

test('a lock older than two minutes is abandoned and taken over; a younger one is not', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.lock')
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000)

  writeFileSync(path, 'someone else')
  utimesSync(path, minutesAgo(1), minutesAgo(1))
  assert.equal(acquireLock(dir), null)

  utimesSync(path, minutesAgo(3), minutesAgo(3))
  const release = acquireLock(dir)
  assert.equal(typeof release, 'function')
  release()
})
