import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideForHook } from '../../../plugins/usage-guard/hooks/guard.mjs'
import { DEFAULTS } from '../config.mjs'

const cfg = { gauges: DEFAULTS.gauges, mode: 'enforce' }
const at = (p) => ({ five_hour: { percent: p, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] })

test('the shipped default is enforce', () => {
  assert.equal(DEFAULTS.mode, 'enforce')
})

test('at the ceiling every tool is denied, not just fan-out', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cfg, gauges: at(95), blind: false })
  assert.equal(r.action, 'deny')
  assert.match(r.text, /ceiling/i)
})

test('between soft and hard, ordinary tools still run', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'allow')
})

test('between soft and hard, fan-out is denied', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Agent' }, cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})

test('a blind guard never denies even in enforce mode', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Agent' }, cfg, gauges: null, blind: true })
  assert.equal(r.action, 'allow')
})
