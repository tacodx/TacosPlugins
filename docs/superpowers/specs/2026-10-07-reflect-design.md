# TacosPlugins — `reflect` design

**Date:** 2026-10-07
**Status:** Design approved in conversation, not yet implemented. The indexer has a plan,
`docs/superpowers/plans/2026-10-07-reflect-indexer.md`. Section 11 lists what a spike must
confirm before the mod's plan is written; the spike may revise this document.
**Scope:** The third TacosPlugins plugin and the first that is a *mod*: code that runs inside
Claude Code and draws its own interface. Does not use `packages/core`.

---

## 1. Problem

Claude chat has Reflect: a dashboard of how you use Claude. Claude Code has nothing like it, yet
every session is already on disk in full detail. The repo owner asked for the same thing for
Claude Code, "very detailed impressive to see stuff", inside the desktop app's Code tab.

## 2. What this plugin does

`/reflect` opens a pane with seven tabs of charts drawn from local history, and a range switch
(7 days, 30 days, 90 days, all time).

| Tab | Shows |
|---|---|
| Overview | Eight stat tiles, output tokens per day, weekday × hour heatmap of prompts |
| Activity | Calendar heatmap of prompts per day, sessions per day, streaks, longest sessions |
| Projects | Projects ranked by output tokens, prompts and sessions |
| Models | Share of output tokens per model, tokens per day by model, cache hit rate, effort levels |
| Tools | Most used tools, skills and MCP servers; share of replies written by subagents |
| Work | Mix of work types (feature, bugfix, discovery, …) per month and per project |
| Tips | On request, a short model-written reading of the numbers |

Everything except Tips is computed locally and nothing leaves the machine.

## 3. Non-goals

Recorded explicitly so they are not quietly reintroduced.

| Rejected for v1 | Why |
|---|---|
| Wellbeing nudges, quiet hours, reflective questions | Owner chose "impressive to look at" as the goal. A nagging layer is a different product. |
| Charts in the terminal | Owner chose the desktop Code tab only. The terminal has no `Svg` element. It gets a short text summary so the pane is never refused there. |
| A live band above the prompt | Not part of the approved design. |
| Cost in money | Same reason `usage-guard` refuses: the conversion is not calibratable on a subscription. |
| Named topics or themes | Would need transcript or summary text sent to a model. The Work tab uses claude-mem's own type labels instead, which costs nothing and sends nothing. |
| Importing `~/.claude/stats-cache.json` | Covers 9 May to 19 June only, in an old format. Not worth a parser. |
| Editing or deleting any history | The plugin is read-only on everything it did not create. |

## 4. Verified facts

Everything here was measured on 2026-10-07 on the owner's machine (Claude Code 2.1.289 in the
desktop app, CLI 2.1.292, Node 22.22.2) unless marked otherwise.

### 4.1 The mod API (from this build's `claude-code.d.ts` and the plugin-authoring reference)

- A mod is `.claude-plugin/plugin.json`, `hooks/hooks.json` as `{ "modules": ["./register.tsx"] }`,
  and the hooks module. The module has **no Node and no DOM**; everything outside it goes
  through `$`. It may import only files inside the plugin, by relative path, with `import`
  declarations. Files may be `.ts`, `.tsx`, `.js`, `.mjs` and are ES modules.
- `$` may be passed to a function declared at the top level of the *same file*. Passing it to an
  imported function fails `claude plugin validate`. Imported modules must therefore be pure.
- `$.fs.read` rejects files over **4 MiB**. 111 of the 2,499 transcript files are larger.
- `$.process.run(argv, { timeoutMs })` runs a host command with no shell. Default timeout 30 s,
  maximum ten minutes. Each of stdout and stderr is cut at 4,194,304 bytes.
- `$.plugin.root` is the plugin's absolute directory. There is no plugin data directory noun.
- `$.store` keeps JSON across sessions, at most 4 MiB in total. `$.state` holds session values
  with a typed contract in `types/index.d.ts`; a render hook may read but never write it.
- The desktop surface's elements are `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`,
  `Code`, `Markdown`, `Client`. The terminal has no `Svg`.
- `Svg` takes a whole `<svg>` document of at most **131,072 characters**, a required `alt`,
  optional `width` and `height` in CSS pixels, and `isInteractive`. Scripts and event-handler
  attributes are always stripped. With `isInteractive`, hover, CSS `:hover`, SMIL animation and
  `<title>` tooltips work.
- A tree that does not validate for its surface is not drawn, and a pane whose tree is refused
  is closed.
- `$.model.complete({ model, prompt, system, maxTokens })` runs one completion with no history
  and always resolves; `maxTokens` defaults to 1024.
- `claude plugin validate <dir>` and `claude plugin test <dir>` exist. Engine tests are
  `*.test.ts` importing from `claude-code/testing`.

### 4.2 The data

Transcripts live under `~/.claude/projects/<encoded cwd>/`. Main sessions are `<uuid>.jsonl`;
subagent runs are `<uuid>/subagents/**/agent-*.jsonl`.

| Measured | Value |
|---|---|
| Transcript files | 2,499 (175 main sessions, the rest subagents), 3.09 GB |
| Full scan in Node, streaming, one pass | **18.6 s**, 725,110 lines, 0 unparseable |
| Oldest surviving file | modified 2026-09-03; `cleanupPeriodDays` is unset (default 30) |
| Oldest record inside surviving files | 2026-08-15 (older days are partial) |

Record shapes that the indexer depends on:

- **An assistant reply is stored once per content block**, every line carrying the same
  `message.id`. Counting lines inflates tokens, so usage is taken once per `message.id`.
- **Which line holds the real usage differs by file kind.** In a main file every line of a
  reply repeats identical `message.usage`. In a subagent file the early lines hold the usage as
  it stood mid-stream (`stop_reason` null, often one or two output tokens) and only the last
  line has the final figures: 36,346 of 57,379 subagent replies differed, never downward, and
  the last line was the largest in all 76,155 replies. This document first claimed the usage
  was identical everywhere; an independent review of the built indexer measured otherwise.
  Counting the first line read 35.7M output tokens where the final figures total 94.7M. Each
  field is therefore counted as the largest value any line of the reply shows.
- Assistant lines carry `timestamp`, `cwd`, `sessionId`, `entrypoint` (`claude-desktop` or
  `cli`), `effort`, `message.model` and `message.usage` with `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`. A model named `<synthetic>` is not a
  real reply.
- Tool calls are `tool_use` blocks with `id`, `name`, `input`. A `Skill` call names the skill in
  `input.skill`. An MCP tool is named `mcp__<server>__<tool>`.
- **A prompt** is a `user` line with `origin.kind === "human"` and no `isMeta`, in a main file.
  Its `message.content` is a string, or an array when the prompt carried an attachment
  (1,159 strings and 132 arrays in this data). Tool results are also `user` lines and are not
  prompts.
- A `custom-title` line carries the title the person gave a session in `customTitle`; an
  `ai-title` line carries the one Claude Code made up in `aiTitle`. 28 of 175 sessions had
  only the latter.
- 98 other `user` lines in main files have no `origin` at all. Checked by shape: interruption
  markers, compaction summaries, slash commands and their output. At most four could be typed
  prompts, so the definition of a prompt stands.
- Every record in a subagent file has `isSidechain: true`; no record in a main file does.
- **Resumed sessions copy earlier records into the new file.** 138 of 76,079 replies appeared
  in two main files. Skipping main-file records whose `sessionId` differs from the file's own
  id removes 92 of them. **46 remain (0.06% of replies)** and are accepted; see section 8.

Other sources:

- `~/.claude/history.jsonl`: one line per prompt with `timestamp` (epoch ms), `project`,
  `sessionId`. 5,164 prompts over 124 days, 2026-03-15 onward. **It effectively stops on
  2026-09-05**: desktop sessions do not write to it. On 2026-09-04, where both sources are
  complete, it has 83 prompts and the transcripts have 82.
- `claude-mem.db` in `CLAUDE_MEM_DATA_DIR` or `~/.claude-mem` (SQLite, only present with the
  claude-mem plugin): table
  `observations` with `project`, `type`, `title`, `created_at_epoch`; 17,741 rows from
  2026-03-28. `type` is one of discovery, change, feature, bugfix, decision, verification,
  refactor, milestone, measurement, progress. The `concepts` column holds generic tags such as
  `how-it-works`, not subjects, so it is not used.

### 4.3 The repo

- `npm test` is a bare `node --test`. **On Node 22.22.2 that also runs `*.test.ts`**, and an
  engine test fails there with `ERR_MODULE_NOT_FOUND: Cannot find package 'claude-code'`.
  `node --test "a/**/*.test.mjs"` runs only the `.mjs` tests.
- `scripts/release.mjs` vendored `packages/core/*.mjs` into **every** `plugins/*/lib/`, and
  `release.test.mjs` asserted that for every directory under `plugins/`. `reflect` uses none
  of it, and committing a copy was refused by the owner's pre-commit gitleaks hook: `auth.mjs`
  holds an OAuth client id. The indexer plan's first task therefore makes `reflect` a
  *standalone* plugin that the release script skips and that has no `lib/`.
- Baseline before this work: 262 tests, all passing.
- Plugin state lives under `${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/`.
- The marketplace is installed here from GitHub, so a plugin reaches normal sessions only once
  it is pushed and installed. That is the owner's call and is not part of building it.

**Explicitly unverified** — section 11 turns each into a spike check:
how wide a pane is in the desktop Code tab; how `Svg` scales to it; whether an `Svg` follows
light and dark theme; whether `node` is on `PATH` for `$.process.run` in a desktop-hosted
session; whether un-awaited work started in `command.run` finishes and redraws.

## 5. Architecture

Two parts, because of the 4 MiB read limit: a Node **indexer** that does all reading and
arithmetic, and the **mod** that only draws.

```
plugins/reflect/
  .claude-plugin/plugin.json     name "reflect", "types": "./types/index.d.ts"
  hooks/hooks.json               { "modules": ["./register.tsx"] }
  hooks/register.tsx             every `on(...)` and every `$` call; no arithmetic
  hooks/tabs/*.tsx               one per tab: (elements, view, ui state) -> element tree; pure
  hooks/charts/*.mjs             numbers -> SVG string; pure, no Node, no engine
  types/index.d.ts               the $.state contract
  indexer/cli.mjs                `node cli.mjs view --range <id>` -> one View as JSON on stdout
  indexer/clock.mjs              instant -> local day and hour; day arithmetic
  indexer/agg.mjs                aggregate shapes; how one file adds into a day
  indexer/scan.mjs               lines of one transcript -> FileSummary; pure
  indexer/store.mjs              read, save atomically, lock, fold, merge
  indexer/update.mjs             rescan what changed, fold what is gone
  indexer/query.mjs              (merged days, sessions, sources, range) -> View; pure
  indexer/history.mjs            history.jsonl -> prompts per day and hour
  indexer/mem.mjs                claude-mem via the `sqlite3` CLI, read-only -> work mix
  test/*.test.mjs                node --test: indexer and charts
  test/*.test.ts                 claude plugin test: the mod
  test/fixtures/                 synthetic transcripts only
  README.md
```

Flow of one `/reflect`:

1. `command.run` opens the pane, sets `status: "loading"`, and starts a refresh.
2. The refresh runs `node <root>/indexer/cli.mjs view --range <id>` with a 180 s timeout.
3. The CLI takes the lock, rescans only transcript files whose size or mtime changed, folds
   files that have disappeared, saves, then prints the `View` for the range.
4. The mod parses stdout and writes it to `$.state`. The pane's render hook reads the state,
   calls the active tab module, and returns its tree. Charts go in as `Svg` elements.
5. A tab or range button writes `$.state`; a range change runs steps 2 to 4 again.

## 6. Data model

### 6.1 What the scanner keeps per file

```
FileSummary = {
  kind: "main" | "sub", sessionId, project, entrypoint?, title?,
  session?: { start, end, activeMs, prompts },          // main files only
  days: { "YYYY-MM-DD": DayAgg }                        // local time
}
DayAgg = {
  prompts, hours: number[24],                           // prompts by local hour
  msgs, subMsgs, out, inp, cacheR, cacheW, activeMs,
  models: { [model]: { msgs, out, inp, cacheR, cacheW } },
  tools:  { [name]: n }, skills: { [name]: n }, mcp: { [server]: n },
  efforts: { [level]: n }
}
```

Rules, each with a test:

- Usage is counted once per `message.id` per file, each field as the largest value any line of
  the reply shows, on the day of the reply's first line. Tool calls once per `tool_use.id` per
  file.
- A record whose time is unreadable or outside 2020 to 2100 is skipped and counted, as is a
  parsed line that is not an object. The same window applies to `history.jsonl` and claude-mem.
- A session's title is the person's own if there is one, otherwise Claude Code's.
- In a main file, a record whose `sessionId` is not the file's own id is skipped.
- `project` is the first `cwd` seen, made relative to the home directory, with a leading
  `Projects/` removed and anything from `/.claude/worktrees/` or `/.superpowers/` onward cut, so
  a worktree counts toward its parent project.
- `activeMs` sums the gaps under five minutes between consecutive records the scanner reads
  (replies and prompts) in a main file. It measures how long the session was busy, including Claude working unattended, and
  the interface labels it that way.
- `msgs` counts replies from main files and `subMsgs` those from subagent files.

### 6.2 The store

`${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/reflect/store.json`, mode 600:

```
{ version: 2,
  root:     the projects folder this store was built from,
  scan:     { version, zone },      // the scanner version and time zone that made the summaries
  files:    { [path below the project folder]: { size, mtimeMs, summary: FileSummary } },
  frozen:   { days: { [day]: { ...DayAgg, sessions, projects: { [name]: { prompts, out, sessions } } } } },
  sessions: [ { id, project, title, entrypoint, start, end, activeMs, prompts, out } ] }
```

- A file is rescanned in full when its size or mtime differs from the record. **Every file is
  rescanned when `scan` differs** from the running scanner's version or the current time zone:
  a fixed scanner must not leave old summaries behind, and days are local. What is already
  frozen stays as it was made.
- **A transcript is known by its path below the project folder**, `<session>.jsonl` or
  `<session>/subagents/…`. The project folder is named after a working directory, so a
  renamed project keeps its history instead of being folded and counted again, and a copied
  one is counted once.
- A store whose `version` is higher than this code's is not this code's to replace: the command
  stops and touches nothing. Version 1, keyed by full path, was never released and is rebuilt.
- **A file that is in the store but gone from disk is folded**: its summary is added into
  `frozen.days` and its record removed. A deleted transcript never returns, so this cannot
  double count, and it is what lets history outlive the 30-day cleanup while the store stays
  small.
- **A fold cannot be undone, so two guards stand in front of it.** A store refuses to be updated
  from any folder other than its `root`: pointed elsewhere it would see every file as deleted,
  fold them all, and count them again when pointed back. And a `root` that is missing while the
  store still knows files in it is an error, not "everything was deleted".
- `sessions` keeps one row per main session forever. It is what "longest session" reads.
- Saved by writing a uniquely named temp file in the same directory, mode 600, flushing it,
  then renaming. The temp file is removed on any failure.
- A lock file created with the `wx` flag guards the index step. It names its owner. It is
  taken over at once when the owner's process is gone, and otherwise only when it is older
  than ten minutes, which no run is. A release removes only the releaser's own lock. If the
  lock is held, the CLI skips indexing, answers from the store as it stands, and adds a note
  to the View. The owner runs many sessions at once, so this path is normal, not exceptional.
  Two processes can still both take over one abandoned lock; each then writes a complete
  store from the same disk, the later save wins, and nothing is counted twice.

### 6.3 Prompts before the transcripts begin

For each local day, the prompt count and its hour distribution come from whichever of the two
sources has **more prompts for that day**: transcripts or `history.jsonl`. Each source can only
under-count in its own era, and they agree where both are complete. Sessions, tokens, tools and
models exist only where transcripts do, and the View says from which date.

### 6.4 The View

`query(store, history, mem, range, now)` returns one object: `range` with its dates; `coverage`
(first day of each source); `totals` including active days, current and best streak, cache hit
rate `cacheR / (cacheR + cacheW + inp)`, and desktop versus terminal sessions; `days` (every day
in the range, zeros included); `hours` as 7 × 24; ranked `projects`, `models`, `tools`,
`skills`, `mcp`, `efforts`; `sessions.longest` and `sessions.mostPrompts`; `work` or `null`;
`previous` (the same totals for the window just before, for deltas, or `null` for all time);
and `notes`. Lists are capped (15 tools, 12 projects, 10 skills and servers, 5 sessions) so a
View stays far below 4 MiB.

Definitions the query must follow exactly:

- **A range of N days** is today and the N−1 days before it, in local time. "All" starts at
  the earliest day any source has.
- **A day's `sessions`** is the number of main files with at least one record that day.
  **Sessions in a range** is the number of session rows whose `start` falls in the range, and
  a project's session count is taken from the same rows.
- **An active day** has at least one prompt.
- **The current streak** is the run of consecutive active days ending today, or ending
  yesterday when today has no prompt yet. **The best streak** is the longest run ever. Both are
  computed over all days regardless of range.

## 7. Behaviour

- **`session.start`** registers `/reflect`. Nothing is read or run until the command is used.
- **The pane** has a row of tab buttons, a row of range buttons, then the tab's content.
  While loading it shows "Reading your history…"; a first run takes about twenty seconds.
- **Charts** are built by `hooks/charts/*.mjs` as strings and drawn `isInteractive`, each mark
  carrying a `<title>` tooltip. Every chart has a real `alt` sentence stating its headline
  number. No chart may exceed 131,072 characters; the builders assert it.
- **Terminal and other surfaces** get the totals as text and one line saying the charts are in
  the desktop app.
- **Tips** is a button. Pressing it sends `$.model.complete` with model `haiku`, `maxTokens`
  800, and a prompt containing only numbers, model names, tool names and work-type counts.
  **Project names and session titles are replaced by placeholders** (`project-1`, …) before
  sending and restored in the reply. The result is drawn as `Markdown` with the token usage of
  the call beneath it, and cached in `$.store` per range and day.

## 8. Failure behaviour

The plugin fails soft everywhere. A hook never throws; a broken Reflect shows a message and a
Retry button and changes nothing else in the session.

| Situation | Behaviour |
|---|---|
| `node` missing, or CLI exits non-zero or times out | Pane shows the reason and Retry |
| stdout is not a valid View, or is truncated | Same |
| `store.json` unreadable or of an older version | Rebuilt from files on disk; once the rebuild is in hand the old file is moved aside as `store.corrupt-<time>.json` and the pane says older history was lost. A rebuild that fails leaves the file in place, so the next run reports it again |
| The same, while another session holds the lock | Nothing is moved or rebuilt; the note says another session is rebuilding |
| `store.json` saved by a newer version | The command fails with the reason; the file is not touched |
| A transcript put back after it was folded (restored from a backup) | Counted again. Accepted: it takes someone restoring deleted transcripts |
| A transcript line does not parse, or has an unknown shape | Skipped and counted |
| A file vanishes mid-scan | Counted as gone; an earlier record of it is folded in the same run |
| No transcripts at all | Empty state, not an error |
| The transcripts folder is missing, or is not the one the store was built from, while the store knows files | The command fails with the reason; nothing is folded |
| `history.jsonl` or claude-mem missing, or `sqlite3` not installed | That source is absent; the Work tab explains why it is empty |
| Tips call not answered | The reason is shown; nothing is cached |

**Known inaccuracy.** 46 of 76,079 replies (0.06%) are counted twice because a resumed session
can copy a record under the new session id. Removing them would need a permanent set of every
message id; that is not worth it. The README states the figure.

## 9. Testing

- **`node --test`** covers `scan`, `store`, `query`, `history`, `mem` and every chart builder.
  Required cases: the once-per-`message.id` rule (a reply split over three lines counts once);
  the foreign-`sessionId` skip; array-content prompts; tool results not counted as prompts;
  worktree paths mapping to the parent project; fold on deletion adds exactly once and survives
  a second run; incremental run equals full run; lock held; corrupt store; the larger-source
  rule per day; streaks across a gap; chart size limit and well-formed SVG.
- **`claude plugin test`** covers the mod on `['terminal', 'desktop']`: the command opens the
  pane; a failed CLI shows Retry; tab and range presses change what is drawn; the terminal tree
  validates without `Svg`. The indexer is replaced by a test hook that answers the
  `process.run` event with a canned View, so no engine test reads real history.
- **Every new test is mutation-checked**: break the code, see the test fail, restore. This
  repo's history shows five tests that could not fail.
- **Mutation checks do not find a wrong fact.** All 77 breakages of the first build were
  caught, and its headline number was still 62% low, because the tests encoded this document's
  mistaken claim about usage (section 4.2). An independent reviewer who measured the real
  transcripts found it. A claim in section 4 is only as good as the measurement behind it.
- **Fixtures are synthetic.** No real transcript, prompt, project name or session title is ever
  committed: the repo is public.
- **A test stays isolated even when the code under test is broken.** Every run of the command in
  a test gets its own `CLAUDE_CONFIG_DIR` and `CLAUDE_MEM_DATA_DIR`, usage-error cases included,
  and mutation checks run with a throwaway `HOME`. While the indexer's plan was being written, a
  mutated argument parser let a usage-error test index the real `~/.claude`.
- **`npm test` becomes `node --test "**/*.test.mjs"`** so the engine tests are not picked up by
  Node. The count must stay at 262 plus the new tests.
- CI keeps running `npm test` only. Engine tests and `claude plugin validate` are a local gate
  in v1; running them in CI would need Claude Code installed there.
- `marketplace.json` gains the entry, the root README the table row, and
  `manifests.test.mjs` already checks that versions match.

## 10. Build order

0. Spike (section 11).
1. Indexer: `scan`, `store`, `query`, CLI. Checked against the scan figures in section 4.2.
2. Mod shell, state contract, Overview tab.
3. Activity, Projects, Models, Tools.
4. `history` and `mem` sources, Work tab.
5. Tips.
6. README, marketplace entry, release housekeeping.

## 11. Spike: what must be confirmed first

A throwaway mod with one command, one pane and one chart, loaded in the desktop Code tab.

| # | Question | If the answer is bad |
|---|---|---|
| S1 | How wide and tall is the pane, and how does an `Svg` scale to it? | Charts are designed to the measured width; the Overview mockup assumed about 640 px |
| S2 | Does an `Svg` follow light and dark theme (`prefers-color-scheme` inside the document)? | Use colours that read on both |
| S3 | Do `<title>` tooltips and hover work with `isInteractive`? | Print the values as text beside the charts |
| S4 | Does `$.process.run(["node", …])` work in a desktop-hosted session, and how long does a no-change index take? | Resolve the Node path explicitly, or document the requirement |
| S5 | Does un-awaited work started in `command.run` complete and redraw? | Start it from `$.clock.after` |
| S6 | Can the session's mod folder be a symlink into this repo, so edits here hot-reload? | Develop in the mod folder and copy |
| S7 | Is `/reflect` free, and is `reflect` accepted as a plugin name? | Rename before anything depends on it |
| S8 | Does `$.state` accept a View-sized value (tens of kilobytes)? | Keep the View in a module variable and refetch on reload |
| S9 | Does `claude plugin validate` accept an unused vendored `lib/`? | Moot: `reflect` carries no `lib/` (section 12) |
| S10 | Does JSX work in an imported `.tsx` module that is handed the element table as an argument? | Tab modules return plain data and `register.tsx` builds every tree |

### Spike results so far (2026-10-07)

Read from a file the spike mod wrote, in the owner's desktop Code tab, Claude Code 2.1.289:

| # | Answer |
|---|---|
| S1 | Partly. Opened unasked, the pane is placed in the dock at **38 body columns** of a 66-column, 55-row viewport, with 48 body rows. Its width in pixels and how an `Svg` scales are still unseen. |
| S4 | Yes. `$.process.run(["node", …])` reached Node 22.22.2 and answered in 117 ms. |
| S5 | Yes. Work left running by the hook finished and its state write redrew the pane. |
| S6 | Yes. A mod folder that is a symlink loads; `$.plugin.root` is the link's path, not its target. |
| S7 | Yes. `/reflect` registered, and `claude plugin validate` accepts the plugin name `reflect`. |
| S8 | Yes. `$.state` held a 61 KB value. An all-time View is about 100 KB, still to be tried. |
| S2, S3, S10 | Not yet seen: they need someone to look at the pane. |

## 12. Decisions that were open

- **No `lib/` in this plugin.** The alternative, keeping the "every plugin vendors core"
  invariant at the cost of eleven dead files, was this design's first choice. The pre-commit
  secret scan settled it the other way (section 4.3).
- **Raising `cleanupPeriodDays`.** Not needed once the store exists, and not this plugin's
  setting to change.
