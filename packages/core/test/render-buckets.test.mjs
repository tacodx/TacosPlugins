import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBuckets } from '../render-buckets.mjs'
import { normaliseLimits, switchingHelps } from '../buckets.mjs'
import { writeCache } from '../cache.mjs'
import { rawCachePath } from '../usage.mjs'

const LIMITS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'model-advisor', 'bin', 'limits.mjs')

const buckets = normaliseLimits({ limits: [
  { kind: 'session', group: 'session', percent: 13, is_active: false, scope: null },
  { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: true, scope: null },
  { kind: 'weekly_scoped', group: 'weekly', percent: 22, is_active: false,
    scope: { model: { display_name: 'Fable' } } },
] })

test('lists every bucket with its percent and scope', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', helps: false, reason: 'nope' })
  assert.match(out, /session/)
  assert.match(out, /weekly_all/)
  assert.match(out, /Fable/)
  assert.match(out, /40/)
})

test('names the current model', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', helps: false, reason: 'nope' })
  assert.match(out, /claude-opus-5/)
})

test('says plainly when the model is unknown', () => {
  const out = renderBuckets({ buckets, model: null, helps: false, reason: 'nope' })
  assert.match(out, /could not be determined/i)
})

// `effort` was removed from this function's signature entirely (not just omitted when
// null): bin/limits.mjs hard-codes it to null and the hook never calls renderBuckets at
// all, so there was no reachable production caller that could ever supply a real value —
// a parameter with no possible non-null input is dead weight, not a real behavior to
// keep testing. See the doc comment above renderBuckets for the removal note.
test('never prints an effort line — there is no caller left that could supply one', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', helps: false, reason: 'nope' })
  assert.doesNotMatch(out, /effort/i)
})

test('renders nothing misleading with no buckets', () => {
  const out = renderBuckets({ buckets: [], model: 'x', helps: false,
    reason: 'No rate-limit buckets were reported.' })
  assert.match(out, /no rate-limit buckets/i)
  assert.doesNotMatch(out, /\d+%/)
})

test('marks exactly the bucket object it is handed, nothing else', () => {
  // renderBuckets has no binding()/scope logic of its own any more — it marks whichever
  // bucket object `switchingHelps` returned, by reference, and nothing else. Passing
  // weekly_all explicitly here (rather than relying on renderBuckets to compute "the
  // highest one" itself) is the whole point of the fix: a caller that reasoned about a
  // DIFFERENT bucket than the naive maximum must see that bucket marked instead.
  const out = renderBuckets({ buckets, model: 'claude-opus-5',
    helps: false, reason: 'nope', bucket: buckets[1] })
  const bindingLine = out.split('\n').find((l) => l.includes('weekly_all'))
  assert.match(bindingLine, /binding/i)
  const sessionLine = out.split('\n').find((l) => l.includes('session') && !l.includes('scoped'))
  assert.doesNotMatch(sessionLine, /binding/i)
  const fableLine = out.split('\n').find((l) => l.includes('weekly_scoped'))
  assert.doesNotMatch(fableLine, /binding/i)
})

test('with no bucket passed through, nothing is marked binding', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', helps: false, reason: 'nope' })
  assert.doesNotMatch(out, /binding/i)
})

test('integration: an other-model-scoped bucket is listed but never marked, and the sentence names the real constraint', () => {
  // Findings 1 & 2, end to end: switchingHelps and renderBuckets fed from the SAME call,
  // exactly as bin/limits.mjs wires them, reproducing the repo owner's own account shape
  // (Opus session; a Fable-scoped bucket sits at the highest percentage but cannot bind
  // an Opus session).
  const shaped = normaliseLimits({ limits: [
    { kind: 'session', group: 'session', percent: 13, is_active: false, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: true, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 90, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  const { helps, reason, bucket } = switchingHelps(shaped, 'claude-opus-5')
  const out = renderBuckets({ buckets: shaped, model: 'claude-opus-5', helps, reason, bucket })

  const fableLine = out.split('\n').find((l) => l.includes('weekly_scoped'))
  assert.match(fableLine, /Fable/)
  assert.doesNotMatch(fableLine, /binding/i, 'a bucket scoped to another model must never be marked binding')

  const weeklyAllLine = out.split('\n').find((l) => l.includes('weekly_all'))
  assert.match(weeklyAllLine, /binding/i)
  assert.match(out, /weekly_all/)
  assert.doesNotMatch(out.split('\n').pop(), /90/, 'the sentence must name the real constraint, not the irrelevant 90%')
})

test('integration: a scoped/shared 61% tie marks and names the SAME bucket, reproducing finding 1b exactly', () => {
  // Finding 1b, verbatim: is_active is flipped so a scope-blind binding() (which
  // tie-breaks toward the active bucket) would pick weekly_scoped, while switchingHelps
  // reasons that weekly_all — the shared one — is the real blocker. Under the bug, the
  // marker landed on weekly_scoped while the sentence two lines below named weekly_all:
  // a self-contradiction inside one block. Feeding renderBuckets the SAME `bucket`
  // switchingHelps returned must make the marker and the sentence agree, always.
  const tied = normaliseLimits({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 61, is_active: false, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 61, is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] })
  const { helps, reason, bucket } = switchingHelps(tied, 'claude-fable-5-1')
  const out = renderBuckets({ buckets: tied, model: 'claude-fable-5-1', helps, reason, bucket })

  const markedLine = out.split('\n').find((l) => l.includes('<- binding'))
  const sentence = out.split('\n').pop()
  assert.match(sentence, /weekly_all/)
  assert.ok(markedLine.includes('weekly_all'),
    `the marked line and the sentence must name the same bucket — marked: "${markedLine}", sentence: "${sentence}"`)
})

test('prints the reason sentence verbatim', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5',
    helps: true, reason: 'This exact sentence must appear untouched.' })
  assert.match(out, /This exact sentence must appear untouched\./)
})

// --- End-to-end: the real CLI process, no network, no real ~/.claude ---
//
// The brief calls out that a prior process-level test spawned the real binary against
// an EMPTY config dir and only ever exercised the "no data" branch — a mutation in the
// branch that actually renders a bucket map sailed through the whole suite. These two
// tests seed a scratch CLAUDE_CONFIG_DIR with a fabricated usage-raw.json cache (same
// technique advisor.contract.test.mjs uses) so the real process renders a real bucket
// map, then separately exercise the genuinely-empty case.
test('the real /limits process renders a real bucket map from a fabricated cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-advisor-limits-test-'))
  try {
    const now = Date.now()
    writeCache(join(dir, 'tacos', 'usage-cache.json'),
      { five_hour: null, seven_day: null, extra_usage: null, scoped: [] }, { now })
    writeCache(rawCachePath(dir), {
      limits: [
        { kind: 'session', group: 'session', percent: 13, is_active: false, resets_at: null, scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: true, resets_at: 'W', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 92, is_active: true,
          resets_at: '2026-09-19T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    }, { now })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1[1m]' }))

    const out = execFileSync('node', [LIMITS, 's1'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })

    assert.match(out, /weekly_scoped/)
    assert.match(out, /Fable/)
    assert.match(out, /92/)
    assert.match(out, /claude-fable-5-1/)
    assert.match(out, /binding/i)
    // The model in use (claude-fable-5-1) matches the 92%-scoped bucket, which is the
    // maximum, so switching genuinely would help right now — the real switchingHelps
    // codepath, not a fabricated one.
    assert.match(out, /would help/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real /limits process resolves the model from the session transcript over settings.json', () => {
  // Proves findSessionTranscript's wiring actually wins, not just that it exists: the
  // transcript and settings.json deliberately disagree, and the transcript must be the
  // one that shows up in the output.
  const dir = mkdtempSync(join(tmpdir(), 'model-advisor-limits-test-'))
  try {
    const now = Date.now()
    writeCache(join(dir, 'tacos', 'usage-cache.json'),
      { five_hour: null, seven_day: null, extra_usage: null, scoped: [] }, { now })
    writeCache(rawCachePath(dir), { limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 10, is_active: true, resets_at: 'W', scope: null },
    ] }, { now })
    // settings.json names a model the transcript must NOT win with.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
    // The session transcript, found by session id under projects/<anything>/, names a
    // different model — this is the one that must appear in the output.
    const projectDir = join(dir, 'projects', 'some-project-hash')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 's1.jsonl'),
      `${JSON.stringify({ message: { model: 'claude-sonnet-5' } })}\n`)

    const out = execFileSync('node', [LIMITS, 's1'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })

    assert.match(out, /claude-sonnet-5/, 'the transcript-named model must appear')
    assert.doesNotMatch(out, /claude-opus-5/, 'the settings.json model must NOT win when a transcript is found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real /limits process against an empty config dir prints a clean no-data message, never a stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-advisor-limits-test-'))
  try {
    const out = execFileSync('node', [LIMITS, 's1'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })
    assert.doesNotMatch(out, /\bat \S+ \(.*:\d+:\d+\)/, 'must never print a stack trace frame')
    assert.doesNotMatch(out, /\d+%/, 'no data means no percentages')
    assert.match(out, /no rate-limit buckets|could not be determined/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
