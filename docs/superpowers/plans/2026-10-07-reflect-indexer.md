# reflect indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node half of `reflect`: a command that reads Claude Code's local history incrementally and prints one JSON `View` for a date range.

**Architecture:** A pure scanner turns the lines of one transcript into a per-day summary. A small store keeps one summary per file, folds a file's numbers into a permanent total when the file is deleted, and is saved atomically under a lock. A pure query turns the store plus two optional side sources into the `View`. `cli.mjs` wires them together. The mod that draws the View is a separate plan, written after the spike in the spec's section 11.

**Tech Stack:** Plain ESM Node (`.mjs`), Node 22+, zero dependencies, `node --test`.

> **Executed 2026-10-07.** The code blocks below are what was first built (commits `0684b72` to `21e8da7`). An independent review then changed it, most importantly how a reply's usage is counted: see commit `aab699b` and the spec's section 4.2. Read the repo, not this file, for what the code is now.

**Spec:** `docs/superpowers/specs/2026-10-07-reflect-design.md`. Read sections 4.2, 6 and 8 first. Section 4.2 is measured fact about the data; where this plan and that section disagree, stop and report.

## Global Constraints

- **Node 22+.** ESM only, `.mjs`, no build step.
- **Zero runtime and dev dependencies.** Do not run `npm install`.
- **Read-only on Claude's data.** Nothing here writes under `projects/`, `history.jsonl` or the claude-mem database. The only directory written is the data directory, `${CLAUDE_CONFIG_DIR:-~/.claude}/tacos/reflect`.
- **Tests never touch the real `~/.claude` or `~/.claude-mem`, even when the code under test is broken.** Every call of `run()` and every spawned process gets an environment with its own `CLAUDE_CONFIG_DIR` and `CLAUDE_MEM_DATA_DIR`, including the tests that expect a usage error. No network.
- **Mutation checks run with a throwaway home:** prefix the test command with `HOME=$(mktemp -d)`. A mutation can turn a harmless test into one that runs the real command on the real machine. While this plan was being written, a mutated argument parser let a usage-error test index the real `~/.claude` and save a store there.
- **Fixtures are synthetic.** The repo is public: no real transcript line, prompt, project name or session title is ever committed. Build lines with `test/helpers.mjs`.
- **Mutation-check every test**: break the code, confirm the test fails, restore. State the mutation and the result in your report. Five tests in this repo once passed with the implementation deliberately broken.
- **Never assert inside an injected stub.** Record what the stub received, let the call return, then assert.
- **Keys that come from data are never read as plain properties.** Tool names, model names and project names index maps; `map.constructor` is a function on every object. Use `own`, `bump` and `Object.hasOwn`.
- **`reflect` is a standalone plugin.** It imports nothing from `packages/core` and has no `lib/`. `scripts/release.mjs` skips it (Task 1) and a test refuses any import from `lib/` under it.
- **Never bypass the pre-commit hook.** It runs gitleaks. If it blocks a commit, stop and report the finding; do not use `--no-verify`.
- **Match the repo's style:** no semicolons, single quotes, parentheses around every arrow parameter (`(name) => …`).
- **Commits carry NO `Co-Authored-By` trailer and no "Generated with Claude Code" line.** Commit with the repo's configured identity; never pass `-c user.name`.
- All commands run from the repo root, `~/Projects/TacosPlugins`, on branch `feat/reflect`.

## File Structure

```
plugins/reflect/
  .claude-plugin/plugin.json     Task 1   manifest (no hooks yet; the mod adds them); no lib/
  indexer/clock.mjs              Task 2   instant -> local day and hour; day arithmetic
  indexer/agg.mjs                Task 2   aggregate shapes; how one file adds into a day
  indexer/scan.mjs               Task 2   lines of one transcript -> FileSummary (pure)
  indexer/store.mjs              Task 3   the store: read, save, lock, upsert, fold, merge
  indexer/update.mjs             Task 4   walk projects/, rescan what changed, fold what is gone
  indexer/history.mjs            Task 5   history.jsonl text -> prompts per day and hour
  indexer/mem.mjs                Task 5   claude-mem through the sqlite3 CLI -> work rows
  indexer/query.mjs              Task 6   (merged days, sessions, sources, range) -> View (pure)
  indexer/cli.mjs                Task 7   `view --range <id>` -> View as JSON on stdout
  test/helpers.mjs               Task 2   builders for synthetic transcript lines
  test/*.test.mjs                         one test file per module
```

Shapes used across tasks, defined once here:

```
DayAgg      = { prompts, hours[24], msgs, subMsgs, out, inp, cacheR, cacheW, activeMs,
                models: { [model]: { msgs, out, inp, cacheR, cacheW } },
                tools: {}, skills: {}, mcp: {}, efforts: {} }          // counts by name
MergedDay   = DayAgg + { sessions, projects: { [name]: { prompts, out, sessions } } }
FileSummary = { kind: 'main' | 'sub', sessionId, project, entrypoint?, title?, bad,
                session?: { start, end, activeMs, prompts, out },      // main files with records
                days: { [day]: DayAgg } }
Store       = { version: 1, root, files: { [rel]: { size, mtimeMs, summary } },
                frozen: { days: { [day]: MergedDay } }, sessions: [SessionRow] }
SessionRow  = { id, project, title, entrypoint, start, end, activeMs, prompts, out }
```

`day` is always a local calendar day as `YYYY-MM-DD`. Instants are epoch milliseconds.

---

### Task 1: Scaffold the plugin, scope `npm test`, and exempt it from vendoring

Two pieces of shared tooling change before any `reflect` code exists.

- **`npm test` is a bare `node --test`.** On Node 22 that also runs `*.test.ts`, and the mod's engine tests (a later plan) import `claude-code/testing`, which Node cannot resolve. The script is scoped to `.mjs` now, before any `.ts` test exists.
- **`scripts/release.mjs` vendors `packages/core` into every plugin.** `reflect` imports nothing from it. A copy would be dead code in the published plugin, and it would duplicate the OAuth client id line of `auth.mjs` into a plugin that does no auth: the owner's pre-commit gitleaks hook refused exactly that commit when this task was first attempted. `reflect` therefore becomes a *standalone* plugin that the release script skips, and a test refuses any import from `lib/` under it.

**Files:**
- Create: `plugins/reflect/.claude-plugin/plugin.json`
- Create: `plugins/reflect/test/scaffold.test.mjs`
- Modify: `package.json` (the `test` script)
- Modify: `scripts/release.mjs`
- Modify: `packages/core/test/release.test.mjs`
- Modify: `README.md` (two places that say "every plugin")

**Interfaces:**
- Consumes: nothing.
- Produces: the directory `plugins/reflect/`, with no `lib/`; `npm test` running exactly the `*.test.mjs` files; from `scripts/release.mjs`, `STANDALONE_PLUGINS: string[]` and `vendoredPlugins(pluginsDir): string[]`.

- [ ] **Step 1: Record the baseline**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 262`, `# pass 262`, `# fail 0`.

- [ ] **Step 2: Write the failing tests**

**Create `plugins/reflect/test/scaffold.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

// A bare `node --test` also runs *.test.ts on Node 22, and a mod's engine tests
// import 'claude-code/testing', which only `claude plugin test` can resolve.
test('npm test runs only the .mjs tests', () => {
  assert.equal(json('package.json').scripts.test, 'node --test "**/*.test.mjs"')
})

test('the reflect manifest names the plugin, with a version, and not like one of Anthropic\'s', () => {
  const manifest = json('plugins/reflect/.claude-plugin/plugin.json')
  assert.equal(manifest.name, 'reflect')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(!manifest.name.startsWith('claude'))
})
```

In `packages/core/test/release.test.mjs`, make three edits.

Change the import of the release script to:

```js
import { STANDALONE_PLUGINS, vendorCore, vendoredPlugins } from '../../../scripts/release.mjs'
```

In the test `every packages/core module is vendored byte-identically into every plugin/*/lib/`, replace the two lines that compute `plugins` from `readdirSync(pluginsDir)` with one, and reword the comment above the test to say it loops over `vendoredPlugins()`:

```js
  const plugins = vendoredPlugins(pluginsDir)
```

Append to the end of the file:

```js
/** Every source file under dir, at any depth. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) found.push(path)
  }
  return found
}

// A plugin that imports nothing from packages/core carries no copy of it. The copy would
// be dead code in the published plugin, and it would duplicate auth.mjs's OAuth client id
// into a plugin that does no auth, which the pre-commit secret scan refuses.
//
// The second half is what keeps the exemption honest: a standalone plugin that later
// starts importing from lib/ would publish exactly the unrunnable plugin described above.
test('a standalone plugin is skipped by vendoring, has no lib/, and imports nothing from one', () => {
  const pluginsDir = join(ROOT, 'plugins')

  for (const plugin of STANDALONE_PLUGINS) {
    const dir = join(pluginsDir, plugin)
    assert.ok(existsSync(dir), `plugins/${plugin} is listed as standalone but does not exist`)
    assert.ok(!vendoredPlugins(pluginsDir).includes(plugin), `plugins/${plugin} is standalone and must not be vendored into`)
    assert.ok(!existsSync(join(dir, 'lib')), `plugins/${plugin}/lib exists — a standalone plugin must not carry packages/core`)

    for (const file of sourceFiles(dir)) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /(?:from|import)\s*\(?\s*['"](?:\.\.?\/)+lib\//,
        `${file} imports from lib/, which a standalone plugin does not have`,
      )
    }
  }
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test plugins/reflect/test/scaffold.test.mjs packages/core/test/release.test.mjs`
Expected: both scaffold tests FAIL (the script string; `ENOENT` for `plugin.json`), and `release.test.mjs` fails to load with `does not provide an export named 'STANDALONE_PLUGINS'`.

- [ ] **Step 4: Create the manifest**

**Create `plugins/reflect/.claude-plugin/plugin.json`:**

```json
{
  "name": "reflect",
  "version": "0.1.0",
  "description": "A dashboard of how you use Claude Code, drawn from your local history.",
  "author": {
    "name": "tacodx"
  },
  "license": "MIT"
}
```

- [ ] **Step 5: Scope the test script**

In `package.json`, change the `test` script from `"node --test"` to:

```json
    "test": "node --test \"**/*.test.mjs\""
```

- [ ] **Step 6: Teach the release script about standalone plugins**

In `scripts/release.mjs`, add above `vendorCore`:

```js
/** Plugins that import nothing from packages/core, and so carry no vendored lib/. */
export const STANDALONE_PLUGINS = ['reflect']

/** The plugins under pluginsDir that packages/core is vendored into. */
export function vendoredPlugins(pluginsDir) {
  return readdirSync(pluginsDir)
    .filter((name) => statSync(join(pluginsDir, name)).isDirectory())
    .filter((name) => !STANDALONE_PLUGINS.includes(name))
}
```

and in the `isMain` block replace `readdirSync(join(root, 'plugins'))` with `vendoredPlugins(join(root, 'plugins'))`.

- [ ] **Step 7: Say so in the README**

In `README.md`, change the tree comment on `scripts/release.mjs` to `# copies packages/core into each plugin that uses it`, and in "The vendoring rule" replace "copies it into every plugin's `lib/` directory before release." with:

```
copies it into the `lib/`
directory of every plugin that uses it before release. A plugin that imports
nothing from `packages/core/` is named in `STANDALONE_PLUGINS` there and
carries no `lib/`.
```

- [ ] **Step 8: Run the release script and everything else**

Run: `node scripts/release.mjs && ls -a plugins/reflect`
Expected: two lines, `vendored 11 modules into plugins/model-advisor/lib/` and `…usage-guard/lib/`, none for `reflect`; the listing shows `.claude-plugin` and `test`, and no `lib`.

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 265`, `# pass 265`, `# fail 0` (the 262 from before, the two scaffold tests and the standalone one).

- [ ] **Step 9: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| `package.json`: change the script back to `"node --test"` | "npm test runs only the .mjs tests" |
| `plugin.json`: change the name to `"claude-reflect"` | "the reflect manifest names the plugin" |
| `release.mjs`: set `STANDALONE_PLUGINS = []` | "every packages/core module is vendored byte-identically" (there is no `plugins/reflect/lib`) |
| `release.mjs`: delete the second `.filter(...)` of `vendoredPlugins` | "a standalone plugin is skipped by vendoring" |
| Create an empty `plugins/reflect/lib/` directory | the same test |
| Add the line `import '../lib/auth.mjs'` to `plugins/reflect/test/scaffold.test.mjs` | the same test |

- [ ] **Step 10: Commit**

```bash
git add package.json README.md scripts/release.mjs packages/core/test/release.test.mjs plugins/reflect
git commit -m "feat(reflect): scaffold a standalone plugin and scope npm test to .mjs"
```

If the pre-commit hook blocks the commit, stop and report what it found. Do not use `--no-verify`.

---

### Task 2: The scanner

Turns the lines of one transcript file into a `FileSummary`. Pure: it reads no files. This is the largest correctness surface in the plugin, because the transcript format has three traps, all measured in the spec's section 4.2:

1. An assistant reply is written as **one line per content block**, each line repeating the same `message.id` and the same `message.usage`. Usage is counted once per `message.id`.
2. A resumed session **copies earlier records** into its new file under their old `sessionId`. In a main file, a record whose `sessionId` is not the file's own id is skipped.
3. Tool results are `user` lines too. A prompt is a `user` line whose **top-level** `origin.kind` is `"human"`, without `isMeta`, in a main file.

**Files:**
- Create: `plugins/reflect/indexer/clock.mjs`
- Create: `plugins/reflect/indexer/agg.mjs`
- Create: `plugins/reflect/indexer/scan.mjs`
- Create: `plugins/reflect/test/helpers.mjs`
- Test: `plugins/reflect/test/clock.test.mjs`
- Test: `plugins/reflect/test/scan.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `clock.mjs`: `systemTimeZone(): string`; `createClock(timeZone: string): (ms: number) => { day: string, hour: number }`; `addDays(day: string, n: number): string`; `weekdayOf(day: string): number` (0 = Monday … 6 = Sunday).
  - `agg.mjs`: `own(map, key, make)`, `bump(map, key, n = 1)`, `addCounts(target, source)`, `emptyModel()`, `emptyDay(): DayAgg`, `emptyMergedDay(): MergedDay`, `addSummary(days: { [day]: MergedDay }, summary: FileSummary): void`.
  - `scan.mjs`: `projectOf(cwd, home): string`; `createScanner({ kind, fileId, home, clock }): { push(line: string): void, finish(): FileSummary }`; `scanLines(lines: Iterable<string>, options): FileSummary`.
  - `test/helpers.mjs`: `HOME`, `utc`, `tempDir(t)`, `text(value)`, `toolUse(id, name, input)`, `reply({...})`, `prompt({...})`, `toolResult({...})`, `title({...})`.

- [ ] **Step 1: Write the clock tests**

**Create `plugins/reflect/test/clock.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addDays, createClock, weekdayOf } from '../indexer/clock.mjs'

const ms = (iso) => Date.parse(iso)

test('a clock gives the local day and hour of an instant in its zone', () => {
  const utc = createClock('UTC')
  const berlin = createClock('Europe/Berlin')

  assert.deepEqual(utc(ms('2026-03-01T23:30:00Z')), { day: '2026-03-01', hour: 23 })
  assert.deepEqual(berlin(ms('2026-03-01T23:30:00Z')), { day: '2026-03-02', hour: 0 })
})

test('a clock follows a daylight-saving switch', () => {
  const berlin = createClock('Europe/Berlin')

  // 29 March 2026: 02:00 CET becomes 03:00 CEST.
  assert.deepEqual(berlin(ms('2026-03-29T00:30:00Z')), { day: '2026-03-29', hour: 1 })
  assert.deepEqual(berlin(ms('2026-03-29T01:30:00Z')), { day: '2026-03-29', hour: 3 })
})

// Results are cached. India is UTC+5:30, so its midnight falls inside one UTC hour:
// a cache keyed by the hour would hand the second call the first call's answer.
test('the cache does not blur a zone whose offset is not a whole hour', () => {
  const kolkata = createClock('Asia/Kolkata')

  assert.deepEqual(kolkata(ms('2026-01-01T18:29:00Z')), { day: '2026-01-01', hour: 23 })
  assert.deepEqual(kolkata(ms('2026-01-01T18:31:00Z')), { day: '2026-01-02', hour: 0 })
})

test('addDays moves across month, year and leap-day boundaries in both directions', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2026-03-10', -6), '2026-03-04')
  assert.equal(addDays('2026-03-10', 0), '2026-03-10')
})

test('weekdayOf counts from Monday', () => {
  assert.equal(weekdayOf('2026-03-09'), 0) // a Monday
  assert.equal(weekdayOf('2026-03-10'), 1)
  assert.equal(weekdayOf('2026-03-08'), 6) // a Sunday
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/clock.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/clock.mjs`.

- [ ] **Step 3: Write the clock**

**Create `plugins/reflect/indexer/clock.mjs`:**

```js
// Local calendar day and hour for an instant, in a named time zone.
//
// Intl is slow per call, so answers are cached per quarter hour: every real UTC
// offset and every daylight-saving switch falls on a quarter-hour boundary, so
// all instants inside one quarter hour share a local day and hour.

const QUARTER_HOUR = 15 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** @returns {(ms: number) => { day: string, hour: number }} */
export function createClock(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const cache = new Map()

  return (ms) => {
    const key = Math.floor(ms / QUARTER_HOUR)
    let answer = cache.get(key)
    if (answer === undefined) {
      const parts = {}
      for (const { type, value } of format.formatToParts(new Date(ms))) parts[type] = value
      answer = { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
      cache.set(key, answer)
    }
    return answer
  }
}

/** The calendar day `n` days after `day`; `n` may be negative. Noon UTC keeps it clear of any offset. */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day) {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
}
```

- [ ] **Step 4: Run the clock tests to verify they pass**

Run: `node --test plugins/reflect/test/clock.test.mjs`
Expected: 5 tests, all PASS.

- [ ] **Step 5: Write the helpers and the scanner tests**

**Create `plugins/reflect/test/helpers.mjs`:**

```js
// Builders for synthetic transcript lines. Nothing here is copied from a real
// transcript: the repo is public. JSON.stringify writes compact JSON, which is
// what Claude Code writes and what the scanner's cheap pre-filter expects.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClock } from '../indexer/clock.mjs'

export const HOME = '/home/u'
export const utc = createClock('UTC')

/** A temp directory that is removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflect-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export const text = (value) => ({ type: 'text', text: value })
export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })

/** One line of an assistant reply. A real reply is one such line per content block, all sharing `id` and usage. */
export function reply({
  id,
  session,
  at,
  blocks = [text('ok')],
  model = 'claude-opus-5-5',
  out = 10,
  inp = 1,
  cacheR = 0,
  cacheW = 0,
  cwd = `${HOME}/Projects/demo`,
  entrypoint = 'cli',
  effort,
}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: at,
    cwd,
    entrypoint,
    effort,
    message: {
      id,
      model,
      content: blocks,
      usage: {
        input_tokens: inp,
        output_tokens: out,
        cache_read_input_tokens: cacheR,
        cache_creation_input_tokens: cacheW,
      },
    },
  })
}

/** A prompt the person typed. `content` is a string, or an array when the prompt carried an attachment. */
export function prompt({ session, at, content = 'hello', cwd = `${HOME}/Projects/demo`, entrypoint = 'cli', isMeta }) {
  return JSON.stringify({
    type: 'user',
    sessionId: session,
    timestamp: at,
    cwd,
    entrypoint,
    isMeta,
    origin: { kind: 'human' },
    message: { role: 'user', content },
  })
}

/** A tool result: also a `user` line, never a prompt. `result` lands in `toolUseResult`. */
export function toolResult({ session, at, result = { stdout: 'done' }, cwd = `${HOME}/Projects/demo` }) {
  return JSON.stringify({
    type: 'user',
    sessionId: session,
    timestamp: at,
    cwd,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] },
    toolUseResult: result,
  })
}

export const title = ({ session, text: value }) =>
  JSON.stringify({ type: 'custom-title', customTitle: value, sessionId: session })
```

**Create `plugins/reflect/test/scan.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createClock } from '../indexer/clock.mjs'
import { projectOf, scanLines } from '../indexer/scan.mjs'
import { HOME, prompt, reply, text, title, toolResult, toolUse, utc } from './helpers.mjs'

const S = 'session-1'
const main = (fileId = S, clock = utc) => ({ kind: 'main', fileId, home: HOME, clock })
const sub = () => ({ kind: 'sub', fileId: 'agent-a1', home: HOME, clock: utc })
const DAY = '2026-03-01'
const at = (time) => `${DAY}T${time}.000Z`

test('a reply written as three lines counts its usage once', () => {
  const usage = { id: 'm1', session: S, at: at('10:00:00'), out: 100, inp: 3, cacheR: 50, cacheW: 7 }
  const summary = scanLines(
    [
      reply({ ...usage, blocks: [{ type: 'thinking', thinking: '' }] }),
      reply({ ...usage, blocks: [text('hi')] }),
      reply({ ...usage, blocks: [toolUse('t1', 'Bash')] }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.msgs, 1)
  assert.equal(day.out, 100)
  assert.equal(day.inp, 3)
  assert.equal(day.cacheR, 50)
  assert.equal(day.cacheW, 7)
  assert.deepEqual(day.models, { 'claude-opus-5-5': { msgs: 1, out: 100, inp: 3, cacheR: 50, cacheW: 7 } })
  assert.deepEqual(day.tools, { Bash: 1 })
})

test('a tool call is counted once per tool_use id, even when its line repeats', () => {
  const line = reply({ id: 'm1', session: S, at: at('10:00:00'), blocks: [toolUse('t1', 'Bash')] })
  const summary = scanLines(
    [line, line, reply({ id: 'm1', session: S, at: at('10:00:00'), blocks: [toolUse('t2', 'Read')] })],
    main(),
  )

  assert.deepEqual(summary.days[DAY].tools, { Bash: 1, Read: 1 })
})

test('in a main file, records carrying another session id are copies and are skipped', () => {
  const summary = scanLines(
    [
      title({ session: 'older', text: 'Old title' }),
      prompt({ session: 'older', at: at('09:00:00') }),
      reply({ id: 'm0', session: 'older', at: at('09:00:01'), out: 100 }),
      reply({ id: 'm1', session: S, at: at('10:00:00'), out: 5 }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.out, 5)
  assert.equal(day.msgs, 1)
  assert.equal(day.prompts, 0)
  assert.equal(summary.title, undefined)
})

test('a prompt is a user line whose own origin is human, with string or array content', () => {
  const summary = scanLines(
    [
      prompt({ session: S, at: at('10:00:00') }),
      prompt({ session: S, at: at('10:01:00'), content: [text('look'), { type: 'image', source: {} }] }),
      prompt({ session: S, at: at('10:02:00'), isMeta: true }),
      toolResult({ session: S, at: at('10:03:00') }),
      // Passes the cheap pre-filter because the words are on the line, but its own origin is not human.
      toolResult({ session: S, at: at('10:04:00'), result: { origin: { kind: 'human' } } }),
    ],
    main(),
  )

  assert.equal(summary.days[DAY].prompts, 2)
  assert.equal(summary.session.prompts, 2)
})

test('a subagent file adds to subMsgs, keeps records of its parent session, and is no session itself', () => {
  const summary = scanLines(
    [
      prompt({ session: 'parent', at: at('10:00:00') }),
      reply({ id: 'm1', session: 'parent', at: at('10:00:01'), out: 20 }),
    ],
    sub(),
  )
  const day = summary.days[DAY]

  assert.equal(day.subMsgs, 1)
  assert.equal(day.msgs, 0)
  assert.equal(day.out, 20)
  assert.equal(day.prompts, 0)
  assert.equal(summary.session, undefined)
})

test('a synthetic reply is ignored entirely', () => {
  const summary = scanLines(
    [reply({ id: 'm1', session: S, at: at('10:00:00'), model: '<synthetic>', blocks: [toolUse('t1', 'Bash')] })],
    main(),
  )

  assert.deepEqual(summary.days, {})
})

test('skills and MCP servers are read out of tool calls', () => {
  const summary = scanLines(
    [
      reply({
        id: 'm1',
        session: S,
        at: at('10:00:00'),
        blocks: [
          toolUse('a', 'Skill', { skill: 'superpowers:brainstorming' }),
          toolUse('b', 'mcp__github__create_issue'),
          toolUse('c', 'mcp__github__get_issue'),
          toolUse('d', 'Bash'),
        ],
      }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.deepEqual(day.tools, { Skill: 1, mcp__github__create_issue: 1, mcp__github__get_issue: 1, Bash: 1 })
  assert.deepEqual(day.skills, { 'superpowers:brainstorming': 1 })
  assert.deepEqual(day.mcp, { github: 2 })
})

test('days and hours are local to the clock it is given', () => {
  const lines = [prompt({ session: S, at: '2026-03-01T23:30:00.000Z' })]

  const inUtc = scanLines(lines, main())
  assert.equal(inUtc.days['2026-03-01'].hours[23], 1)

  const inBerlin = scanLines(lines, main(S, createClock('Europe/Berlin')))
  assert.equal(inBerlin.days['2026-03-01'], undefined)
  assert.equal(inBerlin.days['2026-03-02'].hours[0], 1)
})

test('active time sums the gaps under five minutes; a gap of exactly five is not one', () => {
  const summary = scanLines(
    [
      prompt({ session: S, at: at('10:00:00') }),
      reply({ id: 'm1', session: S, at: at('10:02:00') }), // 2 min: counts
      reply({ id: 'm2', session: S, at: at('10:07:00') }), // exactly 5 min: does not
      reply({ id: 'm3', session: S, at: at('10:08:30') }), // 90 s: counts
    ],
    main(),
  )

  assert.equal(summary.days[DAY].activeMs, 210_000)
  assert.deepEqual(summary.session, {
    start: Date.parse(at('10:00:00')),
    end: Date.parse(at('10:08:30')),
    activeMs: 210_000,
    prompts: 1,
    out: 30,
  })
})

test('projectOf names a project by its folder under home, and a worktree by its parent', () => {
  const cases = [
    [`${HOME}/Projects/demo`, 'demo'],
    [`${HOME}/Projects/demo/.claude/worktrees/keen-fox-1a2b3c`, 'demo'],
    [`${HOME}/Projects/demo/.superpowers/sdd/2026-01-01-x`, 'demo'],
    [`${HOME}/Projects/clients/acme`, 'clients/acme'],
    [`${HOME}/notes`, 'notes'],
    [HOME, '~'],
    ['/srv/data/site', '/srv/data/site'],
    ['/home/uther/x', '/home/uther/x'], // home is only a prefix of this name
    [undefined, '(unknown)'],
  ]

  for (const [cwd, expected] of cases) assert.equal(projectOf(cwd, HOME), expected, String(cwd))
})

test('the project and the entry point are the first ones seen; the title is the last', () => {
  const summary = scanLines(
    [
      title({ session: S, text: 'First' }),
      prompt({ session: S, at: at('10:00:00'), cwd: `${HOME}/Projects/alpha`, entrypoint: 'claude-desktop' }),
      reply({ id: 'm1', session: S, at: at('10:00:01'), cwd: `${HOME}/Projects/beta`, entrypoint: 'cli' }),
      title({ session: S, text: 'Second' }),
    ],
    main(),
  )

  assert.equal(summary.project, 'alpha')
  assert.equal(summary.entrypoint, 'claude-desktop')
  assert.equal(summary.title, 'Second')
})

test('a line that does not parse is counted and the rest still scanned', () => {
  const summary = scanLines(
    ['{"type":"assistant", broken', reply({ id: 'm1', session: S, at: at('10:00:00'), out: 4 })],
    main(),
  )

  assert.equal(summary.bad, 1)
  assert.equal(summary.days[DAY].out, 4)
})

test('effort levels are counted once per reply', () => {
  const summary = scanLines(
    [
      reply({ id: 'm1', session: S, at: at('10:00:00'), effort: 'high' }),
      reply({ id: 'm1', session: S, at: at('10:00:00'), effort: 'high' }),
      reply({ id: 'm2', session: S, at: at('10:00:01'), effort: 'max' }),
    ],
    main(),
  )

  assert.deepEqual(summary.days[DAY].efforts, { high: 1, max: 1 })
})

// Names come from the data. `map.constructor` is a function on every plain object.
test('a tool or a model named like an Object property is still just a name', () => {
  const summary = scanLines(
    [reply({ id: 'm1', session: S, at: at('10:00:00'), model: 'constructor', out: 9, blocks: [toolUse('t1', 'constructor')] })],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.tools.constructor, 1)
  assert.equal(day.models.constructor.out, 9)
})

test('a file with no usable record has no session and no days', () => {
  const summary = scanLines(['{"type":"system"}', ''], main())

  assert.deepEqual(summary.days, {})
  assert.equal(summary.session, undefined)
  assert.equal(summary.project, '(unknown)')
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test plugins/reflect/test/scan.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/scan.mjs`.

- [ ] **Step 7: Write the aggregate helpers**

**Create `plugins/reflect/indexer/agg.mjs`:**

```js
// Shapes and arithmetic for per-day aggregates.
//
// The keys of the count maps come from the data: tool names, model names,
// project folders. A plain property read cannot be trusted with them, because
// `map.constructor` is a function on every object, so all access goes through
// `own` and `bump`.

const NUMERIC = ['prompts', 'msgs', 'subMsgs', 'out', 'inp', 'cacheR', 'cacheW', 'activeMs']
const COUNT_MAPS = ['tools', 'skills', 'mcp', 'efforts']
const MODEL_FIELDS = ['msgs', 'out', 'inp', 'cacheR', 'cacheW']

// Assigning to `__proto__` on a plain object sets its prototype instead of a key.
const safeKey = (key) => (key === '__proto__' ? '(__proto__)' : String(key))

/** The value under `key`, created with `make()` when the map has no such key of its own. */
export function own(map, key, make) {
  const name = safeKey(key)
  if (!Object.hasOwn(map, name)) map[name] = make()
  return map[name]
}

export function bump(map, key, n = 1) {
  const name = safeKey(key)
  map[name] = (Object.hasOwn(map, name) ? map[name] : 0) + n
}

export function addCounts(target, source) {
  for (const [key, n] of Object.entries(source)) bump(target, key, n)
}

export const emptyModel = () => ({ msgs: 0, out: 0, inp: 0, cacheR: 0, cacheW: 0 })

/** What the scanner keeps for one file on one local day. */
export function emptyDay() {
  return {
    prompts: 0,
    hours: new Array(24).fill(0),
    msgs: 0,
    subMsgs: 0,
    out: 0,
    inp: 0,
    cacheR: 0,
    cacheW: 0,
    activeMs: 0,
    models: {},
    tools: {},
    skills: {},
    mcp: {},
    efforts: {},
  }
}

/** One day across every file: a day aggregate plus who contributed to it. */
export function emptyMergedDay() {
  return { ...emptyDay(), sessions: 0, projects: {} }
}

/**
 * Adds one file's summary into a map of merged days. This is the only place
 * that knows how a file contributes to a day, so a file folded into the frozen
 * total and a file still on disk cannot be counted differently.
 */
export function addSummary(days, summary) {
  for (const [day, agg] of Object.entries(summary.days)) {
    const target = own(days, day, emptyMergedDay)
    for (const field of NUMERIC) target[field] += agg[field]
    for (let hour = 0; hour < 24; hour += 1) target.hours[hour] += agg.hours[hour]
    for (const field of COUNT_MAPS) addCounts(target[field], agg[field])
    for (const [model, usage] of Object.entries(agg.models)) {
      const sum = own(target.models, model, emptyModel)
      for (const field of MODEL_FIELDS) sum[field] += usage[field]
    }
    const project = own(target.projects, summary.project, () => ({ prompts: 0, out: 0, sessions: 0 }))
    project.prompts += agg.prompts
    project.out += agg.out
    if (summary.kind === 'main') {
      target.sessions += 1
      project.sessions += 1
    }
  }
}
```

- [ ] **Step 8: Write the scanner**

**Create `plugins/reflect/indexer/scan.mjs`:**

```js
// One transcript file, line by line, into a FileSummary. Pure: no file access.
// The record shapes this relies on are the measured ones in section 4.2 of
// docs/superpowers/specs/2026-10-07-reflect-design.md.
import { bump, emptyDay, emptyModel, own } from './agg.mjs'

const ACTIVE_GAP_MS = 5 * 60 * 1000
const NESTED_MARKERS = ['/.claude/worktrees/', '/.superpowers/']

const count = (value) => (Number.isFinite(value) ? value : 0)

/** A project's name from a working directory: relative to home, a worktree counted as its parent. */
export function projectOf(cwd, home) {
  if (typeof cwd !== 'string' || cwd === '') return '(unknown)'
  let path = cwd
  for (const marker of NESTED_MARKERS) {
    const at = path.indexOf(marker)
    if (at !== -1) path = path.slice(0, at)
  }
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) path = path.slice(home.length + 1)
  if (path.startsWith('Projects/')) path = path.slice('Projects/'.length)
  return path
}

// Most lines are tool results, some of them megabytes long. Only three kinds of
// line matter, and each can be recognised without parsing. This is a pre-filter
// only: what a line is gets decided from the parsed record.
function mayMatter(line) {
  return (
    line.includes('"type":"assistant"') ||
    (line.includes('"type":"user"') && line.includes('"kind":"human"')) ||
    line.includes('"type":"custom-title"')
  )
}

export function createScanner({ kind, fileId, home, clock }) {
  const isMain = kind === 'main'
  const summary = { kind, sessionId: fileId, project: null, days: {}, bad: 0 }
  const session = { start: null, end: null, activeMs: 0, prompts: 0, out: 0 }
  const seenMessages = new Set()
  const seenTools = new Set()
  let lastAt = null

  // Main files only: the session's span, and time counted as active.
  function touch(ms, agg) {
    if (session.start === null || ms < session.start) session.start = ms
    if (session.end === null || ms > session.end) session.end = ms
    if (lastAt !== null) {
      const gap = ms - lastAt
      if (gap > 0 && gap < ACTIVE_GAP_MS) {
        session.activeMs += gap
        agg.activeMs += gap
      }
    }
    lastAt = ms
  }

  function prompt(record, ms) {
    if (!isMain || record.origin?.kind !== 'human' || record.isMeta === true) return
    const { day, hour } = clock(ms)
    const agg = own(summary.days, day, emptyDay)
    touch(ms, agg)
    agg.prompts += 1
    agg.hours[hour] += 1
    session.prompts += 1
  }

  function reply(record, ms) {
    const message = record.message
    if (message === null || typeof message !== 'object' || message.model === '<synthetic>') return
    const agg = own(summary.days, clock(ms).day, emptyDay)
    if (isMain) touch(ms, agg)

    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || seenTools.has(block.id)) continue
      seenTools.add(block.id)
      const name = String(block.name)
      bump(agg.tools, name)
      if (name === 'Skill' && typeof block.input?.skill === 'string') bump(agg.skills, block.input.skill)
      if (name.startsWith('mcp__')) bump(agg.mcp, name.split('__')[1] ?? '')
    }

    // Every line of one reply repeats the same usage: count it on the first only.
    if (typeof message.id !== 'string' || seenMessages.has(message.id)) return
    seenMessages.add(message.id)

    const usage = message.usage ?? {}
    const out = count(usage.output_tokens)
    const inp = count(usage.input_tokens)
    const cacheR = count(usage.cache_read_input_tokens)
    const cacheW = count(usage.cache_creation_input_tokens)

    if (isMain) {
      agg.msgs += 1
      session.out += out
    } else {
      agg.subMsgs += 1
    }
    agg.out += out
    agg.inp += inp
    agg.cacheR += cacheR
    agg.cacheW += cacheW

    const model = own(agg.models, typeof message.model === 'string' ? message.model : '(unknown)', emptyModel)
    model.msgs += 1
    model.out += out
    model.inp += inp
    model.cacheR += cacheR
    model.cacheW += cacheW

    if (typeof record.effort === 'string') bump(agg.efforts, record.effort)
  }

  return {
    push(line) {
      if (!mayMatter(line)) return
      let record
      try {
        record = JSON.parse(line)
      } catch {
        summary.bad += 1
        return
      }
      if (record === null || typeof record !== 'object') return
      // A resumed session copies earlier records in under their old session id.
      if (isMain && record.sessionId !== fileId) return

      if (record.type === 'custom-title') {
        if (isMain && typeof record.customTitle === 'string') summary.title = record.customTitle
        return
      }

      const ms = Date.parse(record.timestamp)
      if (Number.isNaN(ms)) return
      if (summary.project === null && typeof record.cwd === 'string') summary.project = projectOf(record.cwd, home)
      if (isMain && summary.entrypoint === undefined && typeof record.entrypoint === 'string') {
        summary.entrypoint = record.entrypoint
      }

      if (record.type === 'user') prompt(record, ms)
      else if (record.type === 'assistant') reply(record, ms)
    },

    finish() {
      if (summary.project === null) summary.project = '(unknown)'
      if (isMain && session.start !== null) summary.session = session
      return summary
    },
  }
}

export function scanLines(lines, options) {
  const scanner = createScanner(options)
  for (const line of lines) scanner.push(line)
  return scanner.finish()
}
```

- [ ] **Step 9: Run the scanner tests to verify they pass**

Run: `node --test plugins/reflect/test/scan.test.mjs plugins/reflect/test/clock.test.mjs`
Expected: 20 tests (15 scanner, 5 clock), all PASS.

- [ ] **Step 10: Mutation-check**

Do each one, run `HOME=$(mktemp -d) node --test plugins/reflect/test/scan.test.mjs plugins/reflect/test/clock.test.mjs`, confirm the named test fails, restore:

| Mutation | Test that must fail |
|---|---|
| `scan.mjs`: delete the `seenMessages.has(message.id)` return | "a reply written as three lines counts its usage once" |
| `scan.mjs`: delete the `seenTools.has(block.id)` check | "a tool call is counted once per tool_use id" |
| `scan.mjs`: delete the `record.sessionId !== fileId` return | "records carrying another session id are copies" |
| `scan.mjs`: delete `record.origin?.kind !== 'human' ||` from `prompt` | "a prompt is a user line whose own origin is human" |
| `scan.mjs`: change `gap < ACTIVE_GAP_MS` to `gap <= ACTIVE_GAP_MS` | "active time sums the gaps under five minutes" |
| `scan.mjs`: change ``path.startsWith(`${home}/`)`` to `path.startsWith(home)` | "projectOf names a project by its folder under home" |
| `agg.mjs`: in `bump`, replace the `Object.hasOwn` test with `map[name] ?? 0` | "a tool or a model named like an Object property" |
| `clock.mjs`: change `QUARTER_HOUR` to `60 * 60 * 1000` | "the cache does not blur a zone whose offset is not a whole hour" |

- [ ] **Step 11: Run everything and commit**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 285`, `# pass 285`, `# fail 0`.

```bash
git add plugins/reflect/indexer/clock.mjs plugins/reflect/indexer/agg.mjs plugins/reflect/indexer/scan.mjs plugins/reflect/test/helpers.mjs plugins/reflect/test/clock.test.mjs plugins/reflect/test/scan.test.mjs
git commit -m "feat(reflect): scan one transcript into per-day aggregates"
```

---

### Task 3: The store

One JSON file holding a summary per transcript still on disk, a frozen total for transcripts that are gone, and one row per session. Three properties matter and each has a test:

- **A fold is exact and happens once.** When a transcript is deleted, its summary is added into `frozen.days` and its record removed. Merged totals must be identical before and after.
- **A save is atomic and private.** Written to a fresh temp file created with mode 600, then renamed. This repo once shipped a file at mode 644 because the mode was only applied on creation and a stale temp file already existed; the `wx` flag makes that impossible here.
- **Reading never changes the disk.** An unusable store is reported and left in place. Only the caller that holds the lock moves it aside.

**Files:**
- Create: `plugins/reflect/indexer/store.mjs`
- Test: `plugins/reflect/test/store.test.mjs`

**Interfaces:**
- Consumes: `addSummary`, `emptyDay` from `agg.mjs` (Task 2).
- Produces, all from `store.mjs`:
  - `STORE_VERSION = 1`
  - `emptyStore(): Store`
  - `readStore(dir): { store: Store, lost: null | 'unreadable' | 'wrong-version' }`
  - `quarantine(dir, now: number): void` renames `store.json` to `store.corrupt-<now>.json`
  - `saveStore(dir, store): void`
  - `acquireLock(dir, now = Date.now()): null | (() => void)`
  - `upsertFile(store, rel, { size, mtimeMs }, summary): void`
  - `foldFile(store, rel): void`
  - `mergedDays(store): { [day]: MergedDay }`

- [ ] **Step 1: Write the failing tests**

**Create `plugins/reflect/test/store.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { emptyDay } from '../indexer/agg.mjs'
import {
  acquireLock,
  emptyStore,
  foldFile,
  mergedDays,
  quarantine,
  readStore,
  saveStore,
  upsertFile,
} from '../indexer/store.mjs'
import { tempDir } from './helpers.mjs'

const STAT = { size: 10, mtimeMs: 1000 }
const SESSION = { start: 100, end: 900, activeMs: 300, prompts: 2, out: 10 }
const DAY = '2026-03-01'
const MAIN = 'p/main.jsonl'
const SUB = 'p/main/subagents/agent-a.jsonl'

const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}
const usage = (msgs, out) => ({ msgs, out, inp: 0, cacheR: 0, cacheW: 0 })

function summary(kind, id, project, perDay, session) {
  const days = {}
  for (const [day, fields] of Object.entries(perDay)) days[day] = { ...emptyDay(), ...fields }
  const made = { kind, sessionId: id, project, days, bad: 0 }
  if (session !== undefined) made.session = session
  return made
}

/** A main file and a subagent file, both in project `demo`, both on the same day. */
function twoFiles() {
  const store = emptyStore()
  upsertFile(
    store,
    MAIN,
    STAT,
    summary(
      'main',
      'main',
      'demo',
      { [DAY]: { prompts: 2, hours: hoursAt(9, 2), msgs: 1, out: 10, tools: { Bash: 2 }, models: { opus: usage(1, 10) } } },
      SESSION,
    ),
  )
  upsertFile(
    store,
    SUB,
    STAT,
    summary('sub', 'agent-a', 'demo', {
      [DAY]: { subMsgs: 3, out: 5, tools: { Bash: 1, Read: 1 }, models: { opus: usage(3, 5) } },
    }),
  )
  return store
}

test('files on the same day add up, and only a main file counts as a session', () => {
  const day = mergedDays(twoFiles())[DAY]

  assert.equal(day.prompts, 2)
  assert.equal(day.out, 15)
  assert.equal(day.msgs, 1)
  assert.equal(day.subMsgs, 3)
  assert.equal(day.sessions, 1)
  assert.equal(day.hours[9], 2)
  assert.deepEqual(day.tools, { Bash: 3, Read: 1 })
  assert.deepEqual(day.models, { opus: usage(4, 15) })
  assert.deepEqual(day.projects, { demo: { prompts: 2, out: 15, sessions: 1 } })
})

test('folding a file moves its numbers into the frozen total exactly once', () => {
  const store = twoFiles()
  const before = mergedDays(store)

  foldFile(store, MAIN)
  assert.equal(store.files[MAIN], undefined)
  assert.deepEqual(mergedDays(store), before)

  foldFile(store, MAIN) // already folded: there is nothing left to add
  assert.deepEqual(mergedDays(store), before)
})

test('reading the merged days does not change the frozen total', () => {
  const store = twoFiles()
  foldFile(store, MAIN)
  const frozen = structuredClone(store.frozen)

  mergedDays(store)
  mergedDays(store)

  assert.deepEqual(store.frozen, frozen)
})

test('a main file keeps one session row, replaced on rescan and kept after a fold', () => {
  const store = twoFiles()
  assert.deepEqual(store.sessions, [{ id: 'main', project: 'demo', title: null, entrypoint: null, ...SESSION }])

  const again = summary('main', 'main', 'demo', {}, { ...SESSION, prompts: 5 })
  again.title = 'Named'
  again.entrypoint = 'cli'
  upsertFile(store, MAIN, STAT, again)
  assert.deepEqual(store.sessions, [{ id: 'main', project: 'demo', title: 'Named', entrypoint: 'cli', ...SESSION, prompts: 5 }])

  foldFile(store, MAIN)
  assert.equal(store.sessions.length, 1)
})

test('a main file whose rescan finds no records loses its row', () => {
  const store = twoFiles()

  upsertFile(store, MAIN, STAT, summary('main', 'main', 'demo', {}))

  assert.deepEqual(store.sessions, [])
})

test('a saved store reads back the same, is private, and leaves no temp file', (t) => {
  const dir = join(tempDir(t), 'nested', 'reflect')
  const store = twoFiles()

  saveStore(dir, store)

  assert.deepEqual(readStore(dir), { store, lost: null })
  assert.equal(statSync(join(dir, 'store.json')).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['store.json'])
})

test('a failed save removes its temp file', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'store.json')) // a directory where the file belongs makes the rename fail
  writeFileSync(join(dir, 'store.json', 'in-the-way'), '')

  assert.throws(() => saveStore(dir, emptyStore()))

  assert.deepEqual(readdirSync(dir), ['store.json'])
})

test('a missing store is an empty one, not a loss', (t) => {
  assert.deepEqual(readStore(tempDir(t)), { store: emptyStore(), lost: null })
})

test('an unusable store is reported and left in place until it is moved aside', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.json')

  writeFileSync(path, 'not json')
  assert.deepEqual(readStore(dir), { store: emptyStore(), lost: 'unreadable' })
  assert.equal(readFileSync(path, 'utf8'), 'not json')

  writeFileSync(path, JSON.stringify({ ...emptyStore(), version: 2 }))
  assert.equal(readStore(dir).lost, 'wrong-version')

  quarantine(dir, 1234)
  assert.deepEqual(readdirSync(dir), ['store.corrupt-1234.json'])
})

test('the lock is held by one caller at a time and leaves nothing behind', (t) => {
  const dir = tempDir(t)

  const release = acquireLock(dir)
  assert.equal(typeof release, 'function')
  assert.equal(acquireLock(dir), null)

  release()
  const second = acquireLock(dir)
  assert.equal(typeof second, 'function')
  second()
  assert.deepEqual(readdirSync(dir), [])
})

test('a lock older than two minutes is abandoned and taken over; a younger one is not', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'store.lock')
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000)

  writeFileSync(path, 'someone else')
  utimesSync(path, minutesAgo(1), minutesAgo(1))
  assert.equal(acquireLock(dir), null)

  utimesSync(path, minutesAgo(3), minutesAgo(3))
  const release = acquireLock(dir)
  assert.equal(typeof release, 'function')
  release()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/store.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/store.mjs`.

- [ ] **Step 3: Write the store**

**Create `plugins/reflect/indexer/store.mjs`:**

```js
// The store: one summary per transcript file still on disk, a frozen total for
// files that are gone, and one row per session. A single JSON file.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addSummary } from './agg.mjs'

export const STORE_VERSION = 1

const STORE_FILE = 'store.json'
const LOCK_FILE = 'store.lock'
const STALE_LOCK_MS = 2 * 60 * 1000

export function emptyStore() {
  return { version: STORE_VERSION, root: null, files: {}, frozen: { days: {} }, sessions: [] }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function isStore(value) {
  return (
    isObject(value) &&
    value.version === STORE_VERSION &&
    isObject(value.files) &&
    isObject(value.frozen) &&
    isObject(value.frozen.days) &&
    Array.isArray(value.sessions)
  )
}

/**
 * Reads the store and changes nothing on disk.
 * @returns {{ store: object, lost: null | 'unreadable' | 'wrong-version' }} an
 *   empty store and the reason when the file is there but cannot be used
 */
export function readStore(dir) {
  let text
  try {
    text = readFileSync(join(dir, STORE_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { store: emptyStore(), lost: null }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { store: emptyStore(), lost: 'unreadable' }
  }
  if (!isStore(parsed)) return { store: emptyStore(), lost: 'wrong-version' }
  return { store: parsed, lost: null }
}

/** Moves an unusable store aside, so the next save does not overwrite the only copy of it. */
export function quarantine(dir, now) {
  renameSync(join(dir, STORE_FILE), join(dir, `store.corrupt-${now}.json`))
}

/**
 * Saves through a temp file that is always newly created (`wx`), so the mode is
 * always applied and a reader never sees half a store.
 */
export function saveStore(dir, store) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `store.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(store), { flag: 'wx', mode: 0o600 })
    renameSync(temp, join(dir, STORE_FILE))
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function isStale(path, now) {
  try {
    return now - statSync(path).mtimeMs > STALE_LOCK_MS
  } catch (err) {
    if (err.code === 'ENOENT') return true // released between our two looks at it
    throw err
  }
}

/**
 * Takes the index lock.
 * @returns {null | (() => void)} the function that releases it, or null while
 *   another process holds a lock younger than two minutes
 */
export function acquireLock(dir, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 })
      return () => rmSync(path, { force: true })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (!isStale(path, now)) return null
      rmSync(path, { force: true }) // abandoned: take it on the second pass
    }
  }
  return null
}

/** Records a scanned file, and keeps the session row of a main file in step with it. */
export function upsertFile(store, rel, { size, mtimeMs }, summary) {
  store.files[rel] = { size, mtimeMs, summary }
  if (summary.kind !== 'main') return

  const at = store.sessions.findIndex((row) => row.id === summary.sessionId)
  if (summary.session === undefined) {
    if (at !== -1) store.sessions.splice(at, 1)
    return
  }
  const row = {
    id: summary.sessionId,
    project: summary.project,
    title: summary.title ?? null,
    entrypoint: summary.entrypoint ?? null,
    ...summary.session,
  }
  if (at === -1) store.sessions.push(row)
  else store.sessions[at] = row
}

/**
 * Moves a file's numbers into the frozen total and forgets the file. For a
 * transcript that no longer exists: its session row stays, and so does
 * everything it ever contributed.
 */
export function foldFile(store, rel) {
  if (!Object.hasOwn(store.files, rel)) return
  addSummary(store.frozen.days, store.files[rel].summary)
  delete store.files[rel]
}

/** Every day the store knows, frozen and live together. The store itself is not changed. */
export function mergedDays(store) {
  const days = structuredClone(store.frozen.days)
  for (const { summary } of Object.values(store.files)) addSummary(days, summary)
  return days
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/reflect/test/store.test.mjs`
Expected: 11 tests, all PASS.

- [ ] **Step 5: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| `foldFile`: delete the `delete store.files[rel]` line | "folding a file moves its numbers into the frozen total exactly once" |
| `foldFile`: delete the `addSummary(...)` line | the same test |
| `mergedDays`: replace `structuredClone(store.frozen.days)` with `store.frozen.days` | "reading the merged days does not change the frozen total" |
| `saveStore`: change `mode: 0o600` to `mode: 0o644` | "a saved store reads back the same, is private" |
| `saveStore`: delete the `rmSync(temp, { force: true })` line | "a failed save removes its temp file" |
| `readStore`: return `{ store: parsed, lost: null }` without the `isStore` check | "an unusable store is reported and left in place" |
| `isStale`: change `>` to `<` | "a lock older than two minutes is abandoned" |
| `upsertFile`: delete the `if (at !== -1) store.sessions.splice(at, 1)` line | "a main file whose rescan finds no records loses its row" |
| `upsertFile`: replace `else store.sessions[at] = row` with `else store.sessions.push(row)` | "a main file keeps one session row" |

- [ ] **Step 6: Run everything and commit**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 296`, `# pass 296`, `# fail 0`.

```bash
git add plugins/reflect/indexer/store.mjs plugins/reflect/test/store.test.mjs
git commit -m "feat(reflect): store with atomic save, lock and exact fold"
```

---

### Task 4: Incremental update

Walks the transcripts folder, rescans only files whose size or mtime changed, and folds files that are gone. Folding is permanent, so this task carries two guards against folding by mistake:

- A store remembers the folder it was built from (`store.root`) and refuses any other.
- If that folder is missing while the store still knows files in it, that is an error, not "everything was deleted".

**Files:**
- Create: `plugins/reflect/indexer/update.mjs`
- Test: `plugins/reflect/test/update.test.mjs`

**Interfaces:**
- Consumes: `createScanner` from `scan.mjs` (Task 2); `foldFile`, `upsertFile`, `emptyStore`, `mergedDays` from `store.mjs` (Task 3).
- Produces, from `update.mjs`:
  - `listTranscripts(root): null | Array<{ rel, path, size, mtimeMs }>` — `null` when `root` does not exist; `rel` uses forward slashes; sorted by `rel`.
  - `scanFile(path, { kind, fileId, home, clock }): Promise<FileSummary>`
  - `updateStore(store, root, { home, clock, scan = scanFile }): Promise<{ scanned, kept, folded, vanished }>` — mutates `store`; throws when `store.root` is another folder, or when `root` is missing and the store still has files.
- A file is a subagent file when one of its path segments is `subagents`; otherwise it is a main file whose `fileId` is its name without `.jsonl`.

- [ ] **Step 1: Write the failing tests**

**Create `plugins/reflect/test/update.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { emptyStore, mergedDays } from '../indexer/store.mjs'
import { listTranscripts, updateStore } from '../indexer/update.mjs'
import { HOME, prompt, reply, tempDir, toolUse, utc } from './helpers.mjs'

const OPTIONS = { home: HOME, clock: utc }
const PROJECT = '-home-u-Projects-demo'
const MAIN = `${PROJECT}/s1.jsonl`
const SUB = `${PROJECT}/s1/subagents/agent-a1.jsonl`
const DAY = '2026-03-01'
const at = (time) => `${DAY}T${time}.000Z`

function write(root, rel, lines) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
}

/** One main session with a prompt and a reply, and one subagent file under it. */
function seed(root) {
  write(root, MAIN, [
    prompt({ session: 's1', at: at('10:00:00') }),
    reply({ id: 'm1', session: 's1', at: at('10:00:05'), out: 40, blocks: [toolUse('t1', 'Bash')] }),
  ])
  write(root, SUB, [reply({ id: 'm2', session: 's1', at: at('10:00:10'), out: 7 })])
}

test('the first run scans every transcript; a second run with nothing changed scans none', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 2, kept: 0, folded: 0, vanished: 0 })
  const day = mergedDays(store)[DAY]
  assert.equal(day.prompts, 1)
  assert.equal(day.out, 47)
  assert.equal(day.msgs, 1) // the main file's reply
  assert.equal(day.subMsgs, 1) // the subagent file's, kept although its session id is the parent's
  assert.equal(day.sessions, 1)

  const saved = JSON.stringify(store)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 2, folded: 0, vanished: 0 })
  assert.equal(JSON.stringify(store), saved)
})

test('a file that grew is rescanned, and its numbers replace the old ones', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)

  appendFileSync(join(root, MAIN), `${reply({ id: 'm3', session: 's1', at: at('10:01:00'), out: 100 })}\n`)

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 1, kept: 1, folded: 0, vanished: 0 })
  assert.equal(mergedDays(store)[DAY].out, 147)
  assert.equal(store.sessions.length, 1)
  assert.equal(store.sessions[0].out, 140)
})

// Both halves are needed: a rewrite can keep the length, and a restore can keep the time.
test('a change of size alone, or of modification time alone, is a change', async (t) => {
  const root = tempDir(t)
  const path = join(root, MAIN)
  const stamp = (seconds) => new Date(seconds * 1000)
  const lines = (out) => [
    prompt({ session: 's1', at: at('10:00:00') }),
    reply({ id: 'm1', session: 's1', at: at('10:00:05'), out }),
  ]
  const extra = reply({ id: 'm2', session: 's1', at: at('10:00:09'), out: 5 })
  write(root, MAIN, lines(40))
  utimesSync(path, stamp(1_700_000_000), stamp(1_700_000_000))
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)

  write(root, MAIN, [...lines(40), extra])
  utimesSync(path, stamp(1_700_000_000), stamp(1_700_000_000)) // longer, same time
  await updateStore(store, root, OPTIONS)
  assert.equal(mergedDays(store)[DAY].out, 45)

  write(root, MAIN, [...lines(41), extra])
  utimesSync(path, stamp(1_700_000_100), stamp(1_700_000_100)) // same length, later time
  await updateStore(store, root, OPTIONS)
  assert.equal(mergedDays(store)[DAY].out, 46)
})

test('a deleted transcript is folded once and its numbers stay for good', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)
  const rows = structuredClone(store.sessions)

  rmSync(join(root, MAIN))

  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 1, folded: 1, vanished: 0 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(await updateStore(store, root, OPTIONS), { scanned: 0, kept: 1, folded: 0, vanished: 0 })
  assert.deepEqual(mergedDays(store), before)
  assert.deepEqual(store.sessions, rows)
})

test('updating in two steps gives the same history as one full scan', async (t) => {
  const root = tempDir(t)
  const stepwise = emptyStore()
  seed(root)
  await updateStore(stepwise, root, OPTIONS)
  write(root, `${PROJECT}/s2.jsonl`, [
    prompt({ session: 's2', at: '2026-03-02T08:00:00.000Z' }),
    reply({ id: 'm9', session: 's2', at: '2026-03-02T08:00:03.000Z', out: 11 }),
  ])
  await updateStore(stepwise, root, OPTIONS)

  const full = emptyStore()
  await updateStore(full, root, OPTIONS)

  assert.deepEqual(mergedDays(stepwise), mergedDays(full))
  assert.deepEqual(stepwise.sessions, full.sessions)
})

test('a store built from one folder refuses another, and folds nothing', async (t) => {
  const first = tempDir(t)
  const other = tempDir(t)
  seed(first)
  const store = emptyStore()
  await updateStore(store, first, OPTIONS)
  const saved = JSON.stringify(store)

  await assert.rejects(updateStore(store, other, OPTIONS), /was built from/)

  assert.equal(JSON.stringify(store), saved)
})

test('a missing transcripts folder is an empty history for a new store, and an error for one that knows files', async (t) => {
  const root = join(tempDir(t), 'projects')
  const fresh = emptyStore()
  assert.deepEqual(await updateStore(fresh, root, OPTIONS), { scanned: 0, kept: 0, folded: 0, vanished: 0 })
  assert.deepEqual(mergedDays(fresh), {})

  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const saved = JSON.stringify(store)
  rmSync(root, { recursive: true })

  await assert.rejects(updateStore(store, root, OPTIONS), /is missing/)
  assert.equal(JSON.stringify(store), saved)
})

test('a file that vanishes while being read is gone: an earlier record of it is folded', async (t) => {
  const root = tempDir(t)
  seed(root)
  const store = emptyStore()
  await updateStore(store, root, OPTIONS)
  const before = mergedDays(store)
  appendFileSync(join(root, MAIN), '\n') // changed, so it is due for a rescan

  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const result = await updateStore(store, root, { ...OPTIONS, scan: async () => { throw gone } })

  assert.deepEqual(result, { scanned: 0, kept: 1, folded: 1, vanished: 1 })
  assert.deepEqual(mergedDays(store), before)
})

test('any other failure while reading a file stops the update', async (t) => {
  const root = tempDir(t)
  seed(root)

  await assert.rejects(
    updateStore(emptyStore(), root, { ...OPTIONS, scan: async () => { throw new Error('disk on fire') } }),
    /disk on fire/,
  )
})

test('listTranscripts finds .jsonl files at any depth, by forward-slash path, sorted, and nothing else', (t) => {
  const root = tempDir(t)
  seed(root)
  write(root, `${PROJECT}/memory/MEMORY.md`, ['notes'])
  write(root, `${PROJECT}/s1/tool-results/out.json`, ['{}'])

  assert.deepEqual(listTranscripts(root).map((file) => file.rel), [MAIN, SUB])
  assert.equal(listTranscripts(join(root, 'nowhere')), null)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/update.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/update.mjs`.

- [ ] **Step 3: Write the update**

**Create `plugins/reflect/indexer/update.mjs`:**

```js
// Brings the store up to date with the transcripts on disk: rescans the files
// that changed and folds the files that are gone into the frozen total.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { createScanner } from './scan.mjs'
import { foldFile, upsertFile } from './store.mjs'

/**
 * Every `*.jsonl` under `root`, or null when `root` does not exist. A folder
 * deleted while we walk is simply not there; any other failure is thrown,
 * because a folder we could not read must never look like deleted files.
 */
export function listTranscripts(root) {
  const found = []
  let isRootMissing = false

  const walk = (dir, isRoot) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      if (isRoot) isRootMissing = true
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, false)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let stat
        try {
          stat = statSync(path)
        } catch (err) {
          if (err.code === 'ENOENT') continue
          throw err
        }
        found.push({ rel: relative(root, path).split(sep).join('/'), path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }

  walk(root, true)
  if (isRootMissing) return null
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** Reads one transcript as a stream: some are tens of megabytes. */
export async function scanFile(path, options) {
  const scanner = createScanner(options)
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) scanner.push(line)
  return scanner.finish()
}

export async function updateStore(store, root, { home, clock, scan = scanFile }) {
  // A fold cannot be undone. A store pointed at another folder would see every
  // file as deleted, fold them all, and count them a second time when pointed back.
  if (store.root !== null && store.root !== root) {
    throw new Error(`the saved history was built from ${store.root}, not ${root}`)
  }
  const onDisk = listTranscripts(root)
  const result = { scanned: 0, kept: 0, folded: 0, vanished: 0 }
  if (onDisk === null) {
    if (Object.keys(store.files).length > 0) throw new Error(`the transcripts folder is missing: ${root}`)
    return result
  }
  store.root = root

  const present = new Set()
  for (const file of onDisk) {
    const known = Object.hasOwn(store.files, file.rel) ? store.files[file.rel] : null
    if (known !== null && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      present.add(file.rel)
      result.kept += 1
      continue
    }
    const kind = file.rel.split('/').includes('subagents') ? 'sub' : 'main'
    let summary
    try {
      summary = await scan(file.path, { kind, fileId: basename(file.rel, '.jsonl'), home, clock })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      result.vanished += 1 // deleted between the listing and the read: it is folded below if we knew it
      continue
    }
    present.add(file.rel)
    upsertFile(store, file.rel, file, summary)
    result.scanned += 1
  }

  for (const rel of Object.keys(store.files)) {
    if (present.has(rel)) continue
    foldFile(store, rel)
    result.folded += 1
  }
  return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/reflect/test/update.test.mjs`
Expected: 10 tests, all PASS.

- [ ] **Step 5: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| Replace the condition `known !== null && known.size === file.size && known.mtimeMs === file.mtimeMs` with `false` (always rescan) | "a second run with nothing changed scans none" |
| Drop `known.size === file.size &&` from that condition | "a change of size alone, or of modification time alone" |
| Drop `&& known.mtimeMs === file.mtimeMs` from that condition | the same test |
| Delete the whole `for (const rel of Object.keys(store.files))` fold loop | "a deleted transcript is folded once" |
| Delete the `store.root !== root` guard | "a store built from one folder refuses another" |
| Replace the `onDisk === null` branch with `const list = onDisk ?? []` and continue | "a missing transcripts folder is … an error for one that knows files" |
| Change `? 'sub' : 'main'` to `? 'main' : 'main'` | "the first run scans every transcript" |
| Change `if (err.code !== 'ENOENT') throw err` in `updateStore` to `throw err` | "a file that vanishes while being read is gone" |
| In `listTranscripts`, drop `&& entry.name.endsWith('.jsonl')` | "listTranscripts finds .jsonl files at any depth" |

- [ ] **Step 6: Run everything and commit**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 306`, `# pass 306`, `# fail 0`.

```bash
git add plugins/reflect/indexer/update.mjs plugins/reflect/test/update.test.mjs
git commit -m "feat(reflect): incremental update that folds deleted transcripts"
```

---

### Task 5: The two side sources

Both are optional and both are read-only.

- **`history.jsonl`** has one line per prompt typed in a terminal session, with `timestamp` in epoch milliseconds. Desktop sessions do not write to it, so it matters for the months before the surviving transcripts begin.
- **claude-mem** is another plugin's SQLite database. Its `observations` table has `project`, `type` and `created_at_epoch` (milliseconds). It is read through the `sqlite3` command line tool, because this repo has no dependencies. Without the tool or the file there is simply no work mix.

**Files:**
- Create: `plugins/reflect/indexer/history.mjs`
- Create: `plugins/reflect/indexer/mem.mjs`
- Test: `plugins/reflect/test/sources.test.mjs`

**Interfaces:**
- Consumes: a clock from `clock.mjs` (Task 2).
- Produces:
  - `history.mjs`: `readHistory(text: string, clock): { [day]: { prompts: number, hours: number[24] } }`
  - `mem.mjs`: `WORK_SQL: string`; `readWork(dbPath, clock, run?): null | Array<{ day, project, type, n }>` sorted by day, project, type. `run(argv: string[]): string` runs a command and returns its stdout; the default runs the real one. `null` means the work mix is unavailable; `[]` means it is available and empty.

- [ ] **Step 1: Write the failing tests**

**Create `plugins/reflect/test/sources.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { readHistory } from '../indexer/history.mjs'
import { readWork, WORK_SQL } from '../indexer/mem.mjs'
import { tempDir, utc } from './helpers.mjs'

const ms = (iso) => Date.parse(iso)
const quarter = (iso) => Math.floor(ms(iso) / 900_000)
const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}

test('history counts prompts per local day and hour and skips what it cannot read', () => {
  const text = [
    JSON.stringify({ timestamp: ms('2026-03-01T09:15:00Z'), project: '/x', sessionId: 'a', display: 'one' }),
    JSON.stringify({ timestamp: ms('2026-03-01T09:45:00Z'), project: '/x', sessionId: 'a', display: 'two' }),
    JSON.stringify({ timestamp: ms('2026-03-02T23:10:00Z'), project: '/x', sessionId: 'b', display: 'three' }),
    'not json',
    JSON.stringify({ timestamp: 'soon' }),
    'null',
    '',
  ].join('\n')

  assert.deepEqual(readHistory(text, utc), {
    '2026-03-01': { prompts: 2, hours: hoursAt(9, 2) },
    '2026-03-02': { prompts: 1, hours: hoursAt(23, 1) },
  })
})

test('an empty history file is no days', () => {
  assert.deepEqual(readHistory('', utc), {})
})

test('work rows are bucketed by local day and merged across the quarter hours of a day', () => {
  const calls = []
  const run = (argv) => {
    calls.push(argv)
    return JSON.stringify([
      { q: quarter('2026-03-01T09:00:00Z'), project: 'demo', type: 'feature', n: 2 },
      { q: quarter('2026-03-01T09:15:00Z'), project: 'demo', type: 'feature', n: 3 },
      { q: quarter('2026-03-02T00:00:00Z'), project: 'demo', type: 'bugfix', n: 1 },
      { q: 'not a number', project: 'demo', type: 'bugfix', n: 1 },
    ])
  }

  const rows = readWork('/nowhere/mem.db', utc, run)

  assert.deepEqual(rows, [
    { day: '2026-03-01', project: 'demo', type: 'feature', n: 5 },
    { day: '2026-03-02', project: 'demo', type: 'bugfix', n: 1 },
  ])
  assert.deepEqual(calls, [['sqlite3', '-readonly', '-json', '/nowhere/mem.db', WORK_SQL]])
})

test('no sqlite3, a failing query, or output that is not rows all mean no work mix', () => {
  const failing = () => {
    throw new Error('spawn sqlite3 ENOENT')
  }

  assert.equal(readWork('/nowhere/mem.db', utc, failing), null)
  assert.equal(readWork('/nowhere/mem.db', utc, () => 'Error: no such table: observations'), null)
  assert.equal(readWork('/nowhere/mem.db', utc, () => '{"not":"rows"}'), null)
})

test('a database with no observations is an empty work mix, not a missing one', () => {
  assert.deepEqual(readWork('/nowhere/mem.db', utc, () => ''), [])
})

const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0

// The only test that runs the real tool: it is what proves WORK_SQL and the -json flag.
test('the real sqlite3 tool answers the query as the code expects', { skip: !hasSqlite && 'sqlite3 is not installed' }, (t) => {
  const db = join(tempDir(t), 'mem.db')
  const at = ms('2026-03-01T09:00:00Z')
  execFileSync('sqlite3', [
    db,
    `create table observations (project text, type text, created_at_epoch integer);
     insert into observations values
       ('demo', 'feature', ${at}), ('demo', 'feature', ${at + 60_000}), ('demo', 'bugfix', ${at + 86_400_000});`,
  ])

  assert.deepEqual(readWork(db, utc), [
    { day: '2026-03-01', project: 'demo', type: 'feature', n: 2 },
    { day: '2026-03-02', project: 'demo', type: 'bugfix', n: 1 },
  ])
  assert.equal(readWork(join(tempDir(t), 'missing.db'), utc), null)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/sources.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/history.mjs`.

- [ ] **Step 3: Write the two sources**

**Create `plugins/reflect/indexer/history.mjs`:**

```js
// Prompt counts from ~/.claude/history.jsonl: one line per prompt typed in a
// terminal session. Desktop sessions do not write to it, so it matters most for
// the months before the surviving transcripts begin.

/** @returns {{ [day: string]: { prompts: number, hours: number[] } }} */
export function readHistory(text, clock) {
  const days = {}
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // a half-written last line, or anything else that is not a prompt
    }
    if (record === null || typeof record !== 'object' || !Number.isFinite(record.timestamp)) continue
    const { day, hour } = clock(record.timestamp)
    const entry = (days[day] ??= { prompts: 0, hours: new Array(24).fill(0) })
    entry.prompts += 1
    entry.hours[hour] += 1
  }
  return days
}
```

**Create `plugins/reflect/indexer/mem.mjs`:**

```js
// Work mix from the claude-mem plugin's database, read through the sqlite3
// command line tool. Both are optional: without either there is no work mix.
import { execFileSync } from 'node:child_process'

const QUARTER_HOUR = 15 * 60 * 1000

// Grouped by quarter hour, not by day: the day depends on the reader's time
// zone, which the caller's clock knows and SQLite's `localtime` may not match.
export const WORK_SQL = `select created_at_epoch / ${QUARTER_HOUR} as q, project, type, count(*) as n from observations group by 1, 2, 3`

function sqlite(argv) {
  return execFileSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * @returns {null | Array<{ day: string, project: string, type: string, n: number }>}
 *   null when the database or the sqlite3 tool cannot be used
 */
export function readWork(dbPath, clock, run = sqlite) {
  let rows
  try {
    // sqlite3 prints nothing at all for a result with no rows.
    rows = JSON.parse(run(['sqlite3', '-readonly', '-json', dbPath, WORK_SQL]) || '[]')
  } catch {
    return null // no sqlite3, no such table, a locked or foreign file: there is no work mix to show
  }
  if (!Array.isArray(rows)) return null

  const merged = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !Number.isFinite(row.q) || !Number.isFinite(row.n)) continue
    const entry = { day: clock(row.q * QUARTER_HOUR).day, project: String(row.project), type: String(row.type), n: row.n }
    const key = JSON.stringify([entry.day, entry.project, entry.type])
    const seen = merged.get(key)
    if (seen === undefined) merged.set(key, entry)
    else seen.n += entry.n
  }
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/reflect/test/sources.test.mjs`
Expected: 6 tests, all PASS (5 and 1 skipped where `sqlite3` is not installed).

- [ ] **Step 5: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| `history.mjs`: change `entry.hours[hour] += 1` to `entry.hours[0] += 1` | "history counts prompts per local day and hour" |
| `history.mjs`: delete the `!Number.isFinite(record.timestamp)` condition | the same test |
| `mem.mjs`: replace `else seen.n += entry.n` with `else merged.set(key, entry)` | "work rows are bucketed by local day and merged" |
| `mem.mjs`: change `return null // no sqlite3…` to `return []` | "no sqlite3, a failing query, or output that is not rows" |
| `mem.mjs`: change `|| '[]'` to `|| 'null'` | "a database with no observations is an empty work mix" |
| `mem.mjs`: change `created_at_epoch / ${QUARTER_HOUR}` to `created_at_epoch / 1000` in `WORK_SQL` | "the real sqlite3 tool answers the query" |
| `mem.mjs`: drop `'-readonly',` from the argv | "work rows are bucketed by local day and merged" |

- [ ] **Step 6: Run everything and commit**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 312`, `# pass 312`, `# fail 0`.

```bash
git add plugins/reflect/indexer/history.mjs plugins/reflect/indexer/mem.mjs plugins/reflect/test/sources.test.mjs
git commit -m "feat(reflect): read prompt history and the claude-mem work mix"
```

---

### Task 6: The View

`buildView` turns merged days, session rows and the two side sources into the one object a range of the dashboard shows. Pure. The definitions come from the spec's section 6.4 and each has a test:

- **A range of N days** is today and the N−1 days before it. **All** starts at the earliest day any source has.
- **A day's prompts** come from whichever source has more for that day, transcripts or history; a tie goes to the transcripts. The hours come from the same source.
- **Sessions in a range** are the session rows whose `start` falls in it. A project's session count comes from those rows too.
- **The current streak** is the run of active days ending today, or ending yesterday when today has no prompt yet. **The best streak** is the longest ever. Both ignore the range.
- **Cache hit rate** is `cacheR / (cacheR + cacheW + inp)`, or `null` when there were no input tokens.

**Files:**
- Create: `plugins/reflect/indexer/query.mjs`
- Test: `plugins/reflect/test/query.test.mjs`

**Interfaces:**
- Consumes: `addDays`, `weekdayOf` from `clock.mjs`; `addCounts`, `bump`, `emptyModel`, `own`, `emptyMergedDay` from `agg.mjs` (Task 2).
- Produces, from `query.mjs`:
  - `RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null }`
  - `buildView({ days, sessions, history, work, rangeId, today, clock, generatedAt, notes = [] }): View`, where `days` is `{ [day]: MergedDay }`, `sessions` is `SessionRow[]`, `history` is what `readHistory` returns, `work` is what `readWork` returns, `today` is a `YYYY-MM-DD` day. Throws on an unknown `rangeId`.
- The `View`:

```
{ version: 1, generatedAt,
  range:    { id, from, to, days },                       // days: how many calendar days
  coverage: { transcriptsFrom, historyFrom, workFrom },   // first day of each source, or null
  totals:   { prompts, activeDays, sessions, desktopSessions, cliSessions, toolCalls, projects,
              activeMs, out, inp, cacheR, cacheW, msgs, subMsgs,
              cacheHitRate, currentStreak, bestStreak },
  days:     [{ day, prompts, out, sessions, models: { [model | 'other']: out } }],   // every day of the range
  hours:    number[7][24],                                // prompts, [0] = Monday
  projects: [{ name, prompts, out, sessions }],           // top 12 by out
  models:   [{ name, msgs, out, inp, cacheR, cacheW }],   // all, by out
  tools: [{ name, n }], skills: [{ name, n }], mcp: [{ name, n }], efforts: [{ name, n }],
  sessions: { longest: [Brief], mostPrompts: [Brief] },   // Brief = { title, project, start, activeMs, prompts }
  work:     null | { types: [{ name, n }], byMonth: [{ month, types }], byProject: [{ name, n, types }] },
  previous: null | { prompts, sessions, out, activeMs },
  notes:    string[] }
```

- [ ] **Step 1: Write the failing tests**

**Create `plugins/reflect/test/query.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyMergedDay } from '../indexer/agg.mjs'
import { buildView } from '../indexer/query.mjs'
import { utc } from './helpers.mjs'

const TODAY = '2026-03-10' // a Tuesday
const ms = (iso) => Date.parse(iso)
const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}
const day = (fields) => ({ ...emptyMergedDay(), ...fields })
const usage = (out) => ({ msgs: 1, out, inp: 0, cacheR: 0, cacheW: 0 })
const typed = (n, hour = 12) => ({ prompts: n, hours: hoursAt(hour, n) })
const activeOn = (list) => Object.fromEntries(list.map((each) => [each, typed(1)]))
const session = (id, start, fields = {}) => ({
  id,
  project: 'demo',
  title: null,
  entrypoint: 'cli',
  start: ms(start),
  end: ms(start) + 1000,
  activeMs: 0,
  prompts: 0,
  out: 0,
  ...fields,
})
const view = (over) =>
  buildView({
    days: {},
    sessions: [],
    history: {},
    work: null,
    rangeId: '7d',
    today: TODAY,
    clock: utc,
    generatedAt: '2026-03-10T12:00:00.000Z',
    ...over,
  })

test('a range of seven days is today and the six days before it, and nothing after today', () => {
  const v = view({
    days: {
      '2026-03-03': day(typed(5)),
      '2026-03-04': day(typed(1)),
      '2026-03-11': day(typed(9)), // a clock that ran ahead
    },
  })

  assert.deepEqual(v.range, { id: '7d', from: '2026-03-04', to: TODAY, days: 7 })
  assert.equal(v.totals.prompts, 1)
  assert.deepEqual(
    v.days.map((each) => each.day),
    ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
  )
  assert.deepEqual(v.days[0], { day: '2026-03-04', prompts: 1, out: 0, sessions: 0, models: {} })
})

test('a day takes its prompts, and their hours, from whichever source has more', () => {
  const v = view({
    days: {
      '2026-03-08': day(typed(2, 8)), // Sunday: a tie goes to the transcripts
      '2026-03-09': day(typed(3, 9)), // Monday: history has more
      '2026-03-10': day(typed(4, 10)), // Tuesday: the transcripts have more
    },
    history: {
      '2026-03-07': typed(1, 7), // Saturday: history only
      '2026-03-08': typed(2, 22),
      '2026-03-09': typed(5, 20),
      '2026-03-10': typed(2, 21),
    },
  })

  assert.equal(v.totals.prompts, 1 + 2 + 5 + 4)
  assert.equal(v.totals.activeDays, 4)
  assert.equal(v.hours[5][7], 1)
  assert.equal(v.hours[6][8], 2)
  assert.equal(v.hours[6][22], 0)
  assert.equal(v.hours[0][20], 5)
  assert.equal(v.hours[0][9], 0)
  assert.equal(v.hours[1][10], 4)
  assert.equal(v.hours[1][21], 0)
})

test('streaks count consecutive active days over all history, whatever the range', () => {
  const untilYesterday = view({
    history: activeOn(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05', '2026-03-08', '2026-03-09']),
  })
  assert.equal(untilYesterday.totals.currentStreak, 2) // no prompt yet today, so it ends yesterday
  assert.equal(untilYesterday.totals.bestStreak, 3) // 1 to 3 March, outside the seven-day range

  const throughToday = view({ history: activeOn(['2026-03-08', '2026-03-09', '2026-03-10']) })
  assert.equal(throughToday.totals.currentStreak, 3)

  const broken = view({ history: activeOn(['2026-03-07', '2026-03-08']) })
  assert.equal(broken.totals.currentStreak, 0)
  assert.equal(broken.totals.bestStreak, 2)
})

test('sessions belong to the range their start falls in, and a project counts them', () => {
  const v = view({
    days: { '2026-03-09': day({ projects: { demo: { prompts: 3, out: 10, sessions: 1 } } }) },
    sessions: [
      session('a', '2026-03-09T10:00:00Z', { title: 'A', entrypoint: 'claude-desktop', activeMs: 5000, prompts: 3 }),
      session('b', '2026-03-10T08:00:00Z', { title: 'B', activeMs: 9000, prompts: 1 }),
      session('c', '2026-03-01T08:00:00Z', { title: 'C', activeMs: 99_000, prompts: 50 }), // before the range
    ],
  })

  assert.equal(v.totals.sessions, 2)
  assert.equal(v.totals.desktopSessions, 1)
  assert.equal(v.totals.cliSessions, 1)
  assert.deepEqual(v.sessions.longest.map((each) => each.title), ['B', 'A'])
  assert.deepEqual(v.sessions.mostPrompts.map((each) => each.title), ['A', 'B'])
  assert.deepEqual(v.sessions.longest[0], {
    title: 'B',
    project: 'demo',
    start: ms('2026-03-10T08:00:00Z'),
    activeMs: 9000,
    prompts: 1,
  })
  assert.deepEqual(v.projects, [{ name: 'demo', prompts: 3, out: 10, sessions: 2 }])
  assert.equal(v.totals.projects, 1)
})

test('token totals add up over the range, and the cache hit rate is read tokens over all input', () => {
  const v = view({
    days: {
      '2026-03-09': day({ out: 10, inp: 1, cacheR: 40, cacheW: 4, msgs: 2, subMsgs: 3, activeMs: 1000 }),
      '2026-03-10': day({ out: 5, cacheR: 50, cacheW: 5, msgs: 1, activeMs: 500, sessions: 2 }),
    },
  })

  assert.equal(v.totals.out, 15)
  assert.equal(v.totals.inp, 1)
  assert.equal(v.totals.cacheR, 90)
  assert.equal(v.totals.cacheW, 9)
  assert.equal(v.totals.msgs, 3)
  assert.equal(v.totals.subMsgs, 3)
  assert.equal(v.totals.activeMs, 1500)
  assert.equal(v.totals.cacheHitRate, 0.9)
  assert.deepEqual(v.days.at(-1), { day: TODAY, prompts: 0, out: 5, sessions: 2, models: {} })
  assert.equal(view({}).totals.cacheHitRate, null)
})

test('lists are ranked, ties broken by name, and capped', () => {
  // t01 … t16 with counts 16 … 1, and one more that ties with the top.
  const tools = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`t${String(i + 1).padStart(2, '0')}`, 16 - i]))
  tools.aaa = 16
  const v = view({ days: { [TODAY]: day({ tools, skills: { b: 1, a: 1 }, efforts: { high: 2, max: 5 } }) } })

  assert.equal(v.tools.length, 15)
  assert.deepEqual(v.tools.slice(0, 3), [
    { name: 'aaa', n: 16 },
    { name: 't01', n: 16 },
    { name: 't02', n: 15 },
  ])
  assert.equal(v.tools.at(-1).name, 't14')
  assert.equal(v.totals.toolCalls, 152) // every call, not only the fifteen listed
  assert.deepEqual(v.skills, [
    { name: 'a', n: 1 },
    { name: 'b', n: 1 },
  ])
  assert.deepEqual(v.efforts, [
    { name: 'max', n: 5 },
    { name: 'high', n: 2 },
  ])
})

test('models are ranked by output; a day names the top six and folds the rest into other', () => {
  // m1 … m8 with output 8 … 1.
  const models = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i + 1}`, usage(8 - i)]))
  const v = view({ days: { [TODAY]: day({ models, out: 36 }) } })

  assert.deepEqual(v.models.map((each) => each.name), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'])
  assert.deepEqual(v.models[0], { name: 'm1', msgs: 1, out: 8, inp: 0, cacheR: 0, cacheW: 0 })
  assert.deepEqual(v.days.at(-1).models, { m1: 8, m2: 7, m3: 6, m4: 5, m5: 4, m6: 3, other: 3 })
})

test('the previous window is the same length, immediately before, and absent for all time', () => {
  const v = view({
    days: {
      '2026-02-24': day({ out: 1000 }), // one day too early
      '2026-02-25': day({ out: 1 }),
      '2026-03-03': day({ out: 50, activeMs: 700 }),
    },
    history: { '2026-03-03': typed(5) },
    sessions: [
      session('p', '2026-03-02T09:00:00Z'),
      session('q', '2026-03-09T09:00:00Z'), // in the current range, so not in the previous one
    ],
  })

  assert.deepEqual(v.previous, { prompts: 5, sessions: 1, out: 51, activeMs: 700 })
  assert.equal(v.totals.sessions, 1)
  assert.equal(view({ rangeId: 'all' }).previous, null)
})

test('the work mix covers the range, by type, by month and by project', () => {
  const v = view({
    work: [
      { day: '2026-02-01', project: 'old', type: 'feature', n: 9 }, // before the range
      { day: '2026-03-09', project: 'demo', type: 'bugfix', n: 1 },
      { day: '2026-03-09', project: 'demo', type: 'feature', n: 2 },
      { day: '2026-03-10', project: 'other', type: 'feature', n: 4 },
    ],
  })

  assert.deepEqual(v.work, {
    types: [
      { name: 'feature', n: 6 },
      { name: 'bugfix', n: 1 },
    ],
    byMonth: [{ month: '2026-03', types: { bugfix: 1, feature: 6 } }],
    byProject: [
      { name: 'other', n: 4, types: { feature: 4 } },
      { name: 'demo', n: 3, types: { bugfix: 1, feature: 2 } },
    ],
  })
  assert.equal(view({ work: null }).work, null)
  assert.deepEqual(view({ work: [] }).work, { types: [], byMonth: [], byProject: [] })
})

test("all time starts at the earliest day any source has, and coverage names each source's first day", () => {
  const v = view({
    rangeId: 'all',
    days: { '2026-03-09': day({ out: 1 }) },
    history: { '2025-12-31': typed(1) },
    work: [{ day: '2026-01-15', project: 'demo', type: 'feature', n: 1 }],
  })

  assert.deepEqual(v.range, { id: 'all', from: '2025-12-31', to: TODAY, days: 70 })
  assert.deepEqual(v.coverage, { transcriptsFrom: '2026-03-09', historyFrom: '2025-12-31', workFrom: '2026-01-15' })

  const empty = view({ rangeId: 'all' })
  assert.deepEqual(empty.range, { id: 'all', from: TODAY, to: TODAY, days: 1 })
  assert.deepEqual(empty.coverage, { transcriptsFrom: null, historyFrom: null, workFrom: null })
})

test('an unknown range is refused', () => {
  assert.throws(() => view({ rangeId: '1y' }), /unknown range/)
})

test('the view carries its version, its time and the notes it was given', () => {
  const v = view({ notes: ['a moment behind'] })

  assert.equal(v.version, 1)
  assert.equal(v.generatedAt, '2026-03-10T12:00:00.000Z')
  assert.deepEqual(v.notes, ['a moment behind'])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/query.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/query.mjs`.

- [ ] **Step 3: Write the query**

**Create `plugins/reflect/indexer/query.mjs`:**

```js
// The View: everything one range of the dashboard shows, as plain JSON. Pure.
// The definitions are section 6.4 of docs/superpowers/specs/2026-10-07-reflect-design.md.
import { addCounts, bump, emptyModel, own } from './agg.mjs'
import { addDays, weekdayOf } from './clock.mjs'

/** Range ids and their length in days; null is all of history. */
export const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null }

const LIMITS = { projects: 12, tools: 15, skills: 10, mcp: 10, sessions: 5, workProjects: 8, dayModels: 6 }
const SUMMED = ['activeMs', 'out', 'inp', 'cacheR', 'cacheW', 'msgs', 'subMsgs']
const COUNT_MAPS = ['tools', 'skills', 'mcp', 'efforts']
const NO_PROMPTS = { prompts: 0, hours: new Array(24).fill(0) }

const get = (map, key) => (Object.hasOwn(map, key) ? map[key] : null)
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const earliest = (keys) => (keys.length > 0 ? [...keys].sort()[0] : null)

function ranked(map, limit = Infinity) {
  return Object.entries(map)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || byName(a, b))
    .slice(0, limit)
}

function daysBetween(from, to) {
  const list = []
  for (let day = from; day <= to; day = addDays(day, 1)) list.push(day)
  return list
}

/** `active` is every day with a prompt, in order. */
function streaks(active, today) {
  const set = new Set(active)
  let best = 0
  let run = 0
  let previous = null
  for (const day of active) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1
    if (run > best) best = run
    previous = day
  }
  let current = 0
  // A day that has only just begun does not break a streak.
  for (let day = set.has(today) ? today : addDays(today, -1); set.has(day); day = addDays(day, -1)) current += 1
  return { currentStreak: current, bestStreak: best }
}

function workMix(rows, from, to) {
  const types = {}
  const months = {}
  const projects = {}
  for (const row of rows) {
    if (row.day < from || row.day > to) continue
    bump(types, row.type, row.n)
    bump(own(months, row.day.slice(0, 7), () => ({})), row.type, row.n)
    const project = own(projects, row.project, () => ({ n: 0, types: {} }))
    project.n += row.n
    bump(project.types, row.type, row.n)
  }
  return {
    types: ranked(types),
    byMonth: Object.keys(months)
      .sort()
      .map((month) => ({ month, types: months[month] })),
    byProject: Object.entries(projects)
      .map(([name, project]) => ({ name, n: project.n, types: project.types }))
      .sort((a, b) => b.n - a.n || byName(a, b))
      .slice(0, LIMITS.workProjects),
  }
}

export function buildView({ days, sessions, history, work, rangeId, today, clock, generatedAt, notes = [] }) {
  if (!Object.hasOwn(RANGES, rangeId)) throw new Error(`unknown range: ${rangeId}`)
  const length = RANGES[rangeId]

  // Each source can only under-count a day, so the larger one is that day's prompts.
  const promptsOn = (day) => {
    const transcripts = get(days, day)
    const typed = get(history, day)
    if (typed !== null && (transcripts === null || typed.prompts > transcripts.prompts)) return typed
    return transcripts ?? NO_PROMPTS
  }

  const workDays = work === null ? [] : work.map((row) => row.day)
  const known = [...new Set([...Object.keys(days), ...Object.keys(history), ...workDays])].sort()
  const firstKnown = known.length > 0 && known[0] < today ? known[0] : today
  const from = length === null ? firstKnown : addDays(today, -(length - 1))

  function collect(first, last) {
    const totals = { prompts: 0, activeDays: 0 }
    for (const field of SUMMED) totals[field] = 0
    const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
    const maps = { models: {}, projects: {} }
    for (const field of COUNT_MAPS) maps[field] = {}
    const series = []

    for (const day of daysBetween(first, last)) {
      const merged = get(days, day)
      const prompts = promptsOn(day)
      totals.prompts += prompts.prompts
      if (prompts.prompts > 0) totals.activeDays += 1
      const weekday = hours[weekdayOf(day)]
      for (let hour = 0; hour < 24; hour += 1) weekday[hour] += prompts.hours[hour]

      const point = { day, prompts: prompts.prompts, out: 0, sessions: 0, models: {} }
      if (merged !== null) {
        point.out = merged.out
        point.sessions = merged.sessions
        for (const field of SUMMED) totals[field] += merged[field]
        for (const field of COUNT_MAPS) addCounts(maps[field], merged[field])
        for (const [model, usage] of Object.entries(merged.models)) {
          const sum = own(maps.models, model, emptyModel)
          for (const field of Object.keys(sum)) sum[field] += usage[field]
          bump(point.models, model, usage.out)
        }
        for (const [name, project] of Object.entries(merged.projects)) {
          const sum = own(maps.projects, name, () => ({ prompts: 0, out: 0 }))
          sum.prompts += project.prompts
          sum.out += project.out
        }
      }
      series.push(point)
    }

    const started = sessions.filter((row) => {
      const day = clock(row.start).day
      return day >= first && day <= last
    })
    return { totals, hours, maps, series, started }
  }

  const current = collect(from, today)
  const { totals, maps, started } = current

  totals.sessions = started.length
  totals.desktopSessions = started.filter((row) => row.entrypoint === 'claude-desktop').length
  totals.cliSessions = started.filter((row) => row.entrypoint === 'cli').length
  totals.toolCalls = Object.values(maps.tools).reduce((sum, n) => sum + n, 0)
  const input = totals.cacheR + totals.cacheW + totals.inp
  totals.cacheHitRate = input === 0 ? null : totals.cacheR / input
  Object.assign(totals, streaks(known.filter((day) => promptsOn(day).prompts > 0), today))

  const models = Object.entries(maps.models)
    .map(([name, usage]) => ({ name, ...usage }))
    .sort((a, b) => b.out - a.out || byName(a, b))
  const named = new Set(models.slice(0, LIMITS.dayModels).map((model) => model.name))
  for (const point of current.series) {
    const folded = {}
    for (const [model, out] of Object.entries(point.models)) bump(folded, named.has(model) ? model : 'other', out)
    point.models = folded
  }

  const sessionsOf = {}
  for (const row of started) bump(sessionsOf, row.project)
  const projects = Object.entries(maps.projects)
    .map(([name, project]) => ({ name, prompts: project.prompts, out: project.out, sessions: get(sessionsOf, name) ?? 0 }))
    .sort((a, b) => b.out - a.out || b.prompts - a.prompts || byName(a, b))
  totals.projects = projects.length

  const brief = (row) => ({
    title: row.title,
    project: row.project,
    start: row.start,
    activeMs: row.activeMs,
    prompts: row.prompts,
  })
  const top = (field) =>
    [...started]
      .sort((a, b) => b[field] - a[field] || a.start - b.start)
      .slice(0, LIMITS.sessions)
      .map(brief)

  let previous = null
  if (length !== null) {
    const before = collect(addDays(from, -length), addDays(from, -1))
    previous = {
      prompts: before.totals.prompts,
      sessions: before.started.length,
      out: before.totals.out,
      activeMs: before.totals.activeMs,
    }
  }

  return {
    version: 1,
    generatedAt,
    range: { id: rangeId, from, to: today, days: current.series.length },
    coverage: {
      transcriptsFrom: earliest(Object.keys(days)),
      historyFrom: earliest(Object.keys(history)),
      workFrom: earliest(workDays),
    },
    totals,
    days: current.series,
    hours: current.hours,
    projects: projects.slice(0, LIMITS.projects),
    models,
    tools: ranked(maps.tools, LIMITS.tools),
    skills: ranked(maps.skills, LIMITS.skills),
    mcp: ranked(maps.mcp, LIMITS.mcp),
    efforts: ranked(maps.efforts),
    sessions: { longest: top('activeMs'), mostPrompts: top('prompts') },
    work: work === null ? null : workMix(work, from, today),
    previous,
    notes,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/reflect/test/query.test.mjs`
Expected: 12 tests, all PASS.

- [ ] **Step 5: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| Change `addDays(today, -(length - 1))` to `addDays(today, -length)` | "a range of seven days is today and the six days before it" |
| In `promptsOn`, change `typed.prompts > transcripts.prompts` to `>=` | "a day takes its prompts, and their hours, from whichever source has more" |
| In `promptsOn`, always `return transcripts ?? NO_PROMPTS` | the same test |
| In `streaks`, start the loop at `today` unconditionally | "streaks count consecutive active days" |
| In `streaks`, replace `addDays(previous, 1) === day` with `true` | the same test |
| Change `known.filter(...)` passed to `streaks` to the days of the range only (`daysBetween(from, today).filter(...)`) | the same test |
| In `collect`, filter sessions with `day <= last` only | "sessions belong to the range their start falls in" |
| In `collect`, filter sessions with `day >= first` only | "the previous window is the same length" |
| Change `get(sessionsOf, name) ?? 0` to `project.sessions ?? 0` | the same test |
| Change `totals.cacheR / input` to `totals.cacheR / (totals.cacheR + totals.cacheW)` | "token totals add up over the range" |
| In `ranked`, drop `|| byName(a, b)` | "lists are ranked, ties broken by name, and capped" |
| Compute `totals.toolCalls` from `ranked(maps.tools, LIMITS.tools)` instead of every tool | the same test |
| Change `named.has(model) ? model : 'other'` to `model` | "a day names the top six and folds the rest into other" |
| Change the previous window to `collect(addDays(from, -length - 1), addDays(from, -1))` | "the previous window is the same length" |
| In `workMix`, delete the `row.day < from || row.day > to` line | "the work mix covers the range" |
| Change `known[0] < today ? known[0] : today` to `today` | "all time starts at the earliest day any source has" |

- [ ] **Step 6: Run everything and commit**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 324`, `# pass 324`, `# fail 0`.

```bash
git add plugins/reflect/indexer/query.mjs plugins/reflect/test/query.test.mjs
git commit -m "feat(reflect): build the View for a range"
```

---

### Task 7: The command

`node plugins/reflect/indexer/cli.mjs view --range <id>` brings the store up to date and prints one View as JSON. This is the whole interface the mod will use.

| Exit | Meaning | stdout | stderr |
|---|---|---|---|
| 0 | a View | the View, one JSON object | empty |
| 2 | bad command line | empty | usage |
| 1 | anything else | empty | `reflect: <reason>` |

Order of work, and why:

1. Take the lock. If another process holds it, do not index and do not save: answer from the store as it stands and add a note. The owner runs many sessions at once, so this is a normal path.
2. Read the store. If it is unusable, say so; move it aside only when holding the lock.
3. Update, save, release. The lock is released on every path.
4. Read the two side sources, which need no lock, and build the View.

**Files:**
- Create: `plugins/reflect/indexer/cli.mjs`
- Test: `plugins/reflect/test/cli.test.mjs`

**Interfaces:**
- Consumes: `createClock`, `systemTimeZone` (Task 2); `acquireLock`, `mergedDays`, `quarantine`, `readStore`, `saveStore` (Task 3); `updateStore` (Task 4); `readHistory`, `readWork` (Task 5); `buildView`, `RANGES` (Task 6).
- Produces, from `cli.mjs`:
  - `run(argv: string[], env = process.env): Promise<{ code: number, stdout: string, stderr: string }>`
  - `NOTE_BUSY`, `NOTE_LOST`: the two fixed notes.
  - Options: `--range` (default `30d`), `--projects`, `--data`, `--history`, `--mem`, `--now`, `--tz`, `--home`. Defaults: config folder `CLAUDE_CONFIG_DIR` or `~/.claude`; projects `<config>/projects`; data `<config>/tacos/reflect`; history `<config>/history.jsonl`; mem `claude-mem.db` in `CLAUDE_MEM_DATA_DIR` (claude-mem's own variable) or `~/.claude-mem`; time zone the system's.

- [ ] **Step 1: Write the failing tests**

**Create `plugins/reflect/test/cli.test.mjs`:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NOTE_BUSY, NOTE_LOST, run } from '../indexer/cli.mjs'
import { HOME, prompt, reply, tempDir, toolUse } from './helpers.mjs'

const INDEXER = join(dirname(fileURLToPath(import.meta.url)), '..', 'indexer')
const NOW = '2026-03-10T12:00:00Z'
const TRANSCRIPT = join('projects', '-home-u-Projects-demo', 's1.jsonl')

/** A config folder of its own: one session on 9 March, and one terminal prompt on 8 March. */
function configDir(t) {
  const config = tempDir(t)
  mkdirSync(dirname(join(config, TRANSCRIPT)), { recursive: true })
  writeFileSync(
    join(config, TRANSCRIPT),
    [
      prompt({ session: 's1', at: '2026-03-09T10:00:00.000Z' }),
      reply({ id: 'm1', session: 's1', at: '2026-03-09T10:00:05.000Z', out: 40, blocks: [toolUse('t1', 'Bash')] }),
    ]
      .map((line) => `${line}\n`)
      .join(''),
  )
  writeFileSync(
    join(config, 'history.jsonl'),
    `${JSON.stringify({ timestamp: Date.parse('2026-03-08T12:00:00Z'), project: '/x', sessionId: 'h' })}\n`,
  )
  return config
}

const args = (...more) => ['view', '--range', '7d', '--now', NOW, '--tz', 'UTC', '--home', HOME, ...more]
// Both folders the command would otherwise look for on the real machine.
const env = (config) => ({ CLAUDE_CONFIG_DIR: config, CLAUDE_MEM_DATA_DIR: join(config, 'claude-mem') })
const dataDir = (config) => join(config, 'tacos', 'reflect')
const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0

async function viewOf(config, ...more) {
  const result = await run(args(...more), env(config))
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  return JSON.parse(result.stdout)
}

test('view reads the transcripts and the prompt history of its config folder and prints a View', async (t) => {
  const config = configDir(t)

  const view = await viewOf(config)

  assert.equal(view.version, 1)
  assert.equal(view.range.from, '2026-03-04')
  assert.equal(view.totals.prompts, 2) // one in the transcript, one in the history
  assert.equal(view.totals.out, 40)
  assert.equal(view.totals.sessions, 1)
  assert.deepEqual(view.tools, [{ name: 'Bash', n: 1 }])
  assert.deepEqual(view.projects, [{ name: 'demo', prompts: 1, out: 40, sessions: 1 }])
  assert.equal(view.work, null)
  assert.deepEqual(view.notes, [])
  assert.deepEqual(readdirSync(dataDir(config)), ['store.json']) // saved, and the lock released
})

test('history outlives its transcript, because the store was saved', async (t) => {
  const config = configDir(t)
  await viewOf(config)
  rmSync(join(config, TRANSCRIPT))

  const view = await viewOf(config)

  assert.equal(view.totals.out, 40)
  assert.equal(view.totals.sessions, 1)
})

test('while another process holds the lock, view answers from the store as it stands and says so', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.lock'), 'someone else')

  const view = await viewOf(config)

  assert.deepEqual(view.notes, [NOTE_BUSY])
  assert.equal(view.totals.out, 0) // nothing was indexed
  assert.equal(view.totals.prompts, 1) // the prompt history needs no lock
  assert.deepEqual(readdirSync(dataDir(config)), ['store.lock']) // nothing saved, the other lock left alone
})

test('an unreadable store is moved aside and rebuilt, and the loss is said', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.json'), 'not json')

  const view = await viewOf(config)

  assert.deepEqual(view.notes, [NOTE_LOST])
  assert.equal(view.totals.out, 40)
  const files = readdirSync(dataDir(config)).sort()
  assert.equal(files.length, 2)
  assert.match(files[0], /^store\.corrupt-\d+\.json$/)
  assert.equal(files[1], 'store.json')
  assert.equal(readFileSync(join(dataDir(config), files[0]), 'utf8'), 'not json')
})

test('the work mix is read from the claude-mem folder named in the environment', { skip: !hasSqlite && 'sqlite3 is not installed' }, async (t) => {
  const config = configDir(t)
  mkdirSync(join(config, 'claude-mem'))
  execFileSync('sqlite3', [
    join(config, 'claude-mem', 'claude-mem.db'),
    `create table observations (project text, type text, created_at_epoch integer);
     insert into observations values ('demo', 'feature', ${Date.parse('2026-03-09T10:00:00Z')});`,
  ])

  const view = await viewOf(config)

  assert.deepEqual(view.work.types, [{ name: 'feature', n: 1 }])
})

test('transcript lines that cannot be read are counted in a note', async (t) => {
  const config = configDir(t)
  appendFileSync(join(config, TRANSCRIPT), '{"type":"assistant", broken\n')

  assert.deepEqual((await viewOf(config)).notes, ['1 transcript line could not be read and was skipped.'])

  appendFileSync(join(config, TRANSCRIPT), '{"type":"assistant", broken again\n')
  assert.deepEqual((await viewOf(config)).notes, ['2 transcript lines could not be read and were skipped.'])
})

test('a bad command line exits 2 with the usage and prints no View', async (t) => {
  // Isolated although none of these should get as far as a folder: if the parser
  // is ever broken, the command must land in this empty folder, not on the real machine.
  const isolated = env(tempDir(t))
  for (const argv of [[], ['index'], ['view', '--range', '1y'], ['view', '--bogus', 'x'], ['view', '--range']]) {
    const result = await run(argv, isolated)

    assert.equal(result.code, 2, argv.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^usage: /)
  }
})

test('a failure exits 1 with the reason, prints no View, and releases the lock', async (t) => {
  const config = configDir(t)

  const badTime = await run(args('--now', 'whenever'), env(config))
  assert.equal(badTime.code, 1)
  assert.equal(badTime.stdout, '')
  assert.match(badTime.stderr, /^reflect: --now is not a time: whenever\n$/)

  await viewOf(config)
  const elsewhere = await run(args('--projects', tempDir(t)), env(config))
  assert.equal(elsewhere.code, 1)
  assert.equal(elsewhere.stdout, '')
  assert.match(elsewhere.stderr, /^reflect: the saved history was built from /)
  assert.equal(existsSync(join(dataDir(config), 'store.lock')), false)
})

// A plugin folder is often reached through a symlink. The program must still
// recognise that it is the one being run.
test('run as a program through a symlinked folder, it prints a View', (t) => {
  const config = configDir(t)
  const link = join(tempDir(t), 'linked')
  symlinkSync(INDEXER, link)

  const stdout = execFileSync(process.execPath, [join(link, 'cli.mjs'), ...args()], {
    encoding: 'utf8',
    env: { ...process.env, ...env(config) },
  })

  assert.equal(JSON.parse(stdout).totals.out, 40)
})

test('run as a program with a bad command line, it exits 2 and prints the usage on stderr', (t) => {
  const result = spawnSync(process.execPath, [join(INDEXER, 'cli.mjs'), 'view', '--range', '1y'], {
    encoding: 'utf8',
    env: { ...process.env, ...env(tempDir(t)) },
  })

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /unknown range: 1y/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test plugins/reflect/test/cli.test.mjs`
Expected: FAIL with `Cannot find module` for `../indexer/cli.mjs`.

- [ ] **Step 3: Write the command**

**Create `plugins/reflect/indexer/cli.mjs`:**

```js
#!/usr/bin/env node
// `node cli.mjs view --range <id>`: bring the store up to date, then print one
// View as JSON on stdout. Exit 0 with a View, 2 for a bad command line, 1 for
// anything else, with the reason on stderr.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClock, systemTimeZone } from './clock.mjs'
import { readHistory } from './history.mjs'
import { readWork } from './mem.mjs'
import { buildView, RANGES } from './query.mjs'
import { acquireLock, mergedDays, quarantine, readStore, saveStore } from './store.mjs'
import { updateStore } from './update.mjs'

const OPTIONS = ['range', 'projects', 'data', 'history', 'mem', 'now', 'tz', 'home']
const USAGE =
  `usage: cli.mjs view [--range ${Object.keys(RANGES).join('|')}] [--projects dir] [--data dir] ` +
  '[--history file] [--mem file] [--now iso-time] [--tz zone] [--home dir]'

export const NOTE_BUSY = 'Another session is updating the history, so this view may be a moment behind.'
export const NOTE_LOST =
  'The saved history could not be read and was rebuilt from the transcripts still on disk. Older history is lost.'

class UsageError extends Error {}

function parse(argv) {
  if (argv[0] !== 'view') throw new UsageError(USAGE)
  const options = {}
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if (!OPTIONS.includes(name) || argv[i + 1] === undefined) throw new UsageError(`${USAGE}\nunexpected: ${argv[i]}`)
    options[name] = argv[i + 1]
  }
  const range = options.range ?? '30d'
  if (!Object.hasOwn(RANGES, range)) throw new UsageError(`${USAGE}\nunknown range: ${range}`)
  return { ...options, range }
}

async function view(options, env) {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const projects = options.projects ?? join(config, 'projects')
  const data = options.data ?? join(config, 'tacos', 'reflect')
  const historyFile = options.history ?? join(config, 'history.jsonl')
  const memFile = options.mem ?? join(env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem'), 'claude-mem.db')
  const home = options.home ?? homedir()
  const now = options.now === undefined ? Date.now() : Date.parse(options.now)
  if (Number.isNaN(now)) throw new Error(`--now is not a time: ${options.now}`)
  const clock = createClock(options.tz ?? systemTimeZone())
  const notes = []

  // Null when another process is indexing: then this one neither indexes nor saves.
  const release = acquireLock(data)
  let store
  try {
    const read = readStore(data)
    store = read.store
    if (read.lost !== null) {
      notes.push(NOTE_LOST)
      if (release !== null) quarantine(data, now)
    }
    if (release === null) {
      notes.push(NOTE_BUSY)
    } else {
      await updateStore(store, projects, { home, clock })
      saveStore(data, store)
    }
  } finally {
    if (release !== null) release()
  }

  const bad = Object.values(store.files).reduce((sum, file) => sum + file.summary.bad, 0)
  if (bad === 1) notes.push('1 transcript line could not be read and was skipped.')
  else if (bad > 1) notes.push(`${bad} transcript lines could not be read and were skipped.`)

  return buildView({
    days: mergedDays(store),
    sessions: store.sessions,
    history: existsSync(historyFile) ? readHistory(readFileSync(historyFile, 'utf8'), clock) : {},
    work: existsSync(memFile) ? readWork(memFile, clock) : null,
    rangeId: options.range,
    today: clock(now).day,
    clock,
    generatedAt: new Date(now).toISOString(),
    notes,
  })
}

/** @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
export async function run(argv, env = process.env) {
  let options
  try {
    options = parse(argv)
  } catch (err) {
    if (err instanceof UsageError) return { code: 2, stdout: '', stderr: `${err.message}\n` }
    throw err
  }
  try {
    return { code: 0, stdout: JSON.stringify(await view(options, env)), stderr: '' }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `reflect: ${err instanceof Error ? err.message : String(err)}\n` }
  }
}

// Compared by real path: a plugin folder is often reached through a symlink,
// and then the path Node was started with is not the path this module has.
function isMain() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false // an unresolvable path means we were imported, not run
  }
}

if (isMain()) {
  const { code, stdout, stderr } = await run(process.argv.slice(2))
  if (stderr !== '') process.stderr.write(stderr)
  if (stdout !== '') process.stdout.write(stdout)
  process.exitCode = code
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/reflect/test/cli.test.mjs`
Expected: 10 tests, all PASS (9 and 1 skipped where `sqlite3` is not installed).

- [ ] **Step 5: Mutation-check**

| Mutation | Test that must fail |
|---|---|
| Replace `env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem')` with `join(homedir(), '.claude-mem')` | "the work mix is read from the claude-mem folder named in the environment" |
| Delete the `saveStore(data, store)` line | "history outlives its transcript" |
| Replace `if (release === null) { notes.push(NOTE_BUSY) } else { … }` so the update and save always run | "while another process holds the lock" |
| Delete `if (release !== null) quarantine(data, now)` | "an unreadable store is moved aside and rebuilt" |
| Delete the `finally` block's `release()` | "a failure exits 1 with the reason, prints no View, and releases the lock" |
| Change `if (bad === 1)` to `if (bad === 0)` | "transcript lines that cannot be read are counted in a note" |
| In `parse`, delete the `!Object.hasOwn(RANGES, range)` line | "a bad command line exits 2" |
| In `isMain`, compare `process.argv[1] === fileURLToPath(import.meta.url)` without `realpathSync` | "run as a program through a symlinked folder" |
| Change `process.exitCode = code` to `process.exitCode = 0` | "run as a program with a bad command line, it exits 2" |

- [ ] **Step 6: Run everything**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 334`, `# pass 334`, `# fail 0`.

Run: `node scripts/release.mjs && git status --short plugins && ls -a plugins/reflect`
Expected: two `vendored 11 modules` lines, no changes listed, and no `lib` in the listing.

- [ ] **Step 7: Check it against the real history**

This reads the real `~/.claude/projects` (read-only) and writes only to a temp data folder. It is a check by eye, not a test, and nothing from it is committed.

```bash
DATA=$(mktemp -d)
time node plugins/reflect/indexer/cli.mjs view --range all --data "$DATA" > "$DATA/view.json"
node -e '
const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const t = v.totals
console.log({ from: v.range.from, days: v.range.days, coverage: v.coverage, notes: v.notes })
console.log({ prompts: t.prompts, sessions: t.sessions, replies: t.msgs + t.subMsgs, outM: +(t.out / 1e6).toFixed(1),
  cacheHit: t.cacheHitRate, streak: [t.currentStreak, t.bestStreak], projects: t.projects })
console.log(v.models.slice(0, 3).map((m) => m.name), v.tools.slice(0, 3))
' "$DATA/view.json"
time node plugins/reflect/indexer/cli.mjs view --range 30d --data "$DATA" > /dev/null
ls -la "$DATA"; rm -rf "$DATA"; ls ~/.claude/tacos/reflect 2>&1
```

Expected on the owner's machine, measured 2026-10-07 (these only grow):
- First run: under about 40 s. Second run: under about 2 s.
- `replies` at least 75,000; `outM` at least 35; `cacheHit` about 0.97; `sessions` at least 170; the top tool is `Bash`.
- `coverage.historyFrom` is `2026-03-15`; `coverage.transcriptsFrom` is in August 2026.
- `$DATA` holds only `store.json`, mode `-rw-------`.
- The last `ls` fails with "No such file or directory": nothing was written outside `--data`.

If a figure is far off, stop and report it with the output. Do not adjust the code to match.

- [ ] **Step 8: Commit**

```bash
git add plugins/reflect/indexer/cli.mjs plugins/reflect/test/cli.test.mjs
git commit -m "feat(reflect): view command that updates the store and prints a View"
```

---

## What this plan leaves for the next one

The mod itself: `hooks/`, `types/`, the pane and its tabs, the charts, the Tips call, the README, the marketplace entry and the engine tests. That plan is written after the spike in the spec's section 11, because chart sizes and theme handling depend on what the spike measures. Until then `reflect` is not listed in `marketplace.json` and cannot be installed.
