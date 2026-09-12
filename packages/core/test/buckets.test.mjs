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
  assert.equal(b[2].modelId, null)
  assert.equal(b[1].active, true)
  assert.equal(b[0].model, null)
})

test('normalise captures scope.model.id when the API provides it', () => {
  const b = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 50, is_active: true,
      scope: { model: { id: 'claude-fable-5-1', display_name: 'Fable' } } },
  ] })
  assert.equal(b[0].modelId, 'claude-fable-5-1')
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

test('a present modelId matches the current model by exact, case-insensitive equality', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-fable-5-1', display_name: 'Fable' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'claude-fable-5-1').helps, true)
  assert.equal(switchingHelps(scoped, 'CLAUDE-FABLE-5-1').helps, true)
})

test('a present modelId requires exact equality, not substring or token matching', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-opus-4-5-20250929', display_name: 'Opus 4' } } },
  ] })
  assert.equal(switchingHelps(scoped, 'claude-opus-4-5').helps, false)
})

test('a mismatched modelId wins outright and is never rescued by a matching display_name', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-opus-5', display_name: 'Fable' } } },
  ] })
  // display_name says "Fable", which would match this current model under the
  // display-name heuristic alone — but a present, disagreeing modelId must decide first.
  assert.equal(switchingHelps(scoped, 'claude-fable-5-1').helps, false)
})

test('with modelId absent (null), every display-name-based behavior is unchanged', () => {
  // Every fixture in this file besides the three modelId-specific tests above omits
  // `scope.model.id`, so normaliseLimits gives them modelId: null and they all still
  // exercise the display-name fallback exactly as before.
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  assert.equal(scoped[0].modelId, null)
  assert.equal(switchingHelps(scoped, 'fable').helps, true)
  assert.equal(switchingHelps(scoped, 'claude-fable-5-1').helps, true)
  assert.equal(switchingHelps(scoped, 'affable-5').helps, false)
})

test('a bucket identified by id alone (no display_name) is reachable and matches', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-fable-5-1' } } },
  ] })
  assert.equal(scoped[0].model, null)
  assert.equal(switchingHelps(scoped, 'claude-fable-5-1').helps, true)
})

test('a bucket identified by id alone, for a different model, is false and names the id — not "every model"', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-fable-5-1' } } },
  ] })
  const r = switchingHelps(scoped, 'claude-opus-5')
  assert.equal(r.helps, false)
  assert.match(r.reason, /claude-fable-5-1/)
  assert.doesNotMatch(r.reason, /every model/i)
})

test('a truly shared bucket (no model, no modelId) still says every model draws on', () => {
  const shared = normaliseLimits({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 88, is_active: true, scope: null },
  ] })
  assert.equal(shared[0].model, null)
  assert.equal(shared[0].modelId, null)
  const r = switchingHelps(shared, 'claude-opus-5')
  assert.equal(r.helps, false)
  assert.match(r.reason, /every model/i)
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

test('a bucket scoped to a DIFFERENT model tied at the same percentage is irrelevant, regardless of array order', () => {
  // Corrected semantics (see the applicability fix): opusBucket cannot constrain a
  // Fable session at all, tied percentage or not — it is filtered out of consideration
  // entirely, leaving fableBucket as the sole applicable, and therefore binding, bucket.
  // Switching away from Fable moves you off Fable's own ceiling, so this is `true` now —
  // an earlier version of this test asserted `false` for both orders, which was exactly
  // the bug in findings 1/2: it let a same-percentage bucket scoped to a model we are
  // NOT running decide the answer for a session it cannot possibly bind.
  const opusBucket = { kind: 'weekly_scoped', group: 'weekly', percent: 77, is_active: true,
    scope: { model: { display_name: 'Opus' } } }
  const fableBucket = { kind: 'weekly_scoped', group: 'weekly', percent: 77, is_active: true,
    scope: { model: { display_name: 'Fable' } } }

  const forward = switchingHelps(normaliseLimits({ limits: [opusBucket, fableBucket] }), 'Fable')
  const reversed = switchingHelps(normaliseLimits({ limits: [fableBucket, opusBucket] }), 'Fable')
  assert.equal(forward.helps, true)
  assert.equal(reversed.helps, true)
  assert.equal(forward.bucket.model, 'Fable')
  assert.equal(reversed.bucket.model, 'Fable')
  assert.match(forward.reason, /Fable/)
})

test('a shared bucket tied at the maximum with a current-model bucket means switching does not help', () => {
  const shared = { kind: 'weekly_all', group: 'weekly', percent: 60, is_active: true, scope: null }
  const scoped = { kind: 'weekly_scoped', group: 'weekly', percent: 60, is_active: false,
    scope: { model: { display_name: 'Fable' } } }
  const r = switchingHelps(normaliseLimits({ limits: [shared, scoped] }), 'Fable')
  assert.equal(r.helps, false)
  assert.equal(r.bucket.kind, 'weekly_all')
  assert.match(r.reason, /weekly_all/)
})

// --- Findings 1 & 2: the renderer and the reasoner must agree on which bucket binds ---

test('an Opus session is not bound by a Fable-scoped bucket even when it is the highest percentage reported', () => {
  // The repo owner's own account shape: session 13%, weekly_all 40% (both shared), and a
  // Fable-scoped bucket at 90%. An Opus session is never constrained by Fable's own
  // allowance — the real constraint is weekly_all at 40% — so the returned `bucket` must
  // be weekly_all, and the sentence must name it, not the higher-but-irrelevant 90%.
  const buckets = normaliseLimits({ limits: [
    { kind: 'session', group: 'session', percent: 13, is_active: false, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: true, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 90, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  const r = switchingHelps(buckets, 'claude-opus-5')
  assert.equal(r.helps, false)
  assert.equal(r.bucket.kind, 'weekly_all')
  assert.match(r.reason, /weekly_all/)
  assert.doesNotMatch(r.reason, /90/)
})

test('a scoped and a shared bucket tied at 61% mark and name the SAME bucket — no self-contradiction', () => {
  const scoped = { kind: 'weekly_scoped', group: 'weekly', percent: 61, is_active: false,
    scope: { model: { display_name: 'Fable' } } }
  const shared = { kind: 'weekly_all', group: 'weekly', percent: 61, is_active: true, scope: null }
  const r = switchingHelps(normaliseLimits({ limits: [scoped, shared] }), 'claude-fable-5-1')
  // The shared bucket is the one that actually blocks switching (it draws on every
  // model), so it must be both the marked bucket AND the one the sentence names — never
  // one saying weekly_scoped while the other says weekly_all.
  assert.equal(r.helps, false)
  assert.equal(r.bucket.kind, 'weekly_all')
  assert.match(r.reason, /weekly_all/)
  assert.doesNotMatch(r.reason, /weekly_scoped/)
})

test('a bucket scoped to another model is never returned as the binding bucket, even at the global max', () => {
  const buckets = normaliseLimits({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 5, is_active: true, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 99, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  const r = switchingHelps(buckets, 'claude-opus-5')
  assert.notEqual(r.bucket?.model, 'Fable')
  assert.equal(r.bucket.kind, 'weekly_all')
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

// --- Finding 3: the version-match rule must be a contiguous-subsequence, not exact-length ---

test('"Fable 5.1" matches "claude-fable-5-1" — a real model id always carries a prefix', () => {
  // The exact-length rule this replaces could never match here: tokens("Fable 5.1") has
  // length 3, tokens("claude-fable-5-1") has length 4, and no real model id is ever
  // prefix-free — so every versioned bucket name matched nothing under that rule. This is
  // the bug finding 3 exists to fix.
  const fable = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Fable 5.1' } } },
  ] })
  assert.equal(switchingHelps(fable, 'claude-fable-5-1').helps, true)
})

test('"Opus 4" does not match "claude-opus-4-5-20250929" — a short numeric next token is a finer version', () => {
  const opus4 = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Opus 4' } } },
  ] })
  assert.equal(switchingHelps(opus4, 'claude-opus-4-5-20250929').helps, false)
})

test('"Opus 4 5" matches "claude-opus-4-5-20250929" — a six-plus-digit next token is a date, not a version', () => {
  const opus45 = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Opus 4 5' } } },
  ] })
  assert.equal(switchingHelps(opus45, 'claude-opus-4-5-20250929').helps, true)
})

test('a confirmed-different model (modelId present and disagreeing) says "not the model in use"', () => {
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { id: 'claude-fable-5-1', display_name: 'Fable' } } },
  ] })
  const r = switchingHelps(scoped, 'claude-opus-5')
  assert.equal(r.helps, false)
  assert.match(r.reason, /not the model in use/)
  assert.doesNotMatch(r.reason, /could not confirm/i)
})

test('an unconfirmed match (display-name heuristic failure, no modelId) says "could not confirm" — never asserts "not"', () => {
  // This is the "worse half" of finding 3: matching failure via the display-name
  // heuristic is NOT the same claim as a confirmed-different modelId, and must not be
  // worded as though it were.
  const scoped = normaliseLimits({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 88, is_active: true,
      scope: { model: { display_name: 'Opus 4' } } },
  ] })
  const r = switchingHelps(scoped, 'claude-opus-4-5-20250929')
  assert.equal(r.helps, false)
  assert.match(r.reason, /could not confirm/i)
  assert.doesNotMatch(r.reason, /not the model in use/)
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
