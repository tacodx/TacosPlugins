import { test } from 'node:test'
import assert from 'node:assert/strict'

import { change, count, dayLabel, duration, modelName, monthLabel, percent, plural, tokens } from '../hooks/format.mjs'

test('count groups thousands', () => {
  assert.equal(count(0), '0')
  assert.equal(count(999), '999')
  assert.equal(count(6215), '6,215')
  assert.equal(count(1234567), '1,234,567')
})

test('tokens picks the unit a figure reads best in, and never prints 1000K', () => {
  assert.equal(tokens(950), '950')
  assert.equal(tokens(35_700), '36K')
  assert.equal(tokens(999_499), '999K')
  assert.equal(tokens(999_500), '1.0M')
  assert.equal(tokens(94_800_000), '94.8M')
  assert.equal(tokens(999_950_000), '1.0B')
  assert.equal(tokens(15_600_000_000), '15.6B')
})

test('a share that is there never reads as 0%', () => {
  assert.equal(percent(0), '0%')
  assert.equal(percent(0.002), '<1%')
  assert.equal(percent(0.5), '50%')
  assert.equal(percent(0.972), '97%')
})

test('duration reads in minutes under an hour, then in hours', () => {
  assert.equal(duration(2_700_000), '45 min')
  assert.equal(duration(27_000_000), '7.5 h')
  assert.equal(duration(565_200_000), '157 h')
})

test('days and months are named the short way', () => {
  assert.equal(dayLabel('2026-10-07'), '7 Oct')
  assert.equal(monthLabel('2026-03'), 'Mar 2026')
})

test('a model id becomes the name people use for it', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5')
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelName('(unknown)'), '(unknown)')
})

test('change compares with what came before, when there was something before', () => {
  assert.equal(change(142, 100), '+42%')
  assert.equal(change(90, 100), '-10%')
  assert.equal(change(100, 100), '+0%')
  assert.equal(change(5, 0), null)
  assert.equal(change(5, undefined), null)
})

test('plural follows the number', () => {
  assert.equal(plural(1, 'day'), '1 day')
  assert.equal(plural(1500, 'reply', 'replies'), '1,500 replies')
})
