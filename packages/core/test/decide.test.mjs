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
