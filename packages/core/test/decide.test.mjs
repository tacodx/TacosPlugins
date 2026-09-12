import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, STATE } from '../decide.mjs'

const T = { five_hour: { soft: 75, hard: 90 }, seven_day: { soft: 60, hard: 80 } }

test('below soft on every gauge is ok', () => {
  const r = decide({ five_hour: { percent: 10, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.OK)
})

test('at or above soft reports soft with the offending gauge', () => {
  const r = decide({ five_hour: { percent: 75, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.SOFT)
  assert.equal(r.gauge, 'five_hour')
  assert.equal(r.percent, 75)
})

test('at or above hard reports hard', () => {
  const r = decide({ five_hour: { percent: 90, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.HARD)
})

test('most severe gauge wins regardless of key order', () => {
  const r = decide({
    five_hour: { percent: 80, resetsAt: 'A' },
    seven_day: { percent: 85, resetsAt: 'B' },
  }, T)
  assert.equal(r.state, STATE.HARD)
  assert.equal(r.gauge, 'seven_day')
})

test('null and unknown gauges are skipped, not treated as zero', () => {
  const r = decide({ five_hour: null, mystery: { percent: 99, resetsAt: null } }, T)
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('no gauges at all is ok, never a block', () => {
  assert.equal(decide({}, T).state, STATE.OK)
  assert.equal(decide(null, T).state, STATE.OK)
})

test('soft equal to hard skips the advisory stage', () => {
  const r = decide({ five_hour: { percent: 80, resetsAt: 'A' } },
    { five_hour: { soft: 80, hard: 80 } })
  assert.equal(r.state, STATE.HARD)
})

test('NaN hard threshold leaves gauge ungoverned', () => {
  const r = decide({ five_hour: { percent: 95, resetsAt: 'A' } },
    { five_hour: { soft: 75, hard: NaN } })
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('NaN soft threshold leaves gauge ungoverned', () => {
  const r = decide({ five_hour: { percent: 95, resetsAt: 'A' } },
    { five_hour: { soft: NaN, hard: 90 } })
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('a gauge marked enforce:false never decides, however high', () => {
  const r = decide({ five_hour: { percent: 100, resetsAt: 'R' } },
    { five_hour: { soft: 75, hard: 90, enforce: false } })
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('omitting enforce leaves the gauge enforcing', () => {
  const r = decide({ five_hour: { percent: 100, resetsAt: 'R' } },
    { five_hour: { soft: 75, hard: 90 } })
  assert.equal(r.state, STATE.HARD)
})

test('enforce:true is equivalent to omitting it', () => {
  const r = decide({ five_hour: { percent: 100, resetsAt: 'R' } },
    { five_hour: { soft: 75, hard: 90, enforce: true } })
  assert.equal(r.state, STATE.HARD)
})

test('a watch-only gauge does not mask an enforcing gauge listed after it', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: 'R' }, seven_day: { percent: 95, resetsAt: 'R' } },
    { five_hour: { soft: 75, hard: 90, enforce: false }, seven_day: { soft: 60, hard: 80 } },
  )
  assert.equal(r.state, STATE.HARD)
  assert.equal(r.gauge, 'seven_day')
})

test('enforce:0 is falsy but not the literal false, so the gauge still enforces', () => {
  const r = decide({ five_hour: { percent: 100, resetsAt: 'R' } },
    { five_hour: { soft: 75, hard: 90, enforce: 0 } })
  assert.equal(r.state, STATE.HARD)
})

const NOW = Date.parse('2026-09-11T12:00:00Z')

test('an expired resetsAt skips the gauge entirely, even at 100%', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: '2026-09-11T11:00:00Z' } }, // an hour in the past
    { five_hour: { soft: 75, hard: 90 } },
    NOW,
  )
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('a resetsAt exactly at now counts as already passed', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: '2026-09-11T12:00:00Z' } },
    { five_hour: { soft: 75, hard: 90 } },
    NOW,
  )
  assert.equal(r.state, STATE.OK)
})

test('a future resetsAt evaluates the gauge normally', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: '2026-09-11T13:00:00Z' } }, // an hour ahead
    { five_hour: { soft: 75, hard: 90 } },
    NOW,
  )
  assert.equal(r.state, STATE.HARD)
  assert.equal(r.gauge, 'five_hour')
})

test('an absent resetsAt (null) still evaluates the gauge normally, never disabling it', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: null } },
    { five_hour: { soft: 75, hard: 90 } },
    NOW,
  )
  assert.equal(r.state, STATE.HARD)
})

test('an unparseable resetsAt still evaluates the gauge normally, never disabling it', () => {
  const r = decide(
    { five_hour: { percent: 100, resetsAt: 'not-a-date' } },
    { five_hour: { soft: 75, hard: 90 } },
    NOW,
  )
  assert.equal(r.state, STATE.HARD)
})

test('decide defaults now to the real clock when omitted', () => {
  const farFuture = new Date(Date.now() + 3_600_000).toISOString()
  const r = decide({ five_hour: { percent: 100, resetsAt: farFuture } }, { five_hour: { soft: 75, hard: 90 } })
  assert.equal(r.state, STATE.HARD, 'a resetsAt an hour from the real now must not be treated as already past')
})
