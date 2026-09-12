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

test('a name that merely contains the bucket model as a substring does not match', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'affable-5').helps, false)
  assert.equal(switchingHelps(scoped, 'unfabled-model-x').helps, false)
})

test('a multi-word bucket model matches an api id carrying every token', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Claude Opus' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'claude-opus-5').helps, true)
})

test('two model-scoped buckets tied at the maximum give the same answer regardless of array order', () => {
  // is_active is deliberately IDENTICAL on both buckets. binding()'s active-tiebreak
  // would otherwise resolve the tie by itself regardless of array order, which made an
  // earlier version of this test pass even against the pre-fix, order-dependent
  // implementation — the tie has to fall through to input order for this test to mean
  // anything.
  const opusBucket = { kind: 'weekly_scoped', group: 'weekly', percent: 77, is_active: true,
    scope: { model: { display_name: 'Opus' } } }
  const fableBucket = { kind: 'weekly_scoped', group: 'weekly', percent: 77, is_active: true,
    scope: { model: { display_name: 'Fable' } } }

  const forward = switchingHelps(normaliseLimits({ limits: [opusBucket, fableBucket] }), 'Fable')
  const reversed = switchingHelps(normaliseLimits({ limits: [fableBucket, opusBucket] }), 'Fable')
  assert.equal(forward.helps, false)
  assert.equal(reversed.helps, false)
})

test('a shared bucket tied at the maximum with a current-model bucket means switching does not help', () => {
  const shared = { kind: 'weekly_all', group: 'weekly', percent: 60, is_active: true, scope: null }
  const scoped = { kind: 'weekly_scoped', group: 'weekly', percent: 60, is_active: false,
    scope: { model: { display_name: 'Fable' } } }
  const r = switchingHelps(normaliseLimits({ limits: [shared, scoped] }), 'Fable')
  assert.equal(r.helps, false)
})

test('a versioned bucket name does not match a different point release by token subset (version confusion)', () => {
  const opus4 = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Opus 4' } } },
  ] })
  assert.equal(switchingHelps(opus4, 'claude-opus-4-5-20250929').helps, false)

  const haiku3 = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Claude 3 Haiku' } } },
  ] })
  assert.equal(switchingHelps(haiku3, 'claude-3-5-haiku-20241022').helps, false)
})

test('a versioned bucket name still matches an exactly equal token sequence', () => {
  const opus4 = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Opus 4' } } },
  ] })
  assert.equal(switchingHelps(opus4, 'opus-4').helps, true)
})

test('non-versioned bucket names are unaffected by the version-digit exact-match rule', () => {
  const fable = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  assert.equal(switchingHelps(fable, 'claude-fable-5-1').helps, true)

  const claudeOpus = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Claude Opus' } } },
  ] })
  assert.equal(switchingHelps(claudeOpus, 'claude-opus-5').helps, true)
})

test('a non-finite percent is dropped rather than winning binding()', () => {
  const withInfinity = normaliseLimits({ limits: [
    { kind: 'broken', group: 'weekly', percent: Infinity, is_active: true, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: true, scope: null },
  ] })
  assert.equal(withInfinity.length, 1)
  assert.equal(withInfinity[0].kind, 'weekly_all')
})
