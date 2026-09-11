import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMoney, bar, renderStatus } from '../render.mjs'
import { STATE } from '../decide.mjs'
import { DEFAULTS } from '../config.mjs'

test('money is decoded from minor units', () => {
  assert.equal(formatMoney(5048, 6000, 'EUR', 2), 'EUR 50.48 / 60.00')
})

test('a zero-decimal currency is not divided', () => {
  assert.equal(formatMoney(500, 1000, 'JPY', 0), 'JPY 500 / 1000')
})

test('the bar is clamped at both ends', () => {
  assert.equal(bar(0, 10).length, 10)
  assert.equal(bar(150, 10).length, 10)
  assert.equal(bar(-5, 10).length, 10)
})

test('a blind guard says so and never prints a number', () => {
  const out = renderStatus({ gauges: null, thresholds: DEFAULTS.gauges, decision: null, mode: 'enforce', blind: true, reason: 'no-credentials' })
  assert.match(out, /no usage data/i)
  assert.match(out, /no-credentials/)
  assert.doesNotMatch(out, /\d+%/)
})

test('a governed gauge shows its percent and thresholds', () => {
  const gauges = { five_hour: { percent: 35, resetsAt: '2026-09-11T20:00:00Z' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({ gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK }, mode: 'enforce', blind: false })
  assert.match(out, /five_hour/)
  assert.match(out, /35/)
  assert.match(out, /75/)
})
