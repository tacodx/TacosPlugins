import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addDays, createClock, isPlausible, weekdayOf } from '../indexer/clock.mjs'

const ms = (iso) => Date.parse(iso)

test('a clock gives the local day and hour of an instant in its zone', () => {
  const utc = createClock('UTC')
  const berlin = createClock('Europe/Berlin')

  assert.deepEqual(utc(ms('2026-03-01T23:30:00Z')), { day: '2026-03-01', hour: 23 })
  assert.deepEqual(berlin(ms('2026-03-01T23:30:00Z')), { day: '2026-03-02', hour: 0 })
})

test('a clock follows a daylight-saving switch', () => {
  const berlin = createClock('Europe/Berlin')

  // 29 March 2026: 02:00 CET becomes 03:00 CEST.
  assert.deepEqual(berlin(ms('2026-03-29T00:30:00Z')), { day: '2026-03-29', hour: 1 })
  assert.deepEqual(berlin(ms('2026-03-29T01:30:00Z')), { day: '2026-03-29', hour: 3 })
})

// Results are cached. India is UTC+5:30, so its midnight falls inside one UTC hour:
// a cache keyed by the hour would hand the second call the first call's answer.
test('the cache does not blur a zone whose offset is not a whole hour', () => {
  const kolkata = createClock('Asia/Kolkata')

  assert.deepEqual(kolkata(ms('2026-01-01T18:29:00Z')), { day: '2026-01-01', hour: 23 })
  assert.deepEqual(kolkata(ms('2026-01-01T18:31:00Z')), { day: '2026-01-02', hour: 0 })
})

// Nepal is UTC+5:45, so its midnight falls at a quarter past: a cache keyed by
// the half hour would get this wrong where the Kolkata case cannot tell.
test('the cache does not blur a zone whose offset ends on a quarter hour', () => {
  const kathmandu = createClock('Asia/Kathmandu')

  assert.deepEqual(kathmandu(ms('2026-01-01T18:14:00Z')), { day: '2026-01-01', hour: 23 })
  assert.deepEqual(kathmandu(ms('2026-01-01T18:16:00Z')), { day: '2026-01-02', hour: 0 })
})

test('an instant is plausible only as a finite time between 2020 and 2100', () => {
  assert.equal(isPlausible(ms('2026-03-01T00:00:00Z')), true)
  assert.equal(isPlausible(ms('2020-01-01T00:00:00Z')), true)
  assert.equal(isPlausible(ms('2019-12-31T23:59:59Z')), false)
  assert.equal(isPlausible(0), false)
  assert.equal(isPlausible(ms('2100-01-01T00:00:00Z')), false)
  assert.equal(isPlausible(1e20), false)
  assert.equal(isPlausible(Number.NaN), false)
  assert.equal(isPlausible('1770000000000'), false)
})

test('addDays moves across month, year and leap-day boundaries in both directions', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2026-03-10', -6), '2026-03-04')
  assert.equal(addDays('2026-03-10', 0), '2026-03-10')
})

test('weekdayOf counts from Monday', () => {
  assert.equal(weekdayOf('2026-03-09'), 0) // a Monday
  assert.equal(weekdayOf('2026-03-10'), 1)
  assert.equal(weekdayOf('2026-03-08'), 6) // a Sunday
})
