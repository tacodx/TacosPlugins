import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calendarUtc, lastAt, localDate, localTime, localToInstant, nextAt, parseHHMM, planNight,
} from '../engine/clock.mjs'

const BERLIN = 'Europe/Berlin'
const iso = (ms) => new Date(ms).toISOString()

test('a time of day is HH:MM and nothing else', () => {
  assert.deepEqual(parseHHMM('23:30'), { h: 23, m: 30 })
  assert.deepEqual(parseHHMM('6:05'), { h: 6, m: 5 })
  for (const bad of ['24:00', '23:60', '2330', '', 'soon']) assert.throws(() => parseHHMM(bad))
})

test('the next 23:30 in Berlin is today when it is still evening, tomorrow after it', () => {
  // 2026-03-10 is winter time, UTC+1.
  assert.equal(iso(nextAt('23:30', Date.parse('2026-03-10T20:00:00Z'), BERLIN)), '2026-03-10T22:30:00.000Z')
  assert.equal(iso(nextAt('23:30', Date.parse('2026-03-10T23:00:00Z'), BERLIN)), '2026-03-11T22:30:00.000Z')
})

test('a night armed in the evening starts at from and ends at the next to', () => {
  const night = planNight({ from: '23:30', to: '06:30' }, Date.parse('2026-03-10T19:00:00Z'), BERLIN)
  assert.equal(iso(night.start), '2026-03-10T22:30:00.000Z')
  assert.equal(iso(night.end), '2026-03-11T05:30:00.000Z')
  assert.equal(night.date, '2026-03-10')
  assert.equal(night.inside, false)
})

test('a night armed inside its window starts now and is named after the evening it began', () => {
  const now = Date.parse('2026-03-11T01:00:00Z') // 02:00 local
  const night = planNight({ from: '23:30', to: '06:30' }, now, BERLIN)
  assert.equal(night.start, now)
  assert.equal(iso(night.end), '2026-03-11T05:30:00.000Z')
  assert.equal(night.date, '2026-03-10')
  assert.equal(night.inside, true)
})

test('a night armed after this morning\'s end waits for this evening', () => {
  const night = planNight({ from: '23:30', to: '06:30' }, Date.parse('2026-03-11T08:00:00Z'), BERLIN)
  assert.equal(iso(night.start), '2026-03-11T22:30:00.000Z')
  assert.equal(night.date, '2026-03-11')
})

test('a window inside one day works too', () => {
  const night = planNight({ from: '01:00', to: '05:00' }, Date.parse('2026-03-10T21:00:00Z'), BERLIN)
  assert.equal(iso(night.start), '2026-03-11T00:00:00.000Z')
  assert.equal(iso(night.end), '2026-03-11T04:00:00.000Z')
  assert.equal(night.date, '2026-03-11')
})

test('the night the clocks go back is an hour longer, in real time', () => {
  // Europe moves from UTC+2 to UTC+1 at 03:00 local on 2026-10-25.
  const night = planNight({ from: '23:30', to: '06:30' }, Date.parse('2026-10-24T18:00:00Z'), BERLIN)
  assert.equal(iso(night.start), '2026-10-24T21:30:00.000Z')
  assert.equal(iso(night.end), '2026-10-25T05:30:00.000Z')
  assert.equal(night.end - night.start, 8 * 3600_000)
})

test('the night the clocks go forward is an hour shorter, and a skipped time lands after the gap', () => {
  // Europe moves from UTC+1 to UTC+2 at 02:00 local on 2026-03-29.
  const night = planNight({ from: '23:30', to: '06:30' }, Date.parse('2026-03-28T18:00:00Z'), BERLIN)
  assert.equal(night.end - night.start, 6 * 3600_000)
  const skipped = localToInstant({ y: 2026, mo: 3, d: 29, h: 2, mi: 30 }, BERLIN)
  assert.equal(localTime(skipped, BERLIN), '03:30')
})

test('a time that happens twice is its first occurrence', () => {
  const twice = localToInstant({ y: 2026, mo: 10, d: 25, h: 2, mi: 30 }, BERLIN)
  assert.equal(iso(twice), '2026-10-25T00:30:00.000Z')
})

test('lastAt finds the most recent occurrence', () => {
  assert.equal(iso(lastAt('06:30', Date.parse('2026-03-10T21:00:00Z'), BERLIN)), '2026-03-10T05:30:00.000Z')
})

test('the same window is planned the same in another zone', () => {
  const night = planNight({ from: '22:00', to: '06:00' }, Date.parse('2026-03-10T12:00:00Z'), 'America/New_York')
  assert.equal(iso(night.start), '2026-03-11T02:00:00.000Z')
  assert.equal(localDate(night.start, 'America/New_York'), '2026-03-10')
})

test('from and to may not be the same', () => {
  assert.throws(() => planNight({ from: '06:00', to: '06:00' }, 0, BERLIN))
})

test('OnCalendar gets an exact UTC instant, rounded up to the second', () => {
  assert.equal(calendarUtc(Date.parse('2026-10-29T22:30:00.400Z')), '2026-10-29 22:30:01 UTC')
  assert.equal(calendarUtc(Date.parse('2026-10-29T22:30:00Z')), '2026-10-29 22:30:00 UTC')
})
