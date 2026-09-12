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

test('a SOFT decision rounds the percent instead of printing the raw float', () => {
  const gauges = { five_hour: null, seven_day: null, extra_usage: { percent: 84.13333333333334, resetsAt: null }, scoped: [] }
  const decision = { state: STATE.SOFT, gauge: 'extra_usage', percent: 84.13333333333334, soft: 70, hard: 85 }
  const out = renderStatus({ gauges, thresholds: DEFAULTS.gauges, decision, mode: 'enforce', blind: false })
  assert.match(out, /decision: advise/)
  assert.match(out, /84%/)
  assert.doesNotMatch(out, /84\.13/)
})

test('a HARD decision rounds the percent instead of printing the raw float', () => {
  const gauges = { five_hour: null, seven_day: null, extra_usage: { percent: 91.6666666666667, resetsAt: null }, scoped: [] }
  const decision = { state: STATE.HARD, gauge: 'extra_usage', percent: 91.6666666666667, soft: 70, hard: 85 }
  const out = renderStatus({ gauges, thresholds: DEFAULTS.gauges, decision, mode: 'enforce', blind: false })
  assert.match(out, /decision: deny/)
  assert.match(out, /92%/)
  assert.doesNotMatch(out, /91\.6/)
})

test('an unreadable config that degraded to dry-run says the guard is observing only', () => {
  const gauges = { five_hour: { percent: 10, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({
    gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK },
    mode: 'dry-run', blind: false, configUnreadable: true,
  })
  assert.match(out, /config could not be read/i)
  assert.match(out, /observing/i)
})

test('an unreadable config that preserved an explicit "enforce" must not claim the guard is passive', () => {
  // readConfig never discards a mode a readable layer stated explicitly — only a
  // layer that named no mode at all degrades to dry-run. If the corrupt layer was,
  // say, a stale session file while the user's own config.json still reads
  // "enforce", the guard is genuinely enforcing. Telling the user it is "observing
  // only" here would be actively false safety information while their tool calls
  // can still be denied.
  const gauges = { five_hour: { percent: 10, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({
    gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK },
    mode: 'enforce', blind: false, configUnreadable: true,
  })
  assert.match(out, /config could not be read/i)
  assert.match(out, /mode in effect: enforce/i)
  assert.doesNotMatch(out, /observing only/i)
  assert.doesNotMatch(out, /not enforcing/i)
})

test('a refresh-not-persisted warning renders even though the gauges are otherwise healthy', () => {
  const gauges = { five_hour: { percent: 10, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({
    gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK },
    mode: 'enforce', blind: false, warning: 'refresh-not-persisted',
  })
  assert.match(out, /could not be saved to disk/i)
  assert.match(out, /re-authentication/i)
})

test('no warning line appears when warning is absent', () => {
  const gauges = { five_hour: { percent: 10, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({ gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK }, mode: 'enforce', blind: false })
  assert.doesNotMatch(out, /could not be saved to disk/i)
})

test('a watch-only gauge still renders, marked as such', () => {
  const gauges = { five_hour: { percent: 100, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({
    gauges,
    thresholds: { five_hour: { soft: 75, hard: 90, enforce: false } },
    decision: { state: STATE.OK }, mode: 'enforce', blind: false,
  })
  assert.match(out, /five_hour/)
  assert.match(out, /100/)
  assert.match(out, /watch-only/i)
})
