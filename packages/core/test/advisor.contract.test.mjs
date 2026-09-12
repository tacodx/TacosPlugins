import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adviseForHook } from '../../../plugins/model-advisor/hooks/advisor.mjs'
import { normaliseLimits } from '../buckets.mjs'
import { writeCache } from '../cache.mjs'
import { rawCachePath } from '../usage.mjs'

const ADVISOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'model-advisor', 'hooks', 'advisor.mjs')

const shared = normaliseLimits({ limits: [
  { kind: 'weekly_all', group: 'weekly', percent: 90, is_active: true, scope: null },
] })
const scoped = normaliseLimits({ limits: [
  { kind: 'weekly_scoped', group: 'weekly', percent: 90, is_active: true,
    scope: { model: { display_name: 'Fable' } } },
] })
const input = { hook_event_name: 'UserPromptSubmit', session_id: 's' }

test('silent when a shared bucket binds, however high', () => {
  assert.equal(adviseForHook({ input, buckets: shared, model: 'claude-fable-5-1' }).action, 'allow')
})

test('silent when the model is unknown', () => {
  assert.equal(adviseForHook({ input, buckets: scoped, model: null }).action, 'allow')
})

test('silent when there are no buckets', () => {
  assert.equal(adviseForHook({ input, buckets: [], model: 'claude-opus-5' }).action, 'allow')
})

test('speaks only when the binding bucket is scoped to the model in use', () => {
  const r = adviseForHook({ input, buckets: scoped, model: 'claude-fable-5-1' })
  assert.equal(r.action, 'context')
  assert.match(r.text, /Fable/)
  assert.match(r.text, /90/)
})

test('never emits a denial in any combination', () => {
  for (const buckets of [shared, scoped, []]) {
    for (const model of ['claude-fable-5-1', 'claude-opus-5', null]) {
      const r = adviseForHook({ input, buckets, model })
      assert.notEqual(r.action, 'deny')
    }
  }
})

test('never claims one model costs more than another', () => {
  const r = adviseForHook({ input, buckets: scoped, model: 'claude-fable-5-1' })
  assert.doesNotMatch(r.text, /cheap|expensive|costs? (more|less)|save (money|tokens)/i)
})

// Property 1 ("this plugin can never deny") only has coverage above at the level of
// adviseForHook's own return value. adviseForHook is pure and cannot produce a
// permissionDecision by construction, but nothing above exercises the isMain-guarded
// wiring that turns its {action, text} into the real hookSpecificOutput JSON — a mutation
// there (e.g. hard-coding denyOutput) would sail past every test in this file. This spawns
// the real hook process, exactly as Claude Code would, against an isolated empty config
// dir (never the user's real ~/.claude) so it stays blind and offline — no credentials
// file means getAccessToken returns synchronously with no network call — and checks the
// actual stdout a real hook run produces.
//
// This ONLY exercises advisor.mjs's ALLOW branch: an empty config dir has no buckets, so
// adviseForHook returns 'allow' and the wiring's `action === 'context' ? ... : allowOutput()`
// ternary never evaluates its 'context' side. See the test below for that branch.
test('the real hook process never emits a permissionDecision — this plugin can never deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-advisor-test-'))
  try {
    const out = execFileSync('node', [ADVISOR], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })
    assert.doesNotMatch(out, /permissionDecision/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The test above proves nothing about the 'context' side of the wiring ternary, since it
// never gets taken. This drives the real process down THAT branch instead, by fabricating
// a fresh usage-cache.json + usage-raw.json (so getGauges needs neither real credentials
// nor a real network call — same technique usage-guard's own tests use to exercise its
// deny path against a scratch config dir) and a transcript whose most recent row names a
// model the fabricated bucket is scoped to. This is the check that actually pins property
// 1 end to end: it would fail if the 'context' branch were ever wired to denyOutput.
test('the real hook process reaches the context branch and still never emits a permissionDecision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-advisor-test-'))
  try {
    const now = Date.now()
    writeCache(join(dir, 'tacos', 'usage-cache.json'),
      { five_hour: null, seven_day: null, extra_usage: null, scoped: [] }, { now })
    writeCache(rawCachePath(dir), {
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 92, is_active: true,
          resets_at: '2026-09-19T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    }, { now })
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, `${JSON.stringify({ message: { model: 'claude-fable-5-1' } })}\n`)

    const out = execFileSync('node', [ADVISOR], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: transcriptPath }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })

    assert.doesNotMatch(out, /permissionDecision/)
    const parsed = JSON.parse(out)
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.match(parsed.hookSpecificOutput.additionalContext, /Fable/)
    assert.match(parsed.hookSpecificOutput.additionalContext, /92/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
