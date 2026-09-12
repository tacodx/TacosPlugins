# TacosPlugins — `model-advisor` design

**Date:** 2026-09-12
**Status:** Design written, not yet implemented
**Scope:** The second TacosPlugins plugin. Reuses `packages/core` unchanged.

---

## 1. Problem

The repo owner always runs Opus 5 at max effort, and said why: *"im scared of fable 5/5.1 to
explode my usage or waste it on something that couldve been done with another model."*

That is a decision made from fear rather than information, and it is expensive in both
directions — it may waste a large model on small work, or avoid a model that would have been
free of the constraint that actually binds.

The information needed to decide already exists in the usage API. Nobody surfaces it.

## 2. What this plugin does

It answers exactly one question, honestly:

> **Would switching models help me right now?**

That question *is* answerable from the API. Rate limits are grouped into buckets, and some
buckets are scoped to a specific model:

- If the binding constraint is **`weekly_all`** or **`session`**, switching models does **not**
  help — every model draws on those.
- If the binding constraint is a **`weekly_scoped`** bucket for the model currently in use,
  switching away from that model **does** help.

That distinction is the whole product.

## 3. Non-goals

Recorded explicitly so they are not quietly reintroduced.

| Rejected | Why |
|---|---|
| Claiming one model is "cheaper" than another | Not derivable from this API. Any ratio would be invented. |
| Recommending a model for a particular task | Requires judging the work, which is not a rate-limit question. The plugin has no view on whether your task needs Opus. |
| Estimating tokens or cost | Same reason `usage-guard` refuses to: the conversion is not calibratable. |
| Blocking or denying anything | `usage-guard` is the plugin with teeth. This one only informs. It must never return a `deny`. |
| Nagging | Silent unless the answer is actionable. |

## 4. Verified facts

Probed 2026-09-12 against a `max` / `default_claude_max_5x` account. `limits[]` contained
exactly three entries:

| `kind` | `group` | `scope.model` | observed |
|---|---|---|---|
| `session` | `session` | — | 13% |
| `weekly_all` | `weekly` | — | 40%, `is_active: true` |
| `weekly_scoped` | `weekly` | **Fable** | 22%, `is_active: false` |

`seven_day_opus` and `seven_day_sonnet` are `null` — **no Opus- or Sonnet-scoped bucket exists
on this plan.** So for this account, an Opus user is constrained only by the shared buckets,
while a Fable user additionally has a separate Fable-only weekly allowance.

**Explicitly unverified, and the plugin must not assert either way:**
- Whether Fable usage *also* draws on `weekly_all`.
- The relative cost of any two models.
- Whether the scoped-bucket shape is the same on other plan tiers.

Where the plugin cannot know, it says so rather than guessing.

## 5. Finding the current model

The hook payload does **not** contain the model. Re-confirmed against Claude Code 2.1.220 —
the base payload is exactly
`{session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort}`.

Two sources, in order:

1. **The transcript tail.** `transcript_path` is in the payload; the most recent row carrying
   `message.model` gives what is *actually* running. Read the tail only — do not parse the
   whole file. Ignore `<synthetic>`.
2. **`settings.json`'s `model` key**, as a fallback. Note it may carry a context suffix
   (observed: `claude-opus-5[1m]`) which must be stripped before matching.

If neither yields a model, the plugin is **blind on model** and stays silent. It never guesses.

`effort` *is* in the hook payload, but it is **not displayed anywhere in the shipped plugin**
and does not drive any advice. `/limits` is a slash command, so no hook payload reaches it and
it cannot know the effort level; printing a permanent "could not be determined" placeholder on
every invocation reads as a broken tool rather than a limitation of the surface, so the line
was removed. Effort is a quality lever regardless, and this plugin does not trade quality for
budget any more than `usage-guard` does.

## 6. Architecture

Reuses `packages/core` unchanged — `getGauges`, the cache, auth, and `configDir`. The only new
core module is bucket reasoning.

```
packages/core/
  buckets.mjs          NEW — pure: raw limits[] -> which bucket binds, and is it model-scoped
plugins/model-advisor/
  .claude-plugin/plugin.json
  hooks/hooks.json     UserPromptSubmit only
  hooks/advisor.mjs
  bin/limits.mjs       the /limits CLI
  commands/limits.md
  lib/                 vendored from packages/core, TRACKED IN GIT
```

`lib/` is tracked, not gitignored. That mistake cost `usage-guard` a Critical finding: the
published plugin could not run at all, because nothing regenerates vendored code at install
time. `scripts/release.mjs` already vendors into every directory under `plugins/`, and a test
already asserts byte-identical copies.

### `buckets.mjs` — pure

- `normaliseLimits(raw) -> Bucket[]` where `Bucket = {kind, group, percent, model|null, resetsAt, active}`
- `binding(buckets) -> Bucket | null` — the bucket closest to exhausted. Ties broken by
  `is_active`, then by the order the API returned.
- `switchingHelps(buckets, currentModel) -> {helps: boolean, reason: string}` —
  `true` only when the binding bucket is `weekly_scoped` **and** its `scope.model` matches the
  current model. Anything else is `false`, including "we don't know the current model".

Pure means no fs, no network, no clock. Same discipline as `decide.mjs`.

## 7. Behaviour

**`UserPromptSubmit`** — silent in every case except one: the binding bucket is scoped to the
model currently in use. Then it injects one line saying so, naming the bucket and its
percentage, and noting that another model draws on a different allowance.

Silence is the default because a context line every turn is a tax paid on every request. The
plugin earns its place by speaking rarely.

**`/limits`** (`commands/limits.md`, frontmatter `name: limits`, so both
`/model-advisor:limits` and bare `/limits` resolve) — prints the full bucket map: every
bucket, its percentage, its scope, which one binds, the current model, and a plain sentence
answering whether switching would help. It does **not** print effort — see §5.

A bucket scoped to a model other than the one in use is listed but never marked as binding,
because it cannot constrain the current session. The bucket named in the sentence and the
bucket carrying the marker are always the same one; they come from a single decision.

**No `PreToolUse` hook.** This plugin never gates a tool call. Registering there would add a
process spawn per tool call for no benefit.

## 8. Failure behaviour

Inherits `usage-guard`'s discipline, with one simplification: since this plugin can never deny,
every failure path is simply silence.

- No credentials, API error, stale cache, unreadable config, unknown model → say nothing.
- The hook must **never** emit a `permissionDecision`. It emits `additionalContext` or nothing.
- Every path exits 0.
- Explicit hook `timeout` — the 600s default is a trap.

## 9. Testing

Same rules that caught the defects in `usage-guard`:

- `buckets.mjs` is pure, so its tests are a table with no fs or network.
- **Never assert inside an injected mock** — record, return, then assert. Five tests in
  `usage-guard` passed while the implementation was deliberately broken, every one of them
  because the assertion ran inside a swallowed callback.
- **Mutation-check every test**: break the code, confirm the test fails, restore. A test that
  cannot fail is worse than no test, because it reads as coverage.
- Fixtures captured from the real API, including the shapes already seen to be awkward: `null`
  gauges, a `weekly_scoped` entry, and `limits` absent entirely.

## 10. Open questions

- Whether Fable draws on `weekly_all` as well as its own bucket. Determines whether "switching
  helps" is the full story or only half of it. Needs observation over time, not a single probe.
- Whether other plan tiers expose Opus- or Sonnet-scoped buckets. The code must not assume the
  three-bucket shape seen here; it reads whatever `limits[]` contains.
