import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { emptyStore, mergedDays } from '../indexer/store.mjs'
import { createClock } from '../indexer/clock.mjs'
import { identityOf, listTranscripts, scanFile, updateStore } from '../indexer/update.mjs'
import { HOME, prompt, reply, tempDir, toolUse, utc } from './helpers.mjs'

const OPTIONS = { home: HOME, clock: utc, zone: 'UTC' }
const NOTHING = { scanned: 0, kept: 0, folded: 0, vanished: 0, duplicates: 0 }
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

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, scanned: 2 })
  const day = mergedDays(store)[DAY]
  assert.equal(day.prompts, 1)
  assert.equal(day.out, 47)
  assert.equal(day.msgs, 1) // the main file's reply
  assert.equal(day.subMsgs, 1) // the subagent file's, kept although its session id is the parent's
  assert.equal(day.sessions, 1)

  const saved = JSON.stringify(store)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 2 })
  assert.equal(JSON.stringify(store), saved)
})

test('a file that grew is rescanned, and its numbers replace the old ones', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)

  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, scanned: 1, kept: 1 })
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

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 1, folded: 1 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 1 })
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
  assert.deepEqual(await updateStore(fresh, root, OPTIONS), NOTHING)
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

  assert.deepEqual(result, { ...NOTHING, kept: 1, folded: 1, vanished: 1 })
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

// A project folder is named after a working directory. Renaming the project and
// moving its transcripts along must not look like one history deleted and another new.
test('a project folder that is renamed keeps its history: nothing is folded or counted again', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)

  renameSync(join(root, PROJECT), join(root, '-home-u-Projects-renamed'))

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 2 })
  assert.deepEqual(mergedDays(store), before)
  assert.equal(store.sessions.length, 1)
})

test('a copy of a project folder is counted once', async (t) => {
  const root = tempDir(t)
  seed(root)
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-copy'), { recursive: true })
  const store = emptyStore()

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, scanned: 2, duplicates: 2 })
  assert.equal(mergedDays(store)[DAY].out, 47)
  assert.equal(mergedDays(store)[DAY].sessions, 1)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 2, duplicates: 2 })
})

// Transcripts only ever grow, so of two files that claim to be the same transcript the
// larger holds everything the smaller does. A stale copy must not hide the live file.
test('of two copies of a transcript, the larger is the one that counts', async (t) => {
  const root = tempDir(t)
  seed(root)
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-archive'), { recursive: true }) // sorts before the original
  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)
  const store = emptyStore()

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, scanned: 2, duplicates: 2 })
  assert.equal(mergedDays(store)[DAY].out, 147)
})

// The mirror of the case above: here the stale copy sorts last. Together the two pin
// "the largest", not "the first" and not "the last".
test('the larger copy counts wherever it sorts', async (t) => {
  const root = tempDir(t)
  seed(root)
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-zcopy'), { recursive: true }) // sorts after the original
  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)
  const store = emptyStore()

  await updateStore(store, root, OPTIONS)

  assert.equal(mergedDays(store)[DAY].out, 147)
})

test('one transcript in three folders is one copied transcript, not two', async (t) => {
  const root = tempDir(t)
  write(root, MAIN, [reply({ id: 'm1', session: 's1', at: at('10:00:00'), out: 40 })])
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-b'), { recursive: true })
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-c'), { recursive: true })

  assert.deepEqual(await updateStore(emptyStore(), root, OPTIONS), { ...NOTHING, scanned: 1, duplicates: 1 })
})

// Transcripts only grow, so a file smaller than the one already summarised is not that
// file but a stale copy that outlived it. Its summary must not replace the fuller one.
test('when the larger copy is deleted, the stale one left behind does not shrink the history', async (t) => {
  const root = tempDir(t)
  seed(root)
  const archive = join(root, '-home-u-Projects-archive')
  cpSync(join(root, PROJECT), archive, { recursive: true })
  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const full = mergedDays(store)
  assert.equal(full[DAY].out, 147)

  rmSync(join(root, PROJECT), { recursive: true }) // the grown original goes, the stale copy stays
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 2 })
  assert.deepEqual(mergedDays(store), full)

  rmSync(archive, { recursive: true }) // now nothing is left on disk: what was known is folded, once
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, folded: 2 })
  assert.deepEqual(mergedDays(store), full)
})

// The copy to read is chosen from the listing. If it is deleted before it is read while
// another copy is still there, the transcript is not gone and must not be folded: the
// next run would read the other copy as new and count it a second time, for good.
test('a chosen copy that vanishes mid-run is not folded while another copy is listed', async (t) => {
  const root = tempDir(t)
  seed(root)
  cpSync(join(root, PROJECT), join(root, '-home-u-Projects-archive'), { recursive: true })
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)

  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const failing = async (path, options) => {
    if (path === join(root, MAIN)) throw gone
    return scanFile(path, options)
  }
  assert.deepEqual(await updateStore(store, root, { ...OPTIONS, scan: failing }), { ...NOTHING, kept: 2, vanished: 1, duplicates: 2 })

  await updateStore(store, root, OPTIONS)
  assert.equal(mergedDays(store)[DAY].out, 147)
  assert.equal(mergedDays(store)[DAY].sessions, 1)
})

test('a transcript is known by its path below the project folder', () => {
  assert.equal(identityOf('-home-u-Projects-demo/s1.jsonl'), 's1.jsonl')
  assert.equal(identityOf('-home-u-Projects-demo/s1/subagents/agent-a1.jsonl'), 's1/subagents/agent-a1.jsonl')
  assert.equal(identityOf('loose.jsonl'), 'loose.jsonl')
})

// Days and hours are local. Summaries made in one zone are wrong in another,
// and an unchanged file would otherwise never be looked at again.
test('a change of time zone remakes every summary in the new zone', async (t) => {
  const root = tempDir(t)
  write(root, MAIN, [prompt({ session: 's1', at: '2026-03-01T23:30:00.000Z' })])
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  assert.deepEqual(Object.keys(mergedDays(store)), ['2026-03-01'])

  const berlin = { home: HOME, clock: createClock('Europe/Berlin'), zone: 'Europe/Berlin' }
  assert.deepEqual(await updateStore(store, root, berlin), { ...NOTHING, scanned: 1 })
  assert.deepEqual(Object.keys(mergedDays(store)), ['2026-03-02'])
  assert.deepEqual(await updateStore(store, root, berlin), { ...NOTHING, kept: 1 })
})

test('summaries made by another version of the scanner are all remade', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)

  store.scan.version -= 1

  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, scanned: 2 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { ...NOTHING, kept: 2 })
})

// updateStore treats ENOENT from the scan as "the file was deleted meanwhile".
// This pins that the real reader fails that way, on every Node the suite runs on.
test('reading a transcript that is not there fails with ENOENT', async (t) => {
  await assert.rejects(scanFile(join(tempDir(t), 'gone.jsonl'), { kind: 'main', fileId: 'gone', ...OPTIONS }), { code: 'ENOENT' })
})

test('listTranscripts finds .jsonl files at any depth, by forward-slash path, sorted, and nothing else', (t) => {
  const root = tempDir(t)
  seed(root)
  write(root, `${PROJECT}/memory/MEMORY.md`, ['notes'])
  write(root, `${PROJECT}/s1/tool-results/out.json`, ['{}'])

  assert.deepEqual(listTranscripts(root).map((file) => file.rel), [MAIN, SUB])
  assert.equal(listTranscripts(join(root, 'nowhere')), null)
})
