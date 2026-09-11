# TacosPlugins — `usage-guard` design

**Date:** 2026-09-11
**Status:** Design approved, not yet implemented
**Scope:** The TacosPlugins marketplace repo + the first plugin, `usage-guard`.
`model-advisor` is sketched at the end but gets its own spec.

---

## 1. Problem

Claude Code accounts have rolling usage limits — a 5-hour session window, a weekly window,
and (for some plans) a metered euro/dollar spend pool. A user running several chats at once
has no way to say *"this chat is the important one, let the side chats yield to it."*

Claude itself is blind to the gauge: the number is not in the hook payload, so a chat will
happily launch a twelve-agent fan-out at 79% and hit the wall two minutes later.

`usage-guard` makes the account's real usage visible to the model and enforces a per-chat
ceiling against it.

### Motivating scenario

> chat-1 is a large multi-agent project. chat-2 and chat-3 are side work. Give chat-1 a 90%
> ceiling and the side chats 50%, and the side chats stop early, leaving the window for the
> work that matters.

---

## 2. Goals

- Make the true, server-side usage gauges visible to the model during a session.
- Let each chat carry its own ceiling, set at runtime.
- Prevent *new* expensive work from starting near the ceiling.
- Never make the assistant's output worse.
- Never block the user because the plugin itself failed.

## 3. Non-goals

These were considered and deliberately rejected. They are recorded here so they are not
quietly reintroduced during implementation.

| Rejected | Why |
|---|---|
| Degrading quality near budget (lower effort, weaker model, terser output, skipped verification) | Budget-negative. Work done badly gets redone, and the redo costs more than doing it right once. The guard governs **scope and waste**, never quality. |
| A per-chat "you used X% of the window" estimate | Not computable honestly. Tokens→percent varies 24–45× across real samples; any figure would be invented. Dropped entirely, so the plugin never parses transcripts. |
| Enforcing on transcript-derived attribution | Same reason — enforcement must rest only on the exact server gauge. |
| Aborting a turn already in flight | A hook gates tool calls; it cannot cancel an in-flight request, and cannot know a turn's cost in advance. |

---

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | One marketplace repo, multiple plugins, shared core vendored at release | Suite is expected to grow; plugins stay independently installable |
| D2 | Two-stage enforcement: advisory soft threshold, hard ceiling | Matches "don't start big work at 75%, stop at 80%" with a graceful wind-down |
| D3 | Soft layer may change **scope and waste only**, never quality knobs | See non-goals |
| D4 | Budget is a **ceiling on the shared account gauge**, not a per-chat quota | The shared gauge is server truth; per-chat attribution is not |
| D5 | Govern all four gauges: 5-hour, weekly, extra-usage (money), per-model scoped | One API call returns all of them; supporting several is nearly free |
| D6 | Fail open, always | A monitoring plugin that bricks a session on an API hiccup is worse than no plugin |
| D7 | No transcript parsing at all | Follows from dropping the per-chat estimate |

---

## 5. Repository layout

```
TacosPlugins/
├── .claude-plugin/marketplace.json
├── packages/core/                    # source of truth for shared code
│   ├── usage.mjs                     # fetch + normalise all gauges
│   ├── auth.mjs                      # credential read, refresh, write-back
│   ├── cache.mjs                     # TTL cache + file lock
│   └── hookio.mjs                    # stdin parse, decision JSON, safe exit
├── plugins/
│   ├── usage-guard/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json
│   │   ├── hooks/guard.mjs
│   │   ├── commands/budget.md
│   │   ├── statusline.mjs            # OPTIONAL — only warms the cache (see §6)
│   │   └── lib/                      # vendored copy of packages/core
│   └── model-advisor/                # later, separate spec
├── scripts/release.mjs               # vendors packages/core into each plugin's lib/
└── docs/superpowers/specs/
```

**Language:** plain ESM Node (`.mjs`), no build step, zero runtime dependencies. Node 22 is
the baseline. No-deps matters because Claude Code does not run `npm install` for a plugin at
install time.

**Vendoring.** Claude Code installs each plugin as a self-contained directory, so
`plugins/usage-guard/` cannot import from a sibling `packages/core/` at runtime.
`scripts/release.mjs` copies core into each plugin's `lib/` on release. The repo stays DRY;
the installed plugin stays self-contained. Publishing core to npm was rejected — it assumes
an install step that is not guaranteed.

### marketplace.json

Verified schema requirements:

- `name`, `owner`, `plugins` are all **required**; omitting `owner` fails the whole marketplace load.
- Each `plugins[]` entry needs `name` + `source`.
- `source` **must start with `./`** — `"plugins/foo"` fails schema validation and the entry is
  silently stubbed as `unsupported`.
- `source` resolves against the directory *containing* `.claude-plugin/`, not `.claude-plugin/` itself.
- Keep a real `plugin.json` per plugin (do not use `strict: false`), and put the authoritative
  `version` there — it beats the marketplace entry's value.
- The marketplace `name` must be kebab-case and must not impersonate Anthropic/Claude.

---

## 6. Data layer

### The cache is the interface

```
   ┌─ (optional) tacos statusline ─┐
   │  receives rate_limits free    │──┐
   └───────────────────────────────┘  │   ~/.claude/tacos/usage-cache.json
                                      ├──▶ { five_hour, seven_day, extra_usage,
   ┌─ guard hook, TTL ~60s ────────┐  │      scoped, fetched_at }
   │  GET /api/oauth/usage + lock  │──┘              │
   └───────────────────────────────┘                 ▼
                             hooks read it — never fetch on the hot path
```

The hook must be able to fill the cache itself, because `settings.json` allows exactly **one**
`statusLine.command` and many users (including the author) already run something else there —
the OMC HUD. A statusline-only design would leave the guard permanently blind for those users.
Our statusline is therefore optional and merely warms the same cache.

### Source of truth

`GET https://api.anthropic.com/api/oauth/usage`

Headers: `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`,
`Content-Type: application/json`.

Returns `five_hour`, `seven_day`, `extra_usage`, and a `limits[]` array of
`{kind, group, percent, severity, resets_at, scope, is_active}`. Per-model buckets appear as
`weekly_scoped` entries with a `scope.model.display_name`.

`extra_usage` encodes money as minor units: `used_credits: 5048` with `decimal_places: 2` and
`currency: "EUR"` means €50.48. Never render `used_credits` raw.

> This endpoint is **internal and undocumented**. It may change without notice. The plugin
> must degrade gracefully — see §9 — and the statusline path (`rate_limits` on stdin) is the
> supported fallback where available.

### Credentials and refresh

- Read from `${CLAUDE_CONFIG_DIR ?? ~/.claude}/.credentials.json`, key `claudeAiOauth`.
  **No tilde expansion** — resolve the home directory properly.
- Treat the token as expired when `now + 300_000ms >= expiresAt` (Claude Code's own 5-minute
  margin). Do not copy OMC's zero margin.
- Refresh: `POST https://platform.claude.com/v1/oauth/token` (note: *not* api.anthropic.com),
  `Content-Type: application/json`, body
  `{grant_type: "refresh_token", refresh_token, client_id, scope}`.
  Default `client_id` is the public Claude Code client, overridable by `CLAUDE_CODE_OAUTH_CLIENT_ID`.
- **Write-back is mandatory** — refresh tokens rotate. The response may omit `refresh_token`,
  in which case keep the old one. The write must be read-modify-write into `claudeAiOauth`,
  preserving sibling keys (the same file holds `mcpOAuth` server tokens), via a temp file at
  mode `0600` then rename.
- Concurrency: guard the cache and the credential write with a file lock that breaks stale locks.

### Cache policy

- TTL ~60s on success.
- Short backoff on failure; longer backoff on repeated 429.
- Hard maximum staleness, after which data is discarded rather than served.
- On discard the guard reports itself **blind** and allows everything.

---

## 7. Hooks

| Event | Matcher | Timeout | Behaviour |
|---|---|---|---|
| `SessionStart` | — | 5s | Resolve this chat's budget; warm cache |
| `UserPromptSubmit` | — | 5s | Refresh if stale. Below soft: inject nothing. Above soft: inject status. Above ceiling: deny |
| `PreToolUse` | `Agent\|Workflow` | 5s | Above soft: deny **new** fan-out with a reason |
| `PreToolUse` | *(matcher key omitted)* | 5s | Above ceiling: deny, so the chat winds down |

> **Do not write `"matcher": "*"` for the all-tools entry.** A matcher containing characters
> outside `[A-Za-z0-9_|,-]` is compiled as a JS RegExp, and a lone `*` is an *invalid* regex
> ("nothing to repeat"). An invalid matcher is logged only in verbose mode and returns false —
> so the ceiling would silently never fire. Omit the `matcher` key to match all tools.

### Verified hook facts

- Hook stdin carries `{session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id,
  agent_type, effort}`; `PreToolUse` adds `{tool_name, tool_input, tool_use_id}`.
  **There is no `rate_limits` field** — hence the cache.
- `tool_name` for subagents is always the literal `"Agent"`. `"Task"` exists only as a
  matcher-side alias; a script comparing `tool_name === "Task"` silently never fires.
- The **`Workflow` tool spawns agents inside its own script body** under `tool_name: "Workflow"`.
  Matching only `Agent` lets that through entirely. Hence `"Agent|Workflow"`.
- A matcher containing only `[A-Za-z0-9_|,-]` is split on `|` and compared as **exact strings**,
  not as a regex. Do not write `^(Agent|Task)$` — parentheses force the fragile regex path, and
  an invalid regex fails silently.
- Known coverage gap: `agent()` calls made inside a `Workflow` script are covered by matching the
  `Workflow` tool call itself, but a workflow already running when the ceiling is crossed will
  finish. `RemoteTrigger` and `bareFork` agent spawns bypass `PreToolUse` entirely. Document this
  rather than pretend to airtightness.

### Plugin script paths

- Reference bundled scripts as `"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs\""`.
- Use the **braced** `${CLAUDE_PLUGIN_ROOT}`; bare `$CLAUDE_PLUGIN_ROOT` breaks in exec form and on PowerShell.
- **Quote it** — shell-form commands go through `/bin/sh -c`, and the plugin root lives under the
  user's home directory, which may contain spaces.
- `cwd` at hook time is the **user's project directory**, not the plugin root. Derive paths from
  `process.env.CLAUDE_PLUGIN_ROOT` inside the script.
- `${CLAUDE_PLUGIN_ROOT}` is plugin-only; using it in a plain `settings.json` hook is a hard error.
- The value is version-pinned (`.../usage-guard/1.0.0`) and can go stale across an upgrade mid-session.
  Each script begins with a defensive existence check.

---

## 8. Behaviour

### Below the soft threshold

Nothing is injected. No context tax, no noise. The chat behaves exactly like an unbudgeted one.

### At the soft threshold

Injected via `additionalContext`, approximately:

```
5h window at 76%, this chat's ceiling is 80%.
Finish the current task properly.
Do NOT start new large-scope work.
Prefer 2 targeted agents over broad fan-out.
Do NOT reduce effort, switch model, or cut corners on work already underway.
```

`PreToolUse` on `Agent|Workflow` denies **new** fan-out with a readable reason. In-flight
subagents are unaffected — `agent_id`/`agent_type` in the payload distinguish them.

### At the ceiling

`PreToolUse` denies with
`{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"..."}}`.
The current turn completes; nothing new starts.

---

## 9. Failure modes — always open

Every one of these **allows** the call and never blocks: missing credentials, API error,
expired token whose refresh failed, cache stale past maximum, malformed config, lock
contention, hook timeout, plugin root missing.

Verified: Claude Code command hooks already fail open on every outcome **except `exit 2`**.
Non-zero-but-not-2, malformed stdout, missing script, and timeout all proceed. So fail-open
is the default and must not be re-engineered — but three traps must be avoided:

1. **Never `exit 2`,** and never emit `permissionDecision: "deny"` from an error path. Wrap the
   whole script so every path ends in `exit 0`. An uncaught exception that happens to exit 2
   would deny every matching tool call.
2. **Always set an explicit `"timeout"`** (in seconds) on every hook entry. The default for
   `PreToolUse` is **600 seconds** — on an API stall the session would sit for ten minutes
   before failing open. The script's own internal deadline must be shorter than the declared
   timeout, so it exits 0 with empty output rather than being killed.
3. When blind, say so **once per session** rather than silently implying 0% usage.

---

## 10. Configuration

Three layers, most specific wins:

```
1. plugin defaults
2. ~/.claude/tacos/config.json
3. per-chat override, keyed by session_id
```

```json
{
  "gauges": {
    "five_hour":   { "soft": 75, "hard": 90 },
    "seven_day":   { "soft": 60, "hard": 80 },
    "extra_usage": { "soft": 70, "hard": 85 },
    "scoped":      { "enabled": false }
  },
  "mode": "enforce"
}
```

`soft` and `hard` are the two thresholds from §8: `soft` is the advisory point, `hard` is the
ceiling. Both are percentages of that gauge. A gauge may set `soft` equal to `hard` to skip the
advisory stage, or omit the gauge entirely to leave it ungoverned.

Defaults are deliberately **not uniform**: weekly is tighter than the 5-hour window.
Overshooting the session window costs hours; overshooting the weekly costs days. The gauge
with the worse failure mode gets the earlier brake.

### The `/budget` command

Ships as `commands/budget.md` with frontmatter `name: budget`, which registers **both**
`/usage-guard:budget` (canonical) and bare `/budget` (convenience alias).

The bare form is a soft fallback: it loses to built-ins and to any other command genuinely
named `budget`, and among competing aliases the winner is load-order-dependent. Documentation
therefore leads with the namespaced form. A `/tp-budget` fallback is **not** needed.

Usage:

```
/budget 80            set the 5h ceiling for this chat
/budget weekly 70     set the weekly ceiling for this chat
/budget off           disable the guard for this chat
/budget               show current gauges, resolved thresholds, and what would happen now
```

Per-chat state lives at `~/.claude/tacos/sessions/<session_id>.json`, garbage-collected after
7 days.

> Note: setting `commands` in `plugin.json` disables `./commands/` auto-discovery. Leave it unset.

---

## 11. Safety valves

A budget guard cannot realistically be tested by burning to 80% of a real window.

- **`mode: "dry-run"`** — evaluates and logs every decision but never denies. Run for a day,
  confirm the decisions were right, then switch to `enforce`.
- **`usage-guard explain`** — the same report as bare `/budget`, but as a shell command, so it
  can be run outside a session or from a script. `/budget` is the in-chat view of this; both
  render from one function in the core.

---

## 12. Testing

- **Decision core** is pure functions (gauge values + thresholds → decision). Table-driven unit
  tests, zero network.
- **Fixtures** captured from the real API and sanitised, deliberately including the awkward
  shapes already observed: `null` gauges, the `weekly_scoped` bucket, the `decimal_places`
  currency encoding, the enterprise variant, and a payload with `rate_limits` absent.
- **Hook I/O contract tests** feed real captured hook stdin and assert exact stdout JSON,
  including that every error path exits 0.
- **Runner:** `node --test`. Built in, no dependency, consistent with the no-build-step decision.

---

## 13. Open questions

- **macOS credential storage.** OMC reads a `Claude Code-credentials` Keychain entry, but that
  string does not appear in Claude Code 2.1.220 and the code path that would have written it is
  dead. The real macOS location must be verified on an actual Mac before cross-platform support
  is claimed. Until then, macOS is best-effort with a clear fallback message.
- **Endpoint stability.** `/api/oauth/usage` is undocumented. Needs a version-drift check and a
  clean "unsupported response shape" path.
- **Scoped buckets.** `weekly_scoped` shape varies by plan tier and is the least documented part
  of the response; ship it behind `scoped.enabled: false` by default.

---

## 14. Later: `model-advisor` (own spec)

Sketch only — not in scope here. Hook payload already carries `effort`, and the statusline
carries the current model, so an advisor can see both. The motivating observation is that the
account exposes a **separate weekly bucket scoped per model**, which means using a different
model may not draw on the gauge the user fears. The advisor would surface that rather than
guess. It reuses `packages/core` unchanged.
