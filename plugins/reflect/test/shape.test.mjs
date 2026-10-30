import { test } from 'node:test'
import assert from 'node:assert/strict'

import { busiestHour, calendarOf, columnsOf, isComparable, lateShare, withOther } from '../hooks/shape.mjs'

/** `n` consecutive days from `first`, each with out = its index + 1 and prompts = 1. */
function run(first, n) {
  const start = Date.parse(`${first}T12:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    out: i + 1,
    prompts: 1,
  }))
}
const outOf = (each) => ({ out: each.out })
const sum = (columns) => columns.reduce((total, each) => total + each.values.out, 0)

test('up to 92 days are one column each', () => {
  const columns = columnsOf(run('2026-03-01', 92), outOf)

  assert.equal(columns.length, 92)
  assert.deepEqual(columns[0], { label: '1 Mar', title: '1 Mar', values: { out: 1 } })
})

test('more days than that are grouped into weeks from Monday, and nothing is lost', () => {
  const days = run('2026-03-04', 100) // a Wednesday
  const columns = columnsOf(days, outOf)

  assert.equal(columns.length, 15)
  assert.deepEqual(columns[0], { label: '2 Mar', title: 'Week of 2 Mar', values: { out: 1 + 2 + 3 + 4 + 5 } })
  assert.equal(sum(columns), (100 * 101) / 2)
})

test('several years are grouped into months', () => {
  const columns = columnsOf(run('2024-01-01', 800), outOf)

  assert.equal(columns.length, 27)
  assert.equal(columns[0].label, 'Jan 2024')
  assert.equal(columns[0].values.out, (31 * 32) / 2)
  assert.equal(sum(columns), (800 * 801) / 2)
})

test('a ranked list keeps its first few and sums the rest into Other', () => {
  const list = [{ name: 'a', n: 5 }, { name: 'b', n: 3 }, { name: 'c', n: 2 }, { name: 'd', n: 1 }]

  assert.deepEqual(withOther(list, 2, (each) => each.n), [
    { name: 'a', value: 5 },
    { name: 'b', value: 3 },
    { name: 'Other', value: 3 },
  ])
  assert.deepEqual(withOther(list.slice(0, 2), 2, (each) => each.n), [
    { name: 'a', value: 5 },
    { name: 'b', value: 3 },
  ])
})

test('a calendar is weeks of seven cells from Monday, empty before the first day', () => {
  const { weeks, months } = calendarOf(run('2026-03-04', 10)) // Wednesday 4 March to Friday 13 March

  assert.equal(weeks.length, 2)
  assert.deepEqual(weeks[0].map((each) => each?.day ?? null), [null, null, '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'])
  assert.deepEqual(weeks[1].map((each) => each?.day ?? null), ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', null, null])
  assert.deepEqual(weeks[0][2], { day: '2026-03-04', value: 1 })
  assert.deepEqual(months, [{ column: 0, label: 'Mar' }])
})

test('a calendar shows at most the last year, and labels each month once', () => {
  const { weeks, months } = calendarOf(run('2024-01-01', 800))

  assert.ok(weeks.length <= 54)
  assert.equal(weeks.flat().filter((each) => each !== null).length, 53 * 7)
  assert.equal(weeks.at(-1).findLast((each) => each !== null).day, '2026-03-10')
  assert.equal(new Set(months.map((each) => each.column)).size, months.length)
  assert.ok(months.length >= 12)
})

test('the busiest hour and the share of late prompts are read off the weekday grid', () => {
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
  assert.equal(busiestHour(hours), null)
  assert.equal(lateShare(hours), null)

  hours[0][16] = 6 // Monday afternoon
  hours[4][23] = 3 // Friday, late
  hours[5][2] = 1 // Saturday, small hours
  assert.deepEqual(busiestHour(hours), { weekday: 0, hour: 16, n: 6 })
  assert.equal(lateShare(hours), 0.4)
})

// Before the transcripts begin only some prompts are known. Comparing with that
// reads as "up 1,300%", which is a statement about deleted files.
test('the window before is comparable only when transcripts cover all of it', () => {
  const view = (transcriptsFrom, previous = { prompts: 1, sessions: 1, out: 1, activeMs: 1 }) => ({
    range: { id: '30d', from: '2026-02-09', to: '2026-03-10', days: 30 },
    coverage: { transcriptsFrom, historyFrom: null, workFrom: null },
    previous,
  })

  assert.equal(isComparable(view('2026-01-10')), true) // the window before starts exactly there
  assert.equal(isComparable(view('2026-01-11')), false)
  assert.equal(isComparable(view('2025-06-01')), true)
  assert.equal(isComparable(view(null)), false)
  assert.equal(isComparable(view('2025-06-01', null)), false)
})
