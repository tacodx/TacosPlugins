# model-advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `model-advisor`, the second TacosPlugins plugin. It answers one question — would switching models help right now? — and stays silent otherwise.

**Architecture:** A pure bucket-reasoning module in `packages/core`, plus a thin plugin that reads the current model from the transcript and surfaces the answer. Reuses `getGauges`, auth and cache from `usage-guard` unchanged. Never denies anything.

**Tech Stack:** Plain ESM Node (`.mjs`), Node 22+, zero dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-12-model-advisor-design.md` — read it first, especially §3 (non-goals) and §4 (what is verified vs unverified).

## Global Constraints

- **Node 22+.** ESM only, `.mjs`, no build step.
- **Zero runtime and dev dependencies.** Do not run `npm install`.
- **This plugin can never deny.** No code path may emit `permissionDecision`. It emits `additionalContext` or nothing, and always exits 0.
- **Never assert inside an injected mock.** Record what the mock received, let the call return, then assert. Five tests in `usage-guard` passed with the implementation deliberately broken, every one because the assertion ran inside a swallowed callback.
- **Mutation-check every test**: break the code, confirm the test fails, restore. State the result in your report.
- **Every fail-open `catch` carries a one-line comment** at the catch site.
- **`plugins/*/lib/` is tracked in git**, not ignored. After any change under `packages/core/`, run `node scripts/release.mjs` — a test asserts the vendored copies are byte-identical.
- **No cost claims.** Never state or imply that one model consumes more or less than another. The API does not support it.
- **Commits carry NO `Co-Authored-By` trailer and no "Generated with Claude Code" line.**
- Never read or write the real `~/.claude/` tree in tests. No real network requests.

---

### Task 1: `buckets.mjs` — pure bucket reasoning

**Files:**
- Create: `packages/core/buckets.mjs`
- Test: `packages/core/test/buckets.test.mjs`

**Interfaces:**
- Produces `normaliseLimits(raw) -> Bucket[]`, `binding(buckets) -> Bucket|null`, `switchingHelps(buckets, currentModel) -> {helps, reason}`
- `Bucket = { kind, group, percent, model: string|null, resetsAt: string|null, active: boolean }`
- Pure: no fs, no network, no clock.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it and watch it fail** — `node --test packages/core/test/buckets.test.mjs`, expect module-not-found.

- [ ] **Step 3: Implement**

```js
// Number.isFinite, not !isNaN: Infinity is a number and would always win binding(),
// producing a confident "at Infinity%" answer from a malformed payload.
const num = (v) => (Number.isFinite(v) ? v : null)

/** Pure. Tolerates any payload shape; unusable entries are dropped, never defaulted. */
export function normaliseLimits(raw) {
  const list = Array.isArray(raw?.limits) ? raw.limits : []
  return list
    .filter((l) => l && typeof l.kind === 'string' && num(l.percent) !== null)
    .map((l) => ({
      kind: l.kind,
      group: l.group ?? null,
      percent: l.percent,
      model: l.scope?.model?.display_name ?? null,
      resetsAt: l.resets_at ?? null,
      active: l.is_active === true,
    }))
}

/** The bucket closest to exhausted. Ties break toward the active one, then input order. */
export function binding(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null
  let best = null
  for (const b of buckets) {
    if (best === null) { best = b; continue }
    if (b.percent > best.percent) { best = b; continue }
    if (b.percent === best.percent && b.active && !best.active) best = b
  }
  return best
}

/**
 * Switching models helps ONLY when the binding bucket is scoped to the model in use.
 * Anything else — a shared bucket, an unknown model, a bucket scoped to another model —
 * is false. This function never speculates about relative model cost; the API does not
 * support that and inventing it is the confusion this plugin exists to remove.
 */
export function switchingHelps(buckets, currentModel) {
  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) return { helps: false, reason: 'No rate-limit buckets were reported.' }

  // Decide from the SET of buckets at the maximum, not from a single `binding()` pick.
  // With two model-scoped buckets tied at the same percentage, an order-dependent pick
  // flipped this function between true and false for identical inputs.
  const max = Math.max(...list.map((b) => b.percent))
  const atMax = list.filter((b) => b.percent === max)
  const shown = binding(list)

  if (!currentModel || typeof currentModel !== 'string') {
    return { helps: false,
      reason: `The binding limit is ${shown.kind} at ${Math.round(max)}%. The current model could not be determined, so no advice is offered.` }
  }

  // Switching helps only if EVERY bucket at the maximum is scoped to the model in use.
  // If any shared bucket, or one scoped to another model, is equally exhausted, then
  // switching moves you off one ceiling straight onto another.
  const allOurs = atMax.every((b) => b.model && sameModel(b.model, currentModel))
  if (!allOurs) {
    const blocker = atMax.find((b) => !b.model || !sameModel(b.model, currentModel))
    return { helps: false,
      reason: blocker.model
        ? `The binding limit is scoped to ${blocker.model}, not the model in use. Switching would not change it.`
        : `The binding limit is ${blocker.kind} at ${Math.round(max)}%, which every model draws on. Switching models would not change it.` }
  }
  return { helps: true,
    reason: `The binding limit is ${atMax[0].model}'s own weekly allowance at ${Math.round(max)}%. Another model draws on a different allowance, so switching would help right now.` }
}

/**
 * "Fable" matches "fable" and "claude-fable-5-1", but NOT "affable-5" or "unfabled-model-x".
 * A substring test matched both of those and produced a confident, wrong "switching helps".
 * Compare on token boundaries instead, and require every token of the bucket's name to be
 * present. A name made only of digits identifies nothing, so it never matches.
 */
function sameModel(bucketModel, current) {
  if (typeof bucketModel !== 'string' || typeof current !== 'string') return false
  const tokens = (v) => v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const want = tokens(bucketModel)
  if (want.length === 0 || want.every((t) => /^\d+$/.test(t))) return false
  const have = new Set(tokens(current))
  return want.every((t) => have.has(t))
}
```

- [ ] **Step 4: Run it and watch it pass**, then `node scripts/release.mjs && npm test`.

- [ ] **Step 5: Mutation-check.** Make `switchingHelps` return `true` when the model is unknown; confirm a test fails. Make `binding` return the *lowest* percentage; confirm a test fails. Revert `sameModel` to `b.includes(a)`; confirm the false-positive tests fail. Change `num` back to `!Number.isNaN`; confirm the Infinity test fails. Restore each.

- [ ] **Step 6: Commit** — `feat(core): pure bucket reasoning for model advice`

---

### Task 2: `currentModel.mjs` — find the model in use

**Files:**
- Create: `packages/core/current-model.mjs`
- Test: `packages/core/test/current-model.test.mjs`

**Interfaces:**
- `modelFromTranscript(text) -> string|null` — pure, takes file contents
- `stripSuffix(model) -> string` — `claude-opus-5[1m]` → `claude-opus-5`
- `currentModel({ transcriptPath, settingsPath, readFile }) -> string|null` — never throws

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelFromTranscript, stripSuffix, currentModel } from '../current-model.mjs'

const row = (model, ts) => JSON.stringify({ message: { model }, timestamp: ts })

test('takes the most recent model, not the first', () => {
  const text = [row('claude-sonnet-5', '1'), row('claude-opus-5', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('ignores synthetic rows', () => {
  const text = [row('claude-opus-5', '1'), row('<synthetic>', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('tolerates junk lines and returns null when there is no model', () => {
  assert.equal(modelFromTranscript('not json\n{}\n'), null)
  assert.equal(modelFromTranscript(''), null)
})

test('strips a context suffix', () => {
  assert.equal(stripSuffix('claude-opus-5[1m]'), 'claude-opus-5')
  assert.equal(stripSuffix('claude-opus-5'), 'claude-opus-5')
  assert.equal(stripSuffix(null), null)
})

test('falls back to settings when the transcript yields nothing', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? '' : JSON.stringify({ model: 'claude-opus-5[1m]' })),
  })
  assert.equal(m, 'claude-opus-5')
})

test('prefers the transcript over settings', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? row('claude-sonnet-5', '1') : JSON.stringify({ model: 'claude-opus-5' })),
  })
  assert.equal(m, 'claude-sonnet-5')
})

test('never throws; returns null when everything fails', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: () => { throw new Error('nope') },
  })
  assert.equal(m, null)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

```js
import { readFileSync } from 'node:fs'

/** Pure. Last row wins; `<synthetic>` is not a real model. */
export function modelFromTranscript(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    let m
    try { m = JSON.parse(line)?.message?.model } catch { continue } // a partial or junk line tells us nothing
    if (typeof m === 'string' && m !== '' && m !== '<synthetic>') return m
  }
  return null
}

/** `claude-opus-5[1m]` -> `claude-opus-5`. */
export function stripSuffix(model) {
  if (typeof model !== 'string') return null
  const i = model.indexOf('[')
  return i === -1 ? model : model.slice(0, i)
}

/** Never throws. Returns null when the model cannot be determined — the caller stays silent. */
export function currentModel({ transcriptPath, settingsPath, readFile = readFileSync }) {
  const read = (p) => {
    try { return readFile(p, 'utf8') } catch { return null } // unreadable tells us nothing; fall through
  }
  if (transcriptPath) {
    const fromTranscript = modelFromTranscript(read(transcriptPath))
    if (fromTranscript) return stripSuffix(fromTranscript)
  }
  if (settingsPath) {
    const raw = read(settingsPath)
    try { return stripSuffix(JSON.parse(raw)?.model) || null }
    catch { return null } // unreadable or malformed settings tells us nothing
  }
  return null
}
```

- [ ] **Step 4: Run and watch it pass**, then `node scripts/release.mjs && npm test`.

- [ ] **Step 5: Mutation-check.** Make `modelFromTranscript` scan forwards instead of backwards; confirm the "most recent" test fails. Make it accept `<synthetic>`; confirm that test fails. Restore.

- [ ] **Step 6: Commit** — `feat(core): determine the model actually in use`

> Reading only the transcript *tail* is deliberate. `usage-guard` refuses to parse transcripts for usage totals because that number is not calibratable — but a single `message.model` field from the last row is a different thing entirely: one exact value, not an estimate.

---

### Task 3: the plugin — manifest, hook, marketplace entry

**Files:**
- Create: `plugins/model-advisor/.claude-plugin/plugin.json`
- Create: `plugins/model-advisor/hooks/hooks.json`
- Create: `plugins/model-advisor/hooks/advisor.mjs`
- Modify: `.claude-plugin/marketplace.json`
- Test: `packages/core/test/advisor.contract.test.mjs`

**Interfaces:**
- Produces `adviseForHook({ input, buckets, model }) -> { action: 'allow'|'context', text }`
- `adviseForHook` is pure and exported; the `run()` call is behind an `isMain` guard so importing the module for tests executes nothing.

- [ ] **Step 1: Write the failing contract test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adviseForHook } from '../../../plugins/model-advisor/hooks/advisor.mjs'
import { normaliseLimits } from '../buckets.mjs'

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
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Write `advisor.mjs`**

```js
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { normaliseLimits, switchingHelps } = await load('buckets.mjs')
const { currentModel } = await load('current-model.mjs')
const { configDir } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { run, allowOutput, contextOutput } = await load('hookio.mjs')

/** Pure. This plugin informs; it can never deny. */
export function adviseForHook({ input, buckets, model }) {
  const { helps, reason } = switchingHelps(buckets, model)
  if (!helps) return { action: 'allow', text: null }
  return { action: 'context', text: `Model advice: ${reason}` }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) run(async (input) => {
  const dir = configDir(process.env)
  const { raw } = await getGauges({ dir, now: Date.now(), wantRaw: true })
  const buckets = normaliseLimits(raw)
  const model = currentModel({
    transcriptPath: input.transcript_path,
    settingsPath: join(dir, 'settings.json'),
    readFile: readFileSync,
  })
  const { action, text } = adviseForHook({ input, buckets, model })
  return action === 'context' ? contextOutput(input.hook_event_name, text) : allowOutput()
})
```

> **On `wantRaw`.** `getGauges` has seven return paths and its cache stores *normalised*
> gauges, so widening `data` to `{gauges, raw}` would break every one of them and silently
> invalidate existing caches. Do not do that.
>
> Instead follow the pattern `usage.mjs` already uses for the failure cache: write the raw
> `limits[]` to its **own** cache file (`usage-raw.json`) beside the others, with the same TTL
> and the same `readCache`/`writeCache` helpers. `wantRaw: true` then reads that file and adds
> a `raw` key to the returned object; every existing return path keeps its exact current shape,
> and a caller that does not ask for raw is completely unaffected.
>
> Add a test asserting that `getGauges` **without** `wantRaw` returns an object with no `raw`
> key, so a future change cannot start leaking it into `usage-guard`'s path. If the raw cache
> is missing or stale while the gauge cache is fresh, return `raw: null` — `model-advisor`
> treats that as "no buckets" and stays silent, which is the correct degradation.

- [ ] **Step 4: Write `hooks.json`**

One event, explicit timeout, no matcher key.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "timeout": 5, "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/advisor.mjs\"" } ] }
    ]
  }
}
```

- [ ] **Step 5: Write `plugin.json` and add the marketplace entry**

`plugins/model-advisor/.claude-plugin/plugin.json`:

```json
{
  "name": "model-advisor",
  "version": "0.1.0",
  "description": "Tells you whether switching models would actually help your current rate limits.",
  "author": { "name": "tacodx" }
}
```

Add to `.claude-plugin/marketplace.json`'s `plugins` array — `source` **must** start with `./`, or the entry is silently stubbed:

```json
{
  "name": "model-advisor",
  "source": "./plugins/model-advisor",
  "version": "0.1.0",
  "description": "Tells you whether switching models would actually help your current rate limits.",
  "category": "workflow",
  "tags": ["usage", "rate-limits", "models"]
}
```

- [ ] **Step 6: Run** `node scripts/release.mjs && npm test`. The existing manifest test validates the new marketplace entry; the vendoring test now covers a second plugin.

- [ ] **Step 7: Mutation-check.** Make `adviseForHook` return `context` when `helps` is false; confirm the silence tests fail. Restore.

- [ ] **Step 8: Commit** — `feat(model-advisor): advise only when switching models would help`

---

### Task 4: the `/limits` CLI

**Files:**
- Create: `plugins/model-advisor/bin/limits.mjs`
- Create: `plugins/model-advisor/commands/limits.md`
- Create: `packages/core/render-buckets.mjs`
- Test: `packages/core/test/render-buckets.test.mjs`

**Interfaces:**
- `renderBuckets({ buckets, model, effort, helps, reason }) -> string`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBuckets } from '../render-buckets.mjs'
import { normaliseLimits } from '../buckets.mjs'

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

test('renders nothing misleading with no buckets', () => {
  const out = renderBuckets({ buckets: [], model: 'x', effort: null, helps: false,
    reason: 'No rate-limit buckets were reported.' })
  assert.match(out, /no rate-limit buckets/i)
  assert.doesNotMatch(out, /\d+%/)
})
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement `render-buckets.mjs`**, reusing `bar()` from `render.mjs`. Mark the binding bucket. Print `model`, `effort`, then the `reason` sentence verbatim. When `buckets` is empty, print the reason and no percentages.

- [ ] **Step 4: Write `bin/limits.mjs`** — mirror `usage-guard/bin/explain.mjs`: resolve `LIB`, `configDir(process.env)`, fetch with `wantRaw`, normalise, determine the model, call `renderBuckets`, print. Wrap the whole body in try/catch printing a one-line message — this is the tool people run when things look wrong, so it must not stack-trace.

- [ ] **Step 5: Write `commands/limits.md`**

```markdown
---
name: limits
description: Show which rate-limit bucket is binding, and whether switching models would help.
---

Run this command and show the user its raw output verbatim. Do not summarise it or add commentary.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/limits.mjs" "$CLAUDE_SESSION_ID"`
```

- [ ] **Step 6: Run** `node scripts/release.mjs && npm test`, then run the CLI against a scratch `CLAUDE_CONFIG_DIR` with no credentials and confirm it prints a clean message rather than a stack trace. Paste the output into your report.

- [ ] **Step 7: Commit** — `feat(model-advisor): /limits shows the bucket map`

---

### Task 5: README and limitations

**Files:**
- Create: `plugins/model-advisor/README.md`
- Modify: `README.md` (add to the plugin list)
- Test: extend `packages/core/test/docs.test.mjs`

- [ ] **Step 1: Write the failing test** — assert `plugins/model-advisor/README.md` exists, contains a Limitations section, states that the plugin never denies anything, and does **not** contain any cost comparison language (`/cheap|expensive|costs? (more|less)/i`).

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Write the READMEs.** The plugin README must cover what it does, `/limits`, the single `UserPromptSubmit` hook, and a Limitations section stating plainly:

  - It **never denies anything** — `usage-guard` is the plugin with teeth.
  - It makes **no claim about relative model cost**. That is not derivable from the usage API, and inventing it is the confusion this plugin exists to remove.
  - It does **not** recommend a model for a task. It has no view on whether your work needs a large model.
  - Whether a model-scoped bucket also draws on the shared weekly bucket is **unverified**.
  - Bucket shapes vary by plan tier; the plugin reads whatever `limits[]` contains and asserts nothing about which buckets should exist.
  - The current model is read from the transcript tail, falling back to `settings.json`. If neither yields a model, the plugin stays silent rather than guessing.
  - Same undocumented endpoint, same fail-open behaviour, same 2.1.220-only testing as `usage-guard`.

- [ ] **Step 4: Run** `node scripts/release.mjs && npm test`.

- [ ] **Step 5: Commit** — `docs(model-advisor): readme with limitations stated plainly`
