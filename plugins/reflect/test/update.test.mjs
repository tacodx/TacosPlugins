import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { emptyStore, mergedDays } from '../indexer/store.mjs'
import { listTranscripts, updateStore } from '../indexer/update.mjs'
import { HOME, prompt, reply, tempDir, toolUse, utc } from './helpers.mjs'

const OPTIONS = { home: HOME, clock: utc }
const PROJECT = '-home-u-Projects-demo'
const MAIN = `${PROJECT}/s1.jsonl`
const SUB = `${PROJECT}/s1/subagents/agent-a1.jsonl`
const DAY = '2026-03-01'
const at = (time) => `${DAY}T${time}.000Z`

function write(root, rel, lines) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
}

/** One main session with a prompt and a reply, and one subagent file under it. */
function seed(root) {
  write(root, MAIN, [
    prompt({ session: 's1', at: at('10:00:00') }),
    reply({ id: 'm1', session: 's1', at: at('10:00:05'), out: 40, blocks: [toolUse('t1', 'Bash')] }),
  ])
  write(root, SUB, [reply({ id: 'm2', session: 's1', at: at('10:00:10'), out: 7 })])
}

test('the first run scans every transcript; a second run with nothing changed scans none', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 2, kept: 0, folded: 0, vanished: 0 })
  const day = mergedDays(store)[DAY]
  assert.equal(day.prompts, 1)
  assert.equal(day.out, 47)
  assert.equal(day.msgs, 1) // the main file's reply
  assert.equal(day.subMsgs, 1) // the subagent file's, kept although its session id is the parent's
  assert.equal(day.sessions, 1)

  const saved = JSON.stringify(store)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 2, folded: 0, vanished: 0 })
  assert.equal(JSON.stringify(store), saved)
})

test('a file that grew is rescanned, and its numbers replace the old ones', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)

  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 1, kept: 1, folded: 0, vanished: 0 })
  assert.equal(mergedDays(store)[DAY].out, 147)
  assert.equal(store.sessions.length, 1)
  assert.equal(store.sessions[0].out, 140)
})

// Both halves are needed: a rewrite can keep the length, and a restore can keep the time.
test('a change of size alone, or of modification time alone, is a change', async (t) => {
  const root = tempDir(t)
  const path = join(root, MAIN)
  const stamp = (seconds) => new Date(seconds * 1000)
  const lines = (out) => [
    prompt({ session: 's1', at: at('10:00:00') }),
    reply({ id: 'm1', session: 's1', at: at('10:00:05'), out }),
  ]
  const extra = reply({ id: 'm2', session: 's1', at: at('10:00:09'), out: 5 })
  write(root, MAIN, lines(40))
  utimesSync(path, stamp(1_700_000_000), stamp(1_700_000_000))
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)

  write(root, MAIN, [...lines(40), extra])
  utimesSync(path, stamp(1_700_000_000), stamp(1_700_000_000)) // longer, same time
  await updateStore(store, root, OPTIONS)
  assert.equal(mergedDays(store)[DAY].out, 45)

  write(root, MAIN, [...lines(41), extra])
  utimesSync(path, stamp(1_700_000_100), stamp(1_700_000_100)) // same length, later time
  await updateStore(store, root, OPTIONS)
  assert.equal(mergedDays(store)[DAY].out, 46)
})

test('a deleted transcript is folded once and its numbers stay for good', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)
  const rows = structuredClone(store.sessions)

  rmSync(join(root, MAIN))

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 1, folded: 1, vanished: 0 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 1, folded: 0, vanished: 0 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(store.sessions, rows)
})

test('updating in two steps gives the same history as one full scan', async (t) => {
  const root = tempDir(t)
  const stepwise = emptyStore()
  seed(root)
  await updateStore(stepwise, root, OPTIONS)
  write(root, `${PROJECT}/s2.jsonl`, [
    prompt({ session: 's2', at: '2026-03-02T08:00:00.000Z' }),
    reply({ id: 'm9', session: 's2', at: '2026-03-02T08:00:03.000Z', out: 11 }),
  ])
  await updateStore(stepwise, root, OPTIONS)

  const full = emptyStore()
  await updateStore(full, root, OPTIONS)

  assert.deepEqual(mergedDays(stepwise), mergedDays(full))
  assert.deepEqual(stepwise.sessions, full.sessions)
})

test('a store built from one folder refuses another, and folds nothing', async (t) => {
  const first = tempDir(t)
  const other = tempDir(t)
  seed(first)
  const store = emptyStore()
  await updateStore(store, first, OPTIONS)
  const saved = JSON.stringify(store)

  await assert.rejects(updateStore(store, other, OPTIONS), /was built from/)

  assert.equal(JSON.stringify(store), saved)
})

test('a missing transcripts folder is an empty history for a new store, and an error for one that knows files', async (t) => {
  const root = join(tempDir(t), 'projects')
  const fresh = emptyStore()
  assert.deepEqual(await updateStore(fresh, root, OPTIONS), { scanned: 0, kept: 0, folded: 0, vanished: 0 })
  assert.deepEqual(mergedDays(fresh), {})

  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const saved = JSON.stringify(store)
  rmSync(root, { recursive: true })

  await assert.rejects(updateStore(store, root, OPTIONS), /is missing/)
  assert.equal(JSON.stringify(store), saved)
})

test('a file that vanishes while being read is gone: an earlier record of it is folded', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)
  appendFileSync(join(root, MAIN), '\n') // changed, so it is due for a rescan

  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const result = await updateStore(store, root, { ...OPTIONS, scan: async () => { throw gone } })

  assert.deepEqual(result, { scanned: 0, kept: 1, folded: 1, vanished: 1 })
  assert.deepEqual(mergedDays(store), before)
})

test('any other failure while reading a file stops the update', async (t) => {
  const root = tempDir(t)
  seed(root)

  await assert.rejects(
    updateStore(emptyStore(), root, { ...OPTIONS, scan: async () => { throw new Error('disk on fire') } }),
    /disk on fire/,
  )
})

test('listTranscripts finds .jsonl files at any depth, by forward-slash path, sorted, and nothing else', (t) => {
  const root = tempDir(t)
  seed(root)
  write(root, `${PROJECT}/memory/MEMORY.md`, ['notes'])
  write(root, `${PROJECT}/s1/tool-results/out.json`, ['{}'])

  assert.deepEqual(listTranscripts(root).map((file) => file.rel), [MAIN, SUB])
  assert.equal(listTranscripts(join(root, 'nowhere')), null)
})
