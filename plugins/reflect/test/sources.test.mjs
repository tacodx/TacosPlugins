import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { readHistory } from '../indexer/history.mjs'
import { readWork, WORK_SQL } from '../indexer/mem.mjs'
import { tempDir, utc } from './helpers.mjs'

const ms = (iso) => Date.parse(iso)
const quarter = (iso) => Math.floor(ms(iso) / 900_000)
const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}

test('history counts prompts per local day and hour and skips what it cannot read', () => {
  const text = [
    JSON.stringify({ timestamp: ms('2026-03-01T09:15:00Z'), project: '/x', sessionId: 'a', display: 'one' }),
    JSON.stringify({ timestamp: ms('2026-03-01T09:45:00Z'), project: '/x', sessionId: 'a', display: 'two' }),
    JSON.stringify({ timestamp: ms('2026-03-02T23:10:00Z'), project: '/x', sessionId: 'b', display: 'three' }),
    'not json',
    JSON.stringify({ timestamp: 'soon' }),
    JSON.stringify({ timestamp: 1e20 }), // cannot be formatted as a date at all
    JSON.stringify({ timestamp: 0 }), // would stretch "all time" back to 1970
    JSON.stringify({ timestamp: Math.floor(ms('2026-03-01T09:15:00Z') / 1000) }), // seconds, not milliseconds
    'null',
    '',
  ].join('\n')

  assert.deepEqual(readHistory(text, utc), {
    '2026-03-01': { prompts: 2, hours: hoursAt(9, 2) },
    '2026-03-02': { prompts: 1, hours: hoursAt(23, 1) },
  })
})

test('an empty history file is no days', () => {
  assert.deepEqual(readHistory('', utc), {})
})

test('work rows are bucketed by local day and merged across the quarter hours of a day', () => {
  const calls = []
  const run = (argv) => {
    calls.push(argv)
    return JSON.stringify([
      { q: quarter('2026-03-01T09:00:00Z'), project: 'demo', type: 'feature', n: 2 },
      { q: quarter('2026-03-01T09:15:00Z'), project: 'demo', type: 'feature', n: 3 },
      { q: quarter('2026-03-02T00:00:00Z'), project: 'demo', type: 'bugfix', n: 1 },
      { q: 'not a number', project: 'demo', type: 'bugfix', n: 1 },
      { q: 0, project: 'demo', type: 'bugfix', n: 1 },
      { q: 1e18, project: 'demo', type: 'bugfix', n: 1 },
    ])
  }

  const rows = readWork('/nowhere/mem.db', utc, run)

  assert.deepEqual(rows, [
    { day: '2026-03-01', project: 'demo', type: 'feature', n: 5 },
    { day: '2026-03-02', project: 'demo', type: 'bugfix', n: 1 },
  ])
  assert.deepEqual(calls, [['sqlite3', '-readonly', '-json', '/nowhere/mem.db', WORK_SQL]])
})

test('no sqlite3, a failing query, or output that is not rows all mean no work mix', () => {
  const failing = () => {
    throw new Error('spawn sqlite3 ENOENT')
  }

  assert.equal(readWork('/nowhere/mem.db', utc, failing), null)
  assert.equal(readWork('/nowhere/mem.db', utc, () => 'Error: no such table: observations'), null)
  assert.equal(readWork('/nowhere/mem.db', utc, () => '{"not":"rows"}'), null)
})

test('a database with no observations is an empty work mix, not a missing one', () => {
  assert.deepEqual(readWork('/nowhere/mem.db', utc, () => ''), [])
})

const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0

// The only test that runs the real tool: it is what proves WORK_SQL and the -json flag.
test('the real sqlite3 tool answers the query as the code expects', { skip: !hasSqlite && 'sqlite3 is not installed' }, (t) => {
  const db = join(tempDir(t), 'mem.db')
  const at = ms('2026-03-01T09:00:00Z')
  execFileSync('sqlite3', [
    db,
    `create table observations (project text, type text, created_at_epoch integer);
     insert into observations values
       ('demo', 'feature', ${at}), ('demo', 'feature', ${at + 60_000}), ('demo', 'bugfix', ${at + 86_400_000});`,
  ])

  assert.deepEqual(readWork(db, utc), [
    { day: '2026-03-01', project: 'demo', type: 'feature', n: 2 },
    { day: '2026-03-02', project: 'demo', type: 'bugfix', n: 1 },
  ])
  assert.equal(readWork(join(tempDir(t), 'missing.db'), utc), null)
})
