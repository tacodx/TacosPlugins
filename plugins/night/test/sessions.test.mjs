import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  classify, findTranscript, limitOf, procStartOf, projectSlug, readRegistry, tailJsonl, transcriptState,
} from '../engine/sessions.mjs'
import { tempDir } from './helpers.mjs'

const NOW = Date.parse('2026-03-11T02:00:00Z')
const ts = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString()

const assistant = (minutesAgo, stop, extra = {}) => ({
  type: 'assistant', timestamp: ts(minutesAgo), message: { role: 'assistant', stop_reason: stop }, ...extra,
})
const userText = (minutesAgo) => ({ type: 'user', timestamp: ts(minutesAgo), message: { role: 'user', content: 'go on' } })
const toolResult = (minutesAgo) => ({
  type: 'user', timestamp: ts(minutesAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] },
})
const stopSummary = (minutesAgo) => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: ts(minutesAgo) })
const limitRecord = (minutesAgo, resetsAtSec) => assistant(minutesAgo, 'stop_sequence', {
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' } },
})

test('the transcript folder replaces every character but letters and digits', () => {
  assert.equal(projectSlug('/home/u/Projects/Tacos/.claude/worktrees/a-b'), '-home-u-Projects-Tacos--claude-worktrees-a-b')
})

test('a process start time is field 22 of /proc stat, even with spaces in the name', () => {
  const stat = '4242 (my (odd) name) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10'
  assert.equal(procStartOf(4242, () => stat), '987654')
  assert.equal(procStartOf(4242, () => { throw new Error('gone') }), null)
})

test('the registry marks a session dead when its pid now runs another process', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: 'a', procStart: '5', status: 'busy', cwd: '/w' }))
  writeFileSync(join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'b', procStart: '7', status: 'idle', cwd: '/w' }))
  writeFileSync(join(dir, '300.json'), '{ broken')
  writeFileSync(join(dir, 'notes.txt'), 'ignored')
  const starts = { 100: '5', 200: '99' }
  const sessions = readRegistry(dir, { procStart: (pid) => starts[pid] ?? null })
  assert.deepEqual(sessions.map((s) => [s.sessionId, s.alive]), [['a', true], ['b', false]])
})

test('a turn that finished reads as ended', () => {
  assert.equal(transcriptState([userText(5), assistant(4, 'end_turn'), stopSummary(4)]).state, 'ended')
})

test('a usage limit is read with its reset time', () => {
  const resetsAt = NOW / 1000 + 3600
  const state = transcriptState([userText(5), limitRecord(4, resetsAt)])
  assert.equal(state.state, 'limit')
  assert.equal(state.resetsAt, resetsAt * 1000)
  assert.equal(state.limitType, 'five_hour')
})

test('a tool call with no result yet reads as tool', () => {
  assert.equal(transcriptState([userText(5), assistant(4, 'tool_use')]).state, 'tool')
})

test('only the last part of the transcript counts: a limit before a new prompt is over', () => {
  const state = transcriptState([limitRecord(30, NOW / 1000 - 600), userText(5), assistant(4, 'tool_use'), toolResult(3)])
  assert.equal(state.state, 'working')
})

test('limitOf ignores ordinary replies', () => {
  assert.equal(limitOf(assistant(1, 'end_turn')), null)
})

const entry = (over = {}) => ({ alive: true, status: 'busy', waitingFor: null, ...over })

test('a session waiting on a dialog says what it waits on', () => {
  assert.deepEqual(classify(entry({ status: 'waiting', waitingFor: 'permission prompt' }), null, { now: NOW }), {
    label: 'waiting', on: 'permission prompt',
  })
})

test('a busy session whose turn ended is idle, as when only a background task runs', () => {
  const label = classify(entry(), { state: 'ended', lastAt: NOW - 60_000 }, { now: NOW }).label
  assert.equal(label, 'idle')
})

test('a session stopped by a limit that has not reset is limited; long after the reset it is idle', () => {
  const soon = classify(entry({ status: 'idle' }), { state: 'limit', lastAt: NOW, resetsAt: NOW + 3600_000 }, { now: NOW })
  assert.equal(soon.label, 'limited')
  const later = classify(entry({ status: 'idle' }), { state: 'limit', lastAt: NOW, resetsAt: NOW - 3600_000 }, { now: NOW })
  assert.equal(later.label, 'idle')
})

test('a busy session silent for long with nothing running is hung; with a child running it is working', () => {
  const silent = { state: 'tool', lastAt: NOW - 30 * 60_000 }
  assert.equal(classify(entry(), silent, { now: NOW }).label, 'hung')
  assert.equal(classify(entry(), silent, { now: NOW, hasChildren: true }).label, 'working')
})

test('a dead process is dead whatever its file says', () => {
  assert.equal(classify(entry({ alive: false }), { state: 'working', lastAt: NOW }, { now: NOW }).label, 'dead')
})

test('a transcript is found under its working directory and read from the end', (t) => {
  const dir = tempDir(t)
  const folder = join(dir, projectSlug('/home/u/w'))
  mkdirSync(folder)
  const path = join(folder, 's1.jsonl')
  const lines = []
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify(userText(100 - i / 100)))
  lines.push(JSON.stringify(assistant(1, 'end_turn')))
  writeFileSync(path, `${lines.join('\n')}\n`)
  const found = findTranscript(dir, '/home/u/w', 's1')
  assert.equal(found.path, path)
  const tail = tailJsonl(path, 4096)
  assert.ok(tail.length < 2001)
  assert.equal(tail.at(-1).message.stop_reason, 'end_turn')
  assert.equal(findTranscript(dir, '/home/u/w', 'nope'), null)
})
