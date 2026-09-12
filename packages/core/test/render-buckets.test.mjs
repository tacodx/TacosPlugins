import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBuckets } from '../render-buckets.mjs'
import { normaliseLimits } from '../buckets.mjs'
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
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: 'max',
    helps: false, reason: 'nope' })
  assert.match(out, /session/)
  assert.match(out, /weekly_all/)
  assert.match(out, /Fable/)
  assert.match(out, /40/)
})

test('names the current model and effort', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: 'max',
    helps: false, reason: 'nope' })
  assert.match(out, /claude-opus-5/)
  assert.match(out, /max/)
})

test('says plainly when the model is unknown', () => {
  const out = renderBuckets({ buckets, model: null, effort: null, helps: false, reason: 'nope' })
  assert.match(out, /could not be determined/i)
})

test('omits the effort line entirely when effort is unknown, rather than a permanent placeholder', () => {
  // Unlike the model, a caller that has no source for effort at all (the /limits CLI)
  // would print a "could not be determined" placeholder on every single invocation —
  // that reads as a defect in the tool, not a real limitation being disclosed. So this
  // is a real behavioral difference from the model line above, not an oversight.
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: null, helps: false, reason: 'nope' })
  assert.doesNotMatch(out, /effort/i)
})

test('prints the effort line when effort is known', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: 'max', helps: false, reason: 'nope' })
  assert.match(out, /effort:\s*max/i)
})

test('renders nothing misleading with no buckets', () => {
  const out = renderBuckets({ buckets: [], model: 'x', effort: null, helps: false,
    reason: 'No rate-limit buckets were reported.' })
  assert.match(out, /no rate-limit buckets/i)
  assert.doesNotMatch(out, /\d+%/)
})

test('marks the binding bucket', () => {
  // weekly_all is the highest percentage (40) among the fixture buckets, so binding()
  // picks it — its line, and only its line, must carry the marker.
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: 'max',
    helps: false, reason: 'nope' })
  const bindingLine = out.split('\n').find((l) => l.includes('weekly_all'))
  assert.match(bindingLine, /binding/i)
  const sessionLine = out.split('\n').find((l) => l.includes('session') && !l.includes('scoped'))
  assert.doesNotMatch(sessionLine, /binding/i)
})

test('prints the reason sentence verbatim', () => {
  const out = renderBuckets({ buckets, model: 'claude-opus-5', effort: 'max',
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
