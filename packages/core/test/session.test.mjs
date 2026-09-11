import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBudgetArgs, gcSessions, writeSessionConfig } from '../session.mjs'

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

test('writeSessionConfig merges successive gauge settings instead of overwriting', () => {
  let stored = null
  const readFile = () => { if (stored === null) throw new Error('ENOENT'); return stored }
  const writeFile = (_path, data) => { stored = data }
  const mkdir = () => {}

  writeSessionConfig('/d', 's1', { gauges: { five_hour: { soft: 65, hard: 80 } } }, { readFile, writeFile, mkdir })
  writeSessionConfig('/d', 's1', { gauges: { seven_day: { soft: 55, hard: 70 } } }, { readFile, writeFile, mkdir })

  const doc = JSON.parse(stored)
  assert.deepEqual(doc.gauges.five_hour, { soft: 65, hard: 80 })
  assert.deepEqual(doc.gauges.seven_day, { soft: 55, hard: 70 })
})

test('turning the guard off preserves existing gauge ceilings', () => {
  let stored = JSON.stringify({ gauges: { five_hour: { soft: 65, hard: 80 } } })
  const readFile = () => stored
  const writeFile = (_path, data) => { stored = data }
  const mkdir = () => {}

  writeSessionConfig('/d', 's1', { mode: 'off' }, { readFile, writeFile, mkdir })

  const doc = JSON.parse(stored)
  assert.equal(doc.mode, 'off')
  assert.deepEqual(doc.gauges.five_hour, { soft: 65, hard: 80 })
})

test('re-setting a gauge overwrites only that gauge, leaving others intact', () => {
  let stored = JSON.stringify({
    gauges: { five_hour: { soft: 65, hard: 80 }, seven_day: { soft: 55, hard: 70 } },
  })
  const readFile = () => stored
  const writeFile = (_path, data) => { stored = data }
  const mkdir = () => {}

  writeSessionConfig('/d', 's1', { gauges: { five_hour: { soft: 70, hard: 85 } } }, { readFile, writeFile, mkdir })

  const doc = JSON.parse(stored)
  assert.deepEqual(doc.gauges.five_hour, { soft: 70, hard: 85 })
  assert.deepEqual(doc.gauges.seven_day, { soft: 55, hard: 70 })
})

test('an unreadable or corrupt existing session file starts fresh instead of throwing', () => {
  let stored = null
  let threw = false
  const writeFile = (_path, data) => { stored = data }
  const mkdir = () => {}

  try {
    writeSessionConfig('/d', 's1', { gauges: { five_hour: { soft: 65, hard: 80 } } },
      { readFile: () => { throw new Error('ENOENT') }, writeFile, mkdir })
  } catch { threw = true }
  assert.equal(threw, false)
  assert.deepEqual(JSON.parse(stored), { gauges: { five_hour: { soft: 65, hard: 80 } } })

  stored = null
  try {
    writeSessionConfig('/d', 's1', { gauges: { seven_day: { soft: 55, hard: 70 } } },
      { readFile: () => '{ not json', writeFile, mkdir })
  } catch { threw = true }
  assert.equal(threw, false)
  assert.deepEqual(JSON.parse(stored), { gauges: { seven_day: { soft: 55, hard: 70 } } })
})
