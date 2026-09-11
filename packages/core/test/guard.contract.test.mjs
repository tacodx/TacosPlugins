import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideForHook } from '../../../plugins/usage-guard/hooks/guard.mjs'
import { DEFAULTS } from '../config.mjs'

const cfg = { gauges: DEFAULTS.gauges, mode: 'dry-run' }
const at = (p) => ({ five_hour: { percent: p, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] })
const input = (over = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's', ...over })

test('a blind guard always allows', () => {
  assert.equal(decideForHook({ input: input(), cfg, gauges: null, blind: true }).action, 'allow')
})

test('below soft, nothing is injected', () => {
  assert.equal(decideForHook({ input: input(), cfg, gauges: at(10), blind: false }).action, 'allow')
})

test('dry-run never denies, however high the gauge', () => {
  const r = decideForHook({ input: input(), cfg, gauges: at(99), blind: false })
  assert.notEqual(r.action, 'deny')
})

test('mode off allows even at 100%', () => {
  const r = decideForHook({ input: input(), cfg: { ...cfg, mode: 'off' }, gauges: at(100), blind: false })
  assert.equal(r.action, 'allow')
})

test('above soft on UserPromptSubmit injects advisory text that forbids quality cuts', () => {
  const r = decideForHook({ input: input({ hook_event_name: 'UserPromptSubmit' }), cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'context')
  assert.match(r.text, /do not reduce effort/i)
  assert.match(r.text, /80/)
})

test('the Workflow tool is treated as fan-out, exactly like Agent', () => {
  const r = decideForHook({ input: input({ tool_name: 'Workflow' }), cfg: { ...cfg, mode: 'enforce' }, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})

test('tool_name Task is never expected, but is handled defensively', () => {
  const r = decideForHook({ input: input({ tool_name: 'Task' }), cfg: { ...cfg, mode: 'enforce' }, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})
