# model-advisor

A Claude Code plugin that answers one question, from your account's real
rate-limit data: **would switching models help right now?**

The problem it exists for is the guess people make instead: run the biggest
model at max effort for everything, because a smaller model might turn out to
be the wrong call and there's no way to tell in advance whether it would even
matter. That guess goes wrong in both directions — it can waste a large
model on work that didn't need it, or avoid a model that was never actually
going to be the constraint. `model-advisor` replaces the guess with the one
fact the usage API actually contains: which rate-limit bucket is closest to
exhausted, and whether that bucket is shared across every model or scoped to
the one you're currently running.

## What it does

Claude Code's account usage is grouped into buckets. Some are shared — every
model draws on them — and some are scoped to one specific model. The whole
of this plugin's logic is:

- Find the bucket closest to exhausted (the one that's actually binding).
- If it's a shared bucket (observed so far: `session`, `weekly_all`),
  switching models changes nothing — every model draws on it, so it stays
  right where it is.
- If it's a bucket scoped to the model you're currently running, switching
  to a different model moves you off that ceiling onto a separate one.
- If it's scoped to some other model instead, switching there wouldn't help
  either — you'd just be trading your current ceiling for one that's
  already just as exhausted.

That's the entire decision. It is made by pure functions in
`packages/core/buckets.mjs` (vendored into this plugin's `lib/`), reading
whatever `limits[]` the account reports — see Limitations for what those
functions refuse to do.

## `/limits`

```
/limits
```

Prints every bucket the account reports, which one is binding, the model
currently detected, and a plain sentence saying whether switching would help.
Both samples below are real output, captured against a scratch config
directory seeded with fabricated cache files — not typed by hand.

Binding bucket is scoped to the model in use — switching would help:

```
model-advisor: /limits

  model:  claude-fable-5-1

  session          [===...........]  20%  scope: shared     (inactive)
  weekly_all       [=====.........]  35%  scope: shared     (active)
  weekly_scoped    [=========.....]  61%  scope: Fable      (inactive)  <- binding

  switching models: would help right now.
  The binding limit is Fable's own weekly allowance at 61%. Another model draws on a different allowance, so switching would help right now.
```

Same three bucket kinds, different percentages — this time the shared
`weekly_all` bucket binds, so switching would not help:

```
model-advisor: /limits

  model:  claude-fable-5-1

  session          [==............]  13%  scope: shared     (inactive)
  weekly_all       [======........]  40%  scope: shared     (active)  <- binding
  weekly_scoped    [===...........]  22%  scope: Fable      (inactive)

  switching models: would not help right now.
  The binding limit is weekly_all at 40%, which every model draws on. Switching models would not change it.
```

Notice there's no `effort:` line in either sample — see Limitations for why
it's omitted rather than faked.

## The hook

`hooks/hooks.json` registers exactly one hook, `UserPromptSubmit`, running
`hooks/advisor.mjs`. There is no `PreToolUse` hook — this plugin never gates
a tool call, so there is nothing for one to do.

The hook is silent on almost every turn. It speaks only in the one case
`/limits` calls "would help right now": the binding bucket is scoped to the
model currently in use. Using the same fabricated data as the first `/limits`
sample above, the hook's real captured output is:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Model advice: The binding limit is Fable's own weekly allowance at 61%. Another model draws on a different allowance, so switching would help right now."}}
```

Feed it the second sample's data instead — the shared bucket binding, same
model — and stdout is empty. Nothing is written, nothing is decided, the
prompt goes through untouched.

The reason for the silence is the same reasoning `usage-guard` uses for its
own soft threshold: a line of context on every single turn is a tax paid on
every request, whether or not it changes anything. This plugin earns the
right to speak by speaking rarely, only when the answer is something you'd
actually act on.

## Limitations

Read this before deciding whether to install it.

- **It never denies anything.** `usage-guard` is the plugin with teeth —
  it's the one that can stop a tool call. This plugin only informs. Every
  code path in it ends in either a line of context or nothing at all; there
  is no `deny` output anywhere in its source, and a test asserts that no
  combination of inputs produces one. That's true of every path this plugin
  can actually reach — `lib/hookio.mjs` (vendored, shared with `usage-guard`)
  does export a `denyOutput` function, so a grep for it will find one, but
  this plugin never imports or calls it.

- **It makes no claim about relative model cost.** The usage API does not
  expose how one model's usage compares to another's, and inventing a ratio
  is exactly the confusion this plugin exists to remove. If you're trying to
  learn whether one model draws down your account faster than another in
  absolute terms, this plugin will not answer that — and honestly, nothing
  else can either, since that number is not published anywhere.

- **It does not recommend a model for a task.** It has no view on whether
  your work needs a large model or a small one. That's a judgment about the
  work, not a rate-limit question, and this plugin only ever answers the
  rate-limit question.

- **Whether a model-scoped bucket also draws on the shared weekly bucket is
  unverified.** Observed on one account: a `weekly_scoped` bucket for Fable
  exists alongside `weekly_all`, and `seven_day_opus` / `seven_day_sonnet`
  are `null`. Whether Fable usage *also* counts against `weekly_all` was
  not determined. It matters: it's the difference between "switching helps"
  being the whole story or only half of it. Until observed over time, treat
  the advice as directionally right, not exact.

- **Bucket shapes vary by plan tier.** The plugin reads whatever `limits[]`
  contains on your account and asserts nothing about which buckets should
  exist. It does not assume a `weekly_scoped` bucket exists at all, and it
  does not assume Opus or Sonnet ever get one of their own.

- **Model identification is best-effort.** The API schema has a
  `scope.model.id` field for exactly this purpose, but in practice it's
  `null`, so matching falls back to comparing a bucket's human-readable
  display name against the model id Claude Code reports. An unversioned
  name like `"Fable"` matches by token (so `"claude-fable-5-1"` matches, but
  a name that merely contains the same letters, like `"affable"`, does
  not). A name that carries a version number, like `"Opus 4"`, requires an
  exact token match instead, because there is no safe way to tell "Opus 4"
  apart from "Opus 4.5" by loose matching. When neither check can be sure,
  the plugin stays silent rather than guessing — a missed "switching would
  help" is an acceptable failure; a confident wrong one is not.

- **The current model is read from the session transcript, falling back to
  `settings.json`.** The transcript's most recent row naming a model wins;
  `<synthetic>` rows are ignored. If neither source yields a model, the
  hook says nothing, and `/limits` prints "could not be determined" rather
  than guessing. `/limits` itself never receives a transcript path
  directly — it only gets a session id — so it locates the transcript by
  searching under the config directory for a file named after that session
  id, and falls back to `settings.json` if the search finds none or more
  than one match.

- **`effort` is not available to `/limits`.** It exists only in the hook's
  payload, which a slash command never receives. Rather than print a
  placeholder that would be wrong on every single invocation, `/limits`
  omits the line entirely — see the two samples above, neither of which
  shows one.

- **Same undocumented endpoint, same fail-open behaviour, same
  Claude-Code-2.1.220-only testing as `usage-guard`.** This plugin reads the
  same `https://api.anthropic.com/api/oauth/usage` endpoint, through the
  same vendored auth and cache modules, and degrades the same way: missing
  credentials, an API error, a stale cache, or an unreadable transcript all
  collapse to silence rather than a crash or a wrong claim. See
  [`usage-guard`'s README](../usage-guard/README.md#limitations) for the
  detail on both — it isn't repeated here.

- **The full API response is written to disk, mode 0600.** Every successful
  fetch — whether triggered by this plugin or by `usage-guard`, since both
  share the same cache directory — writes the complete, unmodified response
  to `${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/usage-raw.json`, not just the
  `limits[]` subset `/limits` and the hook actually read.

- **When the usage data itself can't be read, `/limits` says so and stops —
  it never guesses at "zero buckets" instead.** A blind account (no
  credentials, an API error) or a cache stale enough to no longer be usable
  both print a plain "usage data could not be read" line, with the reason
  when one is known, and no bucket list or percentage at all. That's a
  different claim from "the account reported no buckets" (see `buckets.mjs`'s
  own no-buckets reason), which only prints on an actual successful read.
