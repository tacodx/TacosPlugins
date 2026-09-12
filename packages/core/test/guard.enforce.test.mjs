import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideForHook } from '../../../plugins/usage-guard/hooks/guard.mjs'
import { DEFAULTS } from '../config.mjs'

const cfg = { gauges: DEFAULTS.gauges, mode: 'enforce' }
const at = (p) => ({ five_hour: { percent: p, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] })

test('the default is enforce', () => {
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

test('a stale 100% reading past its own resetsAt is not enforced, once decideForHook is given the real now', () => {
  const gaugesPastReset = {
    five_hour: { percent: 100, resetsAt: '2026-09-11T11:00:00Z' }, seven_day: null, extra_usage: null, scoped: [],
  }
  const now = Date.parse('2026-09-11T12:00:00Z') // an hour after the gauge's own reset
  const r = decideForHook({
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cfg, gauges: gaugesPastReset, blind: false, now,
  })
  assert.equal(r.action, 'allow', 'a denial must never rest on a reading known to be invalid past its reset')
})

test('at 100% in enforce mode, the budget CLI escapes the ceiling while an unrelated Bash call is still denied', () => {
  const budgetInput = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node "/home/user/.claude/plugins/usage-guard/bin/budget.mjs" "$CLAUDE_SESSION_ID" off' },
  }
  const escaped = decideForHook({ input: budgetInput, cfg, gauges: at(100), blind: false })
  assert.equal(escaped.action, 'allow', '/budget off must always be reachable, even at the hard ceiling')

  const unrelatedInput = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }
  const denied = decideForHook({ input: unrelatedInput, cfg, gauges: at(100), blind: false })
  assert.equal(denied.action, 'deny', 'the exemption must not become a general bypass for other Bash calls')
})
