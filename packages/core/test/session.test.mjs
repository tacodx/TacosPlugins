import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBudgetArgs, gcSessions } from '../session.mjs'

test('a bare number sets the five_hour ceiling', () => {
  assert.deepEqual(parseBudgetArgs(['80']), { gauge: 'five_hour', hard: 80 })
})

test('a named gauge is honoured', () => {
  assert.deepEqual(parseBudgetArgs(['weekly', '70']), { gauge: 'seven_day', hard: 70 })
  assert.deepEqual(parseBudgetArgs(['money', '60']), { gauge: 'extra_usage', hard: 60 })
})

test('off sets mode off', () => {
  assert.deepEqual(parseBudgetArgs(['off']), { mode: 'off' })
})

test('an out-of-range or unparseable value is rejected, not clamped', () => {
  assert.ok(parseBudgetArgs(['150']).error)
  assert.ok(parseBudgetArgs(['-3']).error)
  assert.ok(parseBudgetArgs(['banana']).error)
  assert.ok(parseBudgetArgs(['weekly']).error)
})

test('gc removes only entries older than the max age', () => {
  const removed = gcSessions('/d', {
    now: 1_000_000_000, maxAgeMs: 100,
    readdir: () => ['old.json', 'new.json'],
    stat: (p) => ({ mtimeMs: p.includes('old') ? 0 : 999_999_999 }),
    remove: () => {},
  })
  assert.deepEqual(removed, ['old.json'])
})
