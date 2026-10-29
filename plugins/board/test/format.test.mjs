import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compact, count, dayLabel, hourLabel, plural, span, weekday } from '../hooks/format.mjs'

test('figures: grouped up to 99,999, then short, never wider than six characters', () => {
  assert.equal(count(28028), '28,028')
  assert.equal(compact(0), '0')
  assert.equal(compact(99_999), '99,999')
  assert.equal(compact(128_028), '128K')
  assert.equal(compact(999_499), '999K')
  assert.equal(compact(2_400_000), '2.4M')
  assert.equal(plural(1, 'commit'), '1 commit')
  assert.equal(plural(1200, 'commit'), '1,200 commits')
})

test('days and hours as the pane writes them', () => {
  assert.equal(weekday('2026-10-29'), 'Thu')
  assert.equal(dayLabel('2026-10-29'), 'Thu 29 Oct')
  assert.equal(dayLabel('2026-03-01'), 'Sun 1 Mar')
  assert.equal(hourLabel(7), '07:00')
  assert.equal(hourLabel(18), '18:00')
})

test('spans of time, coarse', () => {
  assert.equal(span(20_000), 'under a minute')
  assert.equal(span(-5), 'under a minute')
  assert.equal(span(12 * 60_000 + 59_000), '12 min')
  assert.equal(span(60 * 60_000), '1 h')
  assert.equal(span(65 * 60_000), '1 h 5 min')
  assert.equal(span(26 * 60 * 60_000 + 7 * 60_000), '26 h')
})
