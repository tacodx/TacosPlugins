# usage-guard

A Claude Code plugin that reads your account's real, server-side usage gauges
and lets each chat carry its own budget against them. When a chat crosses its
ceiling, `usage-guard` stops *new* work from starting in that chat — it does
not touch the model's output, quality, or effort.

## What it does

Claude Code has no visibility into your account's rate-limit gauges during a
session — the number simply isn't in the hook payload. A chat can happily
launch a large multi-agent fan-out at 79% usage and hit the wall two minutes
later. `usage-guard` fetches the real gauges, caches them, and enforces a
per-chat ceiling against them:

- **Below the soft threshold** — nothing happens. No context tax, no noise.
- **At the soft threshold** — a short advisory is injected into the
  conversation: finish what's in flight, don't start new large-scope work,
  prefer a couple of targeted agents over broad fan-out. New agent/workflow
  fan-out (`PreToolUse` on `Agent`, `Workflow`, or `Task`) is denied; agents
  already running are unaffected.
- **At the hard ceiling** — new tool calls are denied outright so the chat
  winds down. Work already in flight still completes; see Limitations.

The soft layer only ever changes **scope and waste**. It never asks the model
to lower quality, switch model, shorten reasoning, or skip verification —
budget pressure is not a reason to do the work worse, because work redone
costs more than work done right once.

## The four gauges

One API call returns all of these; `usage-guard` reads and can enforce
against each independently:

| Gauge | What it tracks | Default soft / hard |
|---|---|---|
| `five_hour` | The rolling 5-hour session window | 75% / 90% |
| `seven_day` | The rolling weekly window | 60% / 80% |
| `extra_usage` | Metered spend (extra usage / credits), on plans that have it | 70% / 85% |
| `scoped` | Per-model weekly buckets | disabled by default |

`scoped` is rendered when your account reports it (with each model's
percentage) but is **informational only** — see Limitations.

## `/budget`

```
/budget                 show this chat's gauges, thresholds, and what would happen right now
/budget 80               set this chat's 5-hour ceiling to 80% (soft is set 15 points below)
/budget weekly 70        set this chat's weekly ceiling
/budget money 60         set this chat's extra-usage (spend) ceiling
/budget off               disable the guard for this chat
/budget on                 re-enable enforcement for this chat
```

`/budget` with no arguments prints the raw, current picture — gauge
percentages, this chat's thresholds, and the decision the guard would make
right now. Settings made through `/budget` apply to **this chat only**, via a
per-session file; they never change the shared account gauge, and they never
change another chat's settings.

## Config file and defaults

Account-wide defaults live in a JSON file you create by hand at
`${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/config.json`. There is no command that
writes this file for you — `/budget` only ever writes the per-chat session
file. If the file is absent, the shipped defaults below apply exactly as
shown — this is the literal default, not an example:

```json
{
  "mode": "enforce",
  "gauges": {
    "five_hour":   { "soft": 75, "hard": 90 },
    "seven_day":   { "soft": 60, "hard": 80 },
    "extra_usage": { "soft": 70, "hard": 85 },
    "scoped":      { "enabled": false }
  }
}
```

`mode` is one of:

- `enforce` — the shipped default. The guard can deny tool calls.
- `dry-run` — gauges are still fetched and the advisory is still injected at
  the soft threshold, but nothing is ever denied.
- `off` — the guard does nothing.

**Any gauge may also carry `"enforce": false`** to make it watch-only, e.g.:

```json
"extra_usage": { "soft": 70, "hard": 85, "enforce": false }
```

A watch-only gauge is still fetched and still shown in `/budget` and
`explain` output with its live percentage (marked `(watch-only)`), but it can
never itself produce a denial — useful for keeping an eye on a gauge without
letting it ever block anything. This is not the shipped default for any of
the three threshold gauges (only `scoped` ships off, via `enabled: false`,
which is a different, currently non-functional flag — see Limitations); you
opt a gauge into watch-only yourself. It is independent of the top-level
`mode`: a watch-only gauge stays watch-only even in `enforce` mode, and
`mode: "dry-run"` already suppresses every denial account-wide regardless of
any gauge's own `enforce` flag.

**An unreadable config degrades to `dry-run`, not to enforcing.** If
`config.json` (or a per-chat session file) exists but cannot be parsed —
corrupt JSON, a permissions problem, anything other than "the file simply
isn't there yet" — the guard does not silently fall back to the shipped
enforce defaults on data it couldn't actually read. It degrades the running
mode to `dry-run` for that chat and says so: both `/budget` and `explain`
print a line stating the config could not be read and the guard is observing
only. A file that is genuinely missing (`ENOENT`) is not this case — that's
just "no config yet," and the normal defaults apply.

## Dry-run first

**The shipped default is `enforce`, not `dry-run`.** The guard can start
denying tool calls the moment it's installed, using the default thresholds
above. If you want to see what it *would* do before it can block anything,
create `${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/config.json` by hand with
`"mode": "dry-run"` first, run your usual sessions, check `/budget` or
`explain` to see the gauges and the decision it would have made, and only
then switch to `"mode": "enforce"` (or delete the file to accept the
enforcing defaults). There is currently no `/budget` subcommand that sets
`dry-run` — only `off` and `on` (which means `enforce`) are reachable from
the slash command; `dry-run` is config-file-only.

## `explain`

```
node <plugin-root>/bin/explain.mjs [sessionId]
```

Prints the same status block as `/budget` with no arguments — current gauge
percentages, this chat's thresholds, and the decision the guard would make —
but as a standalone script you can run from a shell, outside of any hook or
slash command. Pass a session ID to see that chat's per-session overrides;
omit it to see the account-wide picture. Useful for checking whether the
guard is actually seeing real data (as opposed to reporting itself blind) and
for debugging why a chat is or isn't being throttled.

## Limitations

Read this before you install something that reads your credentials and can
block your own tool calls.

- **The usage endpoint is undocumented and may break without notice.** The
  plugin reads `https://api.anthropic.com/api/oauth/usage`, which is not a
  published, stable API. Anthropic can change or remove it at any time, and
  this plugin would have no advance warning.

- **The guard always fails open.** Missing credentials, an API error, a
  failed token refresh, a stale cache past its maximum age, an unreadable
  config, lock contention, a hook timeout — every one of these allows the
  call. It will never block you because it broke. The corollary: a broken
  guard silently protects nothing. If you care whether it's actually working,
  check `explain` — it tells you plainly when it's blind or degraded.

- **A workflow already running when the ceiling is crossed will finish.**
  The guard gates the *start* of new work at `PreToolUse`; it cannot abort a
  tool call already in flight, and it cannot know a turn's cost in advance.
  Denying new fan-out slows the next request, not the current one.

- **`RemoteTrigger` and `bareFork` agent spawns bypass `PreToolUse`
  entirely.** Fan-out started through those paths is not covered by this
  guard at all — no advisory, no denial, regardless of gauge state.

- **macOS credential storage is unverified.** The plugin reads
  `~/.claude/.credentials.json` directly. Other tools document a macOS
  Keychain entry for these credentials, but that entry does not appear in
  Claude Code 2.1.220, and reading credentials from the Keychain on macOS was
  not tested on an actual Mac. Treat macOS as best-effort, not verified.

- **The 5-hour limit is account-wide, not per-chat.** A budget set with
  `/budget` is a ceiling on the *shared* account gauge — every chat, every
  tool call, every subagent on the account draws down the same number. It is
  not a private quota carved out for one chat; another chat (or another
  application using the same account) can still push the shared gauge past
  your ceiling. See the config section above.

- **The per-model (`scoped`) buckets are the least documented part of the
  API response** and ship disabled by default. They are rendered as
  informational percentages when your account reports them, but do not
  currently drive any deny decision.

- **Tested against Claude Code 2.1.220 only.** The hook payload shape, the
  matcher semantics for `hooks.json`, and the exact set of tool names used
  for agent/workflow fan-out (`Agent`, `Workflow`, `Task`) are all specific
  to that version and could change in a future Claude Code release.

None of this is a promise the guard is airtight. It's a monitor with a
best-effort brake: honest about what it fails to catch is the whole point.
