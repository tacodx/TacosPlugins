import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseLimits, binding, switchingHelps } from '../buckets.mjs'

const REAL = { limits: [
  { kind: 'session',       group: 'session', percent: 13, is_active: false, resets_at: 'S', scope: null },
  { kind: 'weekly_all',    group: 'weekly',  percent: 40, is_active: true,  resets_at: 'W', scope: null },
  { kind: 'weekly_scoped', group: 'weekly',  percent: 22, is_active: false, resets_at: 'F',
    scope: { model: { display_name: 'Fable' } } },
] }

test('normalise keeps kind, percent, scope model and active', () => {
  const b = normaliseLimits(REAL)
  assert.equal(b.length, 3)
  assert.equal(b[2].model, 'Fable')
  assert.equal(b[1].active, true)
  assert.equal(b[0].model, null)
})

test('normalise tolerates any payload', () => {
  assert.deepEqual(normaliseLimits(null), [])
  assert.deepEqual(normaliseLimits({}), [])
  assert.deepEqual(normaliseLimits({ limits: 'nope' }), [])
  assert.deepEqual(normaliseLimits({ limits: [{ kind: 'x' }] }), [])
})

test('binding picks the highest percentage', () => {
  assert.equal(binding(normaliseLimits(REAL)).kind, 'weekly_all')
})

test('binding returns null for no buckets', () => {
  assert.equal(binding([]), null)
  assert.equal(binding(null), null)
})

test('switching does not help when a shared bucket binds', () => {
  const r = switchingHelps(normaliseLimits(REAL), 'Fable')
  assert.equal(r.helps, false)
  assert.match(r.reason, /every model/i)
})

test('switching helps when the binding bucket is scoped to the model in use', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 10, is_active: false, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  const r = switchingHelps(scoped, 'Fable')
  assert.equal(r.helps, true)
  assert.match(r.reason, /Fable/)
})

test('a scoped bucket for a DIFFERENT model does not mean switching helps', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'Opus').helps, false)
})

test('an unknown current model never claims switching helps', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 99, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  for (const m of [null, undefined, '']) {
    assert.equal(switchingHelps(scoped, m).helps, false)
  }
})

test('model matching is case-insensitive and tolerates the api id form', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'fable').helps, true)
  assert.equal(switchingHelps(scoped, 'claude-fable-5-1').helps, true)
})
