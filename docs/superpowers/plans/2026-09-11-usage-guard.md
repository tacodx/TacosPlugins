# usage-guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `usage-guard`, a Claude Code plugin that makes the account's real rate-limit usage visible to the model and enforces a per-chat ceiling against it.

**Architecture:** A pure decision core (gauges + thresholds → decision) sits under a thin data layer (fetch → TTL cache → decide). Plugin hooks are the last thing wired, and they can only *read* the cache. The build order proves the data layer with a read-only `explain` CLI before any code that can deny a tool call exists.

**Tech Stack:** Plain ESM Node (`.mjs`), Node 22+, zero runtime dependencies, `node --test` as the test runner. No build step.

**Spec:** `docs/superpowers/specs/2026-09-11-usage-guard-design.md` — read it before starting. It records *why* each decision was made and lists constraints verified against Claude Code 2.1.220.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22+.** ESM only, `.mjs` extension, no transpilation, no build step.
- **Zero runtime dependencies.** Dev dependencies are also forbidden — `node --test` and `node:assert` are built in. Claude Code does not run `npm install` for a plugin at install time.
- **Never `exit 2`.** It is the only exit code that blocks a tool call. Every script path must end in `exit 0`. An uncaught exception that happens to exit 2 would deny every matching tool call.
- **Fail open.** Missing credentials, API error, failed refresh, stale cache, malformed config, lock contention, timeout, missing plugin root — all allow the call.
- **Every hook entry declares an explicit `"timeout"` in seconds.** The default for `PreToolUse` is 600 seconds; a hung call would stall the session for ten minutes before failing open.
- **Plugin script paths** use braced *and* quoted `"${CLAUDE_PLUGIN_ROOT}"`. Bare `$CLAUDE_PLUGIN_ROOT` breaks in exec form and on PowerShell; unquoted breaks on paths containing spaces.
- **`cwd` at hook time is the user's project directory**, never the plugin root. Derive paths from `process.env.CLAUDE_PLUGIN_ROOT`.
- **Never write `"matcher": "*"`.** A matcher containing characters outside `[A-Za-z0-9_|,-]` compiles as a JS RegExp, and a lone `*` is invalid ("nothing to repeat"). Invalid matchers return false silently. Omit the key to match all tools.
- **Commits carry no `Co-Authored-By` trailer and no "Generated with" line.** This is the repo owner's standing rule.
- **Every fail-open `catch` carries a one-line comment** saying it is deliberate and why. The empty catches in `cache.mjs`, `auth.mjs`, `config.mjs` and `session.mjs`, and the `uncaughtException`/`unhandledRejection` handlers in `hookio.mjs`, are required by the fail-open rule above — not oversights.
- **No network calls in tests.** Every module that touches the network takes an injected `fetchImpl`.
- **Injected clock.** Anything time-dependent takes a `now` parameter (milliseconds) so tests are deterministic.

---

## File Structure

```
TacosPlugins/
├── package.json                              # private, type:module, test script
├── .claude-plugin/marketplace.json            # marketplace manifest
├── packages/core/
│   ├── decide.mjs                             # PURE: gauges + thresholds -> decision
│   ├── config.mjs                             # 3-layer config resolution
│   ├── cache.mjs                              # TTL cache + file lock
│   ├── auth.mjs                               # credentials, expiry, refresh, write-back
│   ├── usage.mjs                              # fetch + normalise gauges
│   └── hookio.mjs                             # stdin parse, decision JSON, safe exit
├── packages/core/test/                        # node --test, one file per module
├── plugins/usage-guard/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── hooks/guard.mjs                        # the only hook entrypoint
│   ├── bin/explain.mjs                        # read-only CLI
│   ├── commands/budget.md
│   └── lib/                                   # VENDORED copy of packages/core (gitignored)
└── scripts/release.mjs                        # copies packages/core -> each plugin's lib/
```

Responsibilities are split so `decide.mjs` — the part that decides whether you get blocked — is pure and exhaustively testable without fs or network.

## Deliberately out of scope for v1

Spec §5 lists an **optional** `plugins/usage-guard/statusline.mjs`. No task builds it.
The hook fills the cache itself (spec §6), so the statusline is a convenience for users with
a free `statusLine.command` slot — and the repo owner's slot is already taken by the OMC HUD,
so it would never even run here. Deferred until someone asks for it; the cache file is the
interface, so adding it later changes nothing else.

Spec §14 (`model-advisor`) is a separate spec and a separate plan.

---

---

### Task 1: Repo skeleton and manifests

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/usage-guard/.claude-plugin/plugin.json`
- Create: `packages/core/test/manifests.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: a repo that loads as a Claude Code marketplace; `npm test` runs the suite

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/manifests.test.mjs`. This test encodes the schema rules verified in the spec — especially the `./` prefix, whose absence causes a *silent* stub rather than an error.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

test('marketplace manifest has the three required keys', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  assert.ok(m.name, 'name is required')
  assert.ok(m.owner && m.owner.name, 'owner.name is required')
  assert.ok(Array.isArray(m.plugins), 'plugins must be an array')
})

test('marketplace name is kebab-case and does not impersonate Anthropic', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  assert.match(m.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.doesNotMatch(m.name, /official[^a-z0-9]*(anthropic|claude)/i)
})

test('every plugin source starts with ./ and resolves to a real plugin.json', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  for (const entry of m.plugins) {
    assert.ok(entry.name, 'plugin entry needs a name')
    assert.equal(typeof entry.source, 'string')
    assert.ok(entry.source.startsWith('./'),
      `source "${entry.source}" must start with "./" or the entry is silently stubbed`)
    const manifest = join(ROOT, entry.source, '.claude-plugin', 'plugin.json')
    assert.ok(existsSync(manifest), `missing ${manifest}`)
  }
})

test('plugin.json version matches its marketplace entry', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  for (const entry of m.plugins) {
    const p = readJson(join(entry.source, '.claude-plugin', 'plugin.json'))
    assert.ok(p.name, 'plugin.json requires name')
    if (entry.version) assert.equal(p.version, entry.version)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/manifests.test.mjs`
Expected: FAIL — `ENOENT` opening `.claude-plugin/marketplace.json`.

- [ ] **Step 3: Write the manifests**

`package.json`:

```json
{
  "name": "tacosplugins",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test" }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "tacos-plugins",
  "description": "Practical Claude Code plugins.",
  "owner": { "name": "tacodx" },
  "plugins": [
    {
      "name": "usage-guard",
      "source": "./plugins/usage-guard",
      "version": "0.1.0",
      "description": "Per-chat budgets enforced against your real account rate limits.",
      "category": "workflow",
      "tags": ["usage", "rate-limits", "budget"]
    }
  ]
}
```

`plugins/usage-guard/.claude-plugin/plugin.json`:

```json
{
  "name": "usage-guard",
  "version": "0.1.0",
  "description": "Per-chat budgets enforced against your real account rate limits.",
  "author": { "name": "tacodx" }
}
```

Append to `.gitignore`:

```
plugins/*/lib/
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin plugins/usage-guard/.claude-plugin packages/core/test/manifests.test.mjs .gitignore
git commit -m "feat: repo skeleton, marketplace and plugin manifests

Manifest tests encode the verified schema rules, notably that a plugin
source missing its leading ./ is silently stubbed rather than rejected."
```

---

### Task 2: `decide.mjs` — the pure decision core

**Files:**
- Create: `packages/core/decide.mjs`
- Test: `packages/core/test/decide.test.mjs`

**Interfaces:**
- Consumes: nothing (pure — no fs, no network, no clock)
- Produces:
  - `STATE = { OK: 'ok', SOFT: 'soft', HARD: 'hard' }`
  - `decide(gauges, thresholds) -> { state, gauge, percent, soft, hard, resetsAt }`
  - `gauges` shape: `{ [name]: { percent: number, resetsAt: string|null } | null }`
  - `thresholds` shape: `{ [name]: { soft: number, hard: number } }`
  - Returns the **most severe** result across all gauges. Unknown or `null` gauges are skipped. A gauge absent from `thresholds` is ungoverned.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/decide.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, STATE } from '../decide.mjs'

const T = { five_hour: { soft: 75, hard: 90 }, seven_day: { soft: 60, hard: 80 } }

test('below soft on every gauge is ok', () => {
  const r = decide({ five_hour: { percent: 10, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.OK)
})

test('at or above soft reports soft with the offending gauge', () => {
  const r = decide({ five_hour: { percent: 75, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.SOFT)
  assert.equal(r.gauge, 'five_hour')
  assert.equal(r.percent, 75)
})

test('at or above hard reports hard', () => {
  const r = decide({ five_hour: { percent: 90, resetsAt: 'A' } }, T)
  assert.equal(r.state, STATE.HARD)
})

test('most severe gauge wins regardless of key order', () => {
  const r = decide({
    five_hour: { percent: 80, resetsAt: 'A' },
    seven_day: { percent: 85, resetsAt: 'B' },
  }, T)
  assert.equal(r.state, STATE.HARD)
  assert.equal(r.gauge, 'seven_day')
})

test('null and unknown gauges are skipped, not treated as zero', () => {
  const r = decide({ five_hour: null, mystery: { percent: 99, resetsAt: null } }, T)
  assert.equal(r.state, STATE.OK)
  assert.equal(r.gauge, null)
})

test('no gauges at all is ok, never a block', () => {
  assert.equal(decide({}, T).state, STATE.OK)
  assert.equal(decide(null, T).state, STATE.OK)
})

test('soft equal to hard skips the advisory stage', () => {
  const r = decide({ five_hour: { percent: 80, resetsAt: 'A' } },
    { five_hour: { soft: 80, hard: 80 } })
  assert.equal(r.state, STATE.HARD)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/decide.test.mjs`
Expected: FAIL — cannot find module `../decide.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/decide.mjs`:

```js
export const STATE = { OK: 'ok', SOFT: 'soft', HARD: 'hard' }

const RANK = { ok: 0, soft: 1, hard: 2 }

const NONE = Object.freeze({
  state: STATE.OK, gauge: null, percent: null, soft: null, hard: null, resetsAt: null,
})

/**
 * Pure. Returns the most severe state across all governed gauges.
 * Anything unrecognised, null, or non-numeric is skipped — never treated as 0 or as a block.
 */
export function decide(gauges, thresholds) {
  if (!gauges || !thresholds) return NONE
  let worst = NONE
  for (const [name, limit] of Object.entries(thresholds)) {
    const gauge = gauges[name]
    if (!gauge || typeof gauge.percent !== 'number' || Number.isNaN(gauge.percent)) continue
    if (!limit) continue
    if (typeof limit.soft !== 'number' || Number.isNaN(limit.soft)) continue
    if (typeof limit.hard !== 'number' || Number.isNaN(limit.hard)) continue

    let state = STATE.OK
    if (gauge.percent >= limit.hard) state = STATE.HARD
    else if (gauge.percent >= limit.soft) state = STATE.SOFT
    if (RANK[state] <= RANK[worst.state]) continue

    worst = {
      state,
      gauge: name,
      percent: gauge.percent,
      soft: limit.soft,
      hard: limit.hard,
      resetsAt: gauge.resetsAt ?? null,
    }
  }
  return worst
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/decide.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/decide.mjs packages/core/test/decide.test.mjs
git commit -m "feat(core): pure decision logic for gauge thresholds

Most-severe-wins across gauges. Unknown, null and non-numeric gauges are
skipped rather than coerced to zero, so a malformed payload can never
manufacture a block."
```

---

### Task 3: `config.mjs` — three-layer resolution

**Files:**
- Create: `packages/core/config.mjs`
- Test: `packages/core/test/config.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `DEFAULTS` — the shipped default config object
  - `mergeConfig(userConfig, sessionConfig) -> { gauges, mode }` (pure)
  - `configDir(env) -> string` — `env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`, **no tilde expansion**
  - `readConfig({ dir, sessionId, readFile }) -> { gauges, mode }` — never throws; malformed JSON falls back to defaults
  - `mode` is `'enforce' | 'dry-run' | 'off'`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/config.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, mergeConfig, configDir, readConfig } from '../config.mjs'

test('defaults govern all four gauges and weekly is tighter than five_hour', () => {
  assert.ok(DEFAULTS.gauges.five_hour && DEFAULTS.gauges.seven_day)
  assert.ok(DEFAULTS.gauges.extra_usage && DEFAULTS.gauges.scoped)
  assert.ok(DEFAULTS.gauges.seven_day.hard < DEFAULTS.gauges.five_hour.hard,
    'overshooting the weekly costs days, so it brakes earlier')
  assert.equal(DEFAULTS.mode, 'enforce')
})

test('session config overrides user config overrides defaults', () => {
  const r = mergeConfig(
    { gauges: { five_hour: { soft: 50, hard: 60 } } },
    { gauges: { five_hour: { hard: 55 } } },
  )
  assert.equal(r.gauges.five_hour.soft, 50)
  assert.equal(r.gauges.five_hour.hard, 55)
  assert.equal(r.gauges.seven_day.hard, DEFAULTS.gauges.seven_day.hard)
})

test('mode off in the session config wins', () => {
  assert.equal(mergeConfig({}, { mode: 'off' }).mode, 'off')
})

test('an unknown mode falls back to the default rather than blocking', () => {
  assert.equal(mergeConfig({ mode: 'banana' }, {}).mode, 'enforce')
})

test('configDir honours CLAUDE_CONFIG_DIR and never expands a tilde', () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/tmp/x' }), '/tmp/x')
  assert.doesNotMatch(configDir({}), /^~/)
})

test('malformed json falls back to defaults instead of throwing', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => '{ not json',
  })
  assert.deepEqual(r.gauges.five_hour, DEFAULTS.gauges.five_hour)
})

test('a missing file is not an error', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
  })
  assert.equal(r.mode, DEFAULTS.mode)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/config.test.mjs`
Expected: FAIL — cannot find module `../config.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/config.mjs`:

```js
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODES = new Set(['enforce', 'dry-run', 'off'])

export const DEFAULTS = Object.freeze({
  gauges: {
    five_hour:   { soft: 75, hard: 90 },
    seven_day:   { soft: 60, hard: 80 },
    extra_usage: { soft: 70, hard: 85 },
    scoped:      { enabled: false },
  },
  mode: 'enforce',
})

export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Pure. Later arguments win, per gauge and per key. */
export function mergeConfig(userConfig, sessionConfig) {
  const gauges = {}
  for (const name of Object.keys(DEFAULTS.gauges)) {
    gauges[name] = {
      ...DEFAULTS.gauges[name],
      ...(isObj(userConfig?.gauges?.[name]) ? userConfig.gauges[name] : {}),
      ...(isObj(sessionConfig?.gauges?.[name]) ? sessionConfig.gauges[name] : {}),
    }
  }
  const requested = sessionConfig?.mode ?? userConfig?.mode
  return { gauges, mode: MODES.has(requested) ? requested : DEFAULTS.mode }
}

/** Never throws. Any read or parse failure degrades to the layer below. */
export function readConfig({ dir, sessionId, readFile }) {
  const load = (path) => {
    try { return JSON.parse(readFile(path, 'utf8')) } catch { return {} }
  }
  const user = load(join(dir, 'tacos', 'config.json'))
  const session = sessionId ? load(join(dir, 'tacos', 'sessions', `${sessionId}.json`)) : {}
  return mergeConfig(user, session)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/config.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/config.mjs packages/core/test/config.test.mjs
git commit -m "feat(core): three-layer config resolution

Defaults < user config < per-session override. Every read and parse failure
degrades to the layer below rather than throwing, so a corrupted config can
never block a tool call."
```

---

### Task 4: `cache.mjs` — TTL cache and file lock

**Files:**
- Create: `packages/core/cache.mjs`
- Test: `packages/core/test/cache.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readCache(path, { now, ttlMs, maxStaleMs, readFile }) -> { data, fresh } | null`
    `fresh === false` means usable but past TTL; past `maxStaleMs` returns `null`.
  - `writeCache(path, data, { now, writeFile, mkdir }) -> void` — never throws
  - `withLock(lockPath, fn, { now, staleMs, fs }) -> Promise<any>` — runs `fn`; if the lock is held and not stale, runs `fn` anyway without the lock (a cache refresh is not worth blocking on)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/cache.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCache, writeCache, withLock } from '../cache.mjs'

const entry = (ts) => JSON.stringify({ fetchedAt: ts, data: { five_hour: { percent: 5 } } })

test('a fresh entry is returned with fresh=true', () => {
  const r = readCache('/c', { now: 1000, ttlMs: 60000, maxStaleMs: 900000, readFile: () => entry(1000) })
  assert.equal(r.fresh, true)
  assert.equal(r.data.five_hour.percent, 5)
})

test('past ttl but within max stale is usable and marked stale', () => {
  const r = readCache('/c', { now: 100000, ttlMs: 60000, maxStaleMs: 900000, readFile: () => entry(1000) })
  assert.equal(r.fresh, false)
})

test('past max stale returns null rather than a misleading number', () => {
  const r = readCache('/c', { now: 5000000, ttlMs: 60000, maxStaleMs: 900000, readFile: () => entry(1000) })
  assert.equal(r, null)
})

test('a missing or corrupt cache returns null, never throws', () => {
  assert.equal(readCache('/c', { now: 1, ttlMs: 1, maxStaleMs: 1, readFile: () => { throw new Error('x') } }), null)
  assert.equal(readCache('/c', { now: 1, ttlMs: 1, maxStaleMs: 1, readFile: () => 'garbage' }), null)
})

test('a write failure is swallowed', () => {
  assert.doesNotThrow(() => writeCache('/c', { a: 1 }, {
    now: 1, mkdir: () => {}, writeFile: () => { throw new Error('readonly fs') },
  }))
})

test('a held, non-stale lock still runs the function unlocked', async () => {
  let ran = false
  const fs = {
    writeLock: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }) },
    readLock: () => JSON.stringify({ at: 900 }),
    removeLock: () => {},
  }
  await withLock('/l', async () => { ran = true }, { now: 1000, staleMs: 5000, fs })
  assert.equal(ran, true, 'a cache refresh must never block on a lock')
})

test('a stale lock is broken and retaken', async () => {
  let removed = false
  let attempt = 0
  const fs = {
    writeLock: () => { if (attempt++ === 0) throw Object.assign(new Error('exists'), { code: 'EEXIST' }) },
    readLock: () => JSON.stringify({ at: 0 }),
    removeLock: () => { removed = true },
  }
  await withLock('/l', async () => {}, { now: 100000, staleMs: 5000, fs })
  assert.equal(removed, true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/cache.test.mjs`
Expected: FAIL — cannot find module `../cache.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/cache.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Returns {data, fresh} or null. Never throws. */
export function readCache(path, { now, ttlMs, maxStaleMs, readFile = readFileSync }) {
  let entry
  try { entry = JSON.parse(readFile(path, 'utf8')) } catch { return null }
  if (!entry || typeof entry.fetchedAt !== 'number' || !entry.data) return null
  const age = now - entry.fetchedAt
  if (age > maxStaleMs) return null
  return { data: entry.data, fresh: age <= ttlMs }
}

/** Never throws — a cache we cannot persist is a slow cache, not a broken session. */
export function writeCache(path, data, {
  now, writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  try {
    mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFile(tmp, JSON.stringify({ fetchedAt: now, data }), { mode: 0o600 })
    renameSync(tmp, path)
  } catch { /* ignore */ }
}

const defaultFs = {
  writeLock: (p, body) => writeFileSync(p, body, { flag: 'wx' }),
  readLock: (p) => readFileSync(p, 'utf8'),
  removeLock: (p) => unlinkSync(p),
}

/**
 * Best-effort lock. If another process holds a live lock we run anyway:
 * a duplicate usage fetch is far cheaper than stalling a hook.
 */
export async function withLock(lockPath, fn, { now, staleMs, fs = defaultFs } = {}) {
  let held = false
  try {
    fs.writeLock(lockPath, JSON.stringify({ at: now, pid: process.pid }))
    held = true
  } catch (err) {
    if (err?.code === 'EEXIST') {
      let at = 0
      try { at = JSON.parse(fs.readLock(lockPath))?.at ?? 0 } catch { at = 0 }
      if (now - at > staleMs) {
        try { fs.removeLock(lockPath) } catch { /* ignore */ }
        try { fs.writeLock(lockPath, JSON.stringify({ at: now, pid: process.pid })); held = true }
        catch { /* ignore */ }
      }
    }
  }
  try { return await fn() }
  finally { if (held) { try { fs.removeLock(lockPath) } catch { /* ignore */ } } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/cache.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/cache.mjs packages/core/test/cache.test.mjs
git commit -m "feat(core): ttl cache with best-effort file locking

Data past max staleness returns null so the guard reports itself blind
rather than serving a misleading number. Lock contention never blocks —
a duplicate fetch is cheaper than stalling a hook."
```

---

### Task 5: `auth.mjs` — credentials, expiry, refresh, write-back

**Files:**
- Create: `packages/core/auth.mjs`
- Test: `packages/core/test/auth.test.mjs`

**Interfaces:**
- Consumes: `configDir` from `config.mjs`
- Produces:
  - `CLIENT_ID` and `TOKEN_URL` constants
  - `credentialsPath(dir) -> string`
  - `readCredentials(path, readFile) -> { accessToken, refreshToken, expiresAt, subscriptionType, rateLimitTier } | null`
  - `isExpired(cred, now, marginMs = 300000) -> boolean`
  - `refreshToken(cred, { fetchImpl, clientId, scope }) -> cred | null`
  - `writeBackCredentials(path, cred, { readFile, writeFile }) -> void` — read-modify-write preserving siblings
  - `getAccessToken({ dir, now, fetchImpl, readFile, writeFile }) -> { token, error }`

> Critical: refresh tokens **rotate**. The write must preserve `mcpOAuth` and every other
> top-level key in `.credentials.json`, write via a `0600` temp file, then rename.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/auth.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExpired, refreshToken, writeBackCredentials, readCredentials, TOKEN_URL } from '../auth.mjs'

const cred = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 }

test('expiry uses a five minute margin', () => {
  assert.equal(isExpired(cred, 600_000), false)
  assert.equal(isExpired(cred, 700_001), true, 'inside the 300s margin counts as expired')
  assert.equal(isExpired(cred, 1_200_000), true)
})

test('readCredentials pulls claudeAiOauth and tolerates junk', () => {
  const ok = readCredentials('/p', () => JSON.stringify({ claudeAiOauth: cred }))
  assert.equal(ok.accessToken, 'a')
  assert.equal(readCredentials('/p', () => 'garbage'), null)
  assert.equal(readCredentials('/p', () => JSON.stringify({})), null)
})

test('refresh posts to the platform token endpoint, not api.anthropic.com', async () => {
  let seen
  await refreshToken(cred, {
    fetchImpl: async (url, opts) => {
      seen = { url, opts }
      return { ok: true, json: async () => ({ access_token: 'a2', expires_in: 3600 }) }
    },
  })
  assert.equal(seen.url, TOKEN_URL)
  assert.match(seen.url, /platform\.claude\.com/)
  const body = JSON.parse(seen.opts.body)
  assert.equal(body.grant_type, 'refresh_token')
  assert.equal(body.refresh_token, 'r')
  assert.ok(body.client_id)
})

test('a rotated refresh token is captured; an absent one keeps the old', async () => {
  const rotated = await refreshToken(cred, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 60 }) }),
  })
  assert.equal(rotated.refreshToken, 'r2')
  const kept = await refreshToken(cred, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'a2', expires_in: 60 }) }),
  })
  assert.equal(kept.refreshToken, 'r')
})

test('a failed refresh returns null rather than throwing', async () => {
  assert.equal(await refreshToken(cred, { fetchImpl: async () => ({ ok: false, status: 400 }) }), null)
  assert.equal(await refreshToken(cred, { fetchImpl: async () => { throw new Error('offline') } }), null)
})

test('write-back preserves sibling keys such as mcpOAuth', () => {
  let written
  writeBackCredentials('/p', { accessToken: 'new', refreshToken: 'r2', expiresAt: 9 }, {
    readFile: () => JSON.stringify({ mcpOAuth: { server: { token: 'keep' } }, claudeAiOauth: cred }),
    writeFile: (_p, body) => { written = JSON.parse(body) },
    rename: () => {},
  })
  assert.equal(written.mcpOAuth.server.token, 'keep', 'mcp tokens must survive')
  assert.equal(written.claudeAiOauth.accessToken, 'new')
})

test('write-back uses mode 0600', () => {
  let mode
  writeBackCredentials('/p', cred, {
    readFile: () => JSON.stringify({ claudeAiOauth: cred }),
    writeFile: (_p, _b, opts) => { mode = opts?.mode },
    rename: () => {},
  })
  assert.equal(mode, 0o600)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/auth.test.mjs`
Expected: FAIL — cannot find module `../auth.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/auth.mjs`:

```js
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLIENT_ID = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

const EXPIRY_MARGIN_MS = 300_000 // matches Claude Code's own margin

export function credentialsPath(dir) {
  return join(dir, '.credentials.json')
}

export function readCredentials(path, readFile = readFileSync) {
  try {
    const o = JSON.parse(readFile(path, 'utf8'))?.claudeAiOauth
    return o?.accessToken ? o : null
  } catch { return null }
}

export function isExpired(cred, now, marginMs = EXPIRY_MARGIN_MS) {
  if (!cred?.expiresAt) return false
  return now + marginMs >= cred.expiresAt
}

/** Returns updated credentials, or null on any failure. Never throws. */
export async function refreshToken(cred, {
  fetchImpl = fetch, clientId = CLIENT_ID, scope = SCOPE,
} = {}) {
  if (!cred?.refreshToken) return null
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        client_id: clientId,
        scope,
      }),
    })
    if (!res?.ok) return null
    const body = await res.json()
    if (!body?.access_token) return null
    return {
      ...cred,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || cred.refreshToken,
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : cred.expiresAt,
    }
  } catch { return null }
}

/** Read-modify-write. Preserves every sibling key, notably mcpOAuth. Never throws. */
export function writeBackCredentials(path, cred, {
  readFile = readFileSync, writeFile = writeFileSync, rename = renameSync,
} = {}) {
  try {
    let doc = {}
    try { doc = JSON.parse(readFile(path, 'utf8')) || {} } catch { doc = {} }
    doc.claudeAiOauth = { ...(doc.claudeAiOauth || {}), ...cred }
    const tmp = `${path}.${process.pid}.tmp`
    writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    rename(tmp, path)
  } catch { /* fail open: a credential we cannot persist is a slow path, not a broken session */ }
}

/** Returns {token, error}. Never throws. */
export async function getAccessToken({
  dir, now, fetchImpl = fetch, readFile = readFileSync, writeFile = writeFileSync,
}) {
  const path = credentialsPath(dir)
  const cred = readCredentials(path, readFile)
  if (!cred) return { token: null, error: 'no-credentials' }
  if (!isExpired(cred, now)) return { token: cred.accessToken, error: null }

  const refreshed = await refreshToken(cred, { fetchImpl })
  if (!refreshed) return { token: null, error: 'refresh-failed' }
  writeBackCredentials(path, refreshed, { readFile, writeFile })
  return { token: refreshed.accessToken, error: null }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/auth.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/auth.mjs packages/core/test/auth.test.mjs
git commit -m "feat(core): oauth credential read, refresh and write-back

Refresh tokens rotate, so write-back is mandatory and must preserve sibling
keys — mcpOAuth server tokens live in the same file. Uses Claude Code's own
five-minute expiry margin rather than refreshing only after expiry."
```

---

### Task 6: `usage.mjs` — fetch and normalise the gauges

**Files:**
- Create: `packages/core/usage.mjs`
- Create: `packages/core/test/fixtures/usage-max.json`
- Create: `packages/core/test/fixtures/usage-sparse.json`
- Test: `packages/core/test/usage.test.mjs`

**Interfaces:**
- Consumes: `getAccessToken` (auth), `readCache`/`writeCache`/`withLock` (cache), `configDir` (config)
- Produces:
  - `USAGE_URL`, `normalise(apiResponse) -> gauges`
  - `fetchUsage({ token, fetchImpl, timeoutMs }) -> { raw, error }`
  - `getGauges({ dir, now, fetchImpl, ttlMs, maxStaleMs, ... }) -> { gauges, blind, reason, fresh }`
  - `gauges` matches the shape `decide()` consumes, plus `extra_usage` carries `{ percent, resetsAt, usedMinor, limitMinor, currency, decimals }`

- [ ] **Step 1: Write the failing test and fixtures**

Create `packages/core/test/fixtures/usage-max.json` — a realistic response including the awkward shapes:

```json
{
  "five_hour": { "utilization": 35.0, "resets_at": "2026-09-11T20:00:00Z" },
  "seven_day": { "utilization": 81.0, "resets_at": "2026-09-12T22:00:00Z" },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "extra_usage": {
    "is_enabled": true, "monthly_limit": 6000, "used_credits": 5048.0,
    "utilization": 84.13333333333334, "currency": "EUR", "decimal_places": 2
  },
  "limits": [
    { "kind": "session", "group": "session", "percent": 35, "severity": "normal",
      "resets_at": "2026-09-11T20:00:00Z", "scope": null, "is_active": false },
    { "kind": "weekly_scoped", "group": "weekly", "percent": 4, "severity": "normal",
      "resets_at": "2026-09-12T21:59:59Z", "scope": { "model": { "display_name": "Fable" } },
      "is_active": false }
  ]
}
```

Create `packages/core/test/fixtures/usage-sparse.json`:

```json
{ "five_hour": { "utilization": 1.0, "resets_at": null }, "seven_day": null, "extra_usage": null }
```

Create `packages/core/test/usage.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalise, fetchUsage, USAGE_URL } from '../usage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', `${n}.json`), 'utf8'))

test('utilization becomes percent and resets_at becomes resetsAt', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.five_hour.percent, 35)
  assert.equal(g.five_hour.resetsAt, '2026-09-11T20:00:00Z')
  assert.equal(g.seven_day.percent, 81)
})

test('money is decoded from minor units, never shown raw', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.extra_usage.percent, 84.13333333333334)
  assert.equal(g.extra_usage.usedMinor, 5048)
  assert.equal(g.extra_usage.limitMinor, 6000)
  assert.equal(g.extra_usage.currency, 'EUR')
  assert.equal(g.extra_usage.decimals, 2)
})

test('null gauges normalise to null, not to zero', () => {
  const g = normalise(fixture('usage-sparse'))
  assert.equal(g.seven_day, null)
  assert.equal(g.extra_usage, null)
  assert.equal(g.five_hour.percent, 1)
})

test('the scoped bucket is collected with its model name', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.scoped.length, 1)
  assert.equal(g.scoped[0].model, 'Fable')
  assert.equal(g.scoped[0].percent, 4)
})

test('an unrecognised payload yields empty gauges rather than throwing', () => {
  assert.deepEqual(normalise(null).scoped, [])
  assert.equal(normalise({}).five_hour, null)
  assert.equal(normalise('nonsense').five_hour, null)
})

test('fetchUsage sends the oauth beta header to the usage endpoint', async () => {
  let seen
  await fetchUsage({
    token: 't',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({}) } },
  })
  assert.equal(seen.url, USAGE_URL)
  assert.equal(seen.opts.headers.Authorization, 'Bearer t')
  assert.equal(seen.opts.headers['anthropic-beta'], 'oauth-2025-04-20')
})

test('a non-ok response reports an error instead of throwing', async () => {
  const r = await fetchUsage({ token: 't', fetchImpl: async () => ({ ok: false, status: 429 }) })
  assert.equal(r.raw, null)
  assert.match(r.error, /429/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/usage.test.mjs`
Expected: FAIL — cannot find module `../usage.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/usage.mjs`:

```js
import { join } from 'node:path'
import { getAccessToken } from './auth.mjs'
import { readCache, writeCache, withLock } from './cache.mjs'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null)

function gauge(node) {
  const percent = num(node?.utilization)
  if (percent === null) return null
  return { percent, resetsAt: node?.resets_at ?? null }
}

/** Pure. Tolerates any payload shape. */
export function normalise(raw) {
  if (!raw || typeof raw !== 'object') {
    return { five_hour: null, seven_day: null, extra_usage: null, scoped: [] }
  }
  const extra = raw.extra_usage
  return {
    five_hour: gauge(raw.five_hour),
    seven_day: gauge(raw.seven_day),
    extra_usage: num(extra?.utilization) === null ? null : {
      percent: extra.utilization,
      resetsAt: extra.resets_at ?? null,
      usedMinor: num(extra.used_credits),
      limitMinor: num(extra.monthly_limit),
      currency: extra.currency ?? null,
      decimals: num(extra.decimal_places) ?? 2,
    },
    scoped: (Array.isArray(raw.limits) ? raw.limits : [])
      .filter((l) => l?.kind === 'weekly_scoped' && num(l.percent) !== null)
      .map((l) => ({
        model: l.scope?.model?.display_name ?? null,
        percent: l.percent,
        resetsAt: l.resets_at ?? null,
      })),
  }
}

/** Returns {raw, error}. Never throws. */
export async function fetchUsage({ token, fetchImpl = fetch, timeoutMs = 3000 }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ac.signal,
    })
    if (!res?.ok) return { raw: null, error: `http-${res?.status ?? 'unknown'}` }
    return { raw: await res.json(), error: null }
  } catch (err) {
    return { raw: null, error: err?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally { clearTimeout(timer) }
}

/**
 * Cache-first. Returns {gauges, blind, reason, fresh}.
 * blind=true means we have no usable data — callers MUST allow everything.
 */
export async function getGauges({
  dir, now, fetchImpl = fetch, ttlMs = 60_000, maxStaleMs = 900_000, timeoutMs = 3000,
}) {
  const cachePath = join(dir, 'tacos', 'usage-cache.json')
  const cached = readCache(cachePath, { now, ttlMs, maxStaleMs })
  if (cached?.fresh) return { gauges: cached.data, blind: false, reason: null, fresh: true }

  const { token, error: authError } = await getAccessToken({ dir, now, fetchImpl })
  if (!token) {
    if (cached) return { gauges: cached.data, blind: false, reason: authError, fresh: false }
    return { gauges: null, blind: true, reason: authError, fresh: false }
  }

  let result = { raw: null, error: 'skipped' }
  await withLock(`${cachePath}.lock`, async () => {
    result = await fetchUsage({ token, fetchImpl, timeoutMs })
  }, { now, staleMs: timeoutMs + 5000 })

  if (result.error) {
    if (cached) return { gauges: cached.data, blind: false, reason: result.error, fresh: false }
    return { gauges: null, blind: true, reason: result.error, fresh: false }
  }
  const gauges = normalise(result.raw)
  writeCache(cachePath, gauges, { now })
  return { gauges, blind: false, reason: null, fresh: true }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/usage.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 5: Run the whole suite, then commit**

Run: `npm test`
Expected: all tests from Tasks 1–6 pass.

```bash
git add packages/core/usage.mjs packages/core/test/usage.test.mjs packages/core/test/fixtures
git commit -m "feat(core): fetch and normalise all four usage gauges

Cache-first with a hard 3s fetch deadline. A stale-but-usable cache beats a
blind guard; past max staleness the caller is told it is blind so it can
allow everything rather than serve a misleading number."
```

---

### Task 7: Vendoring, rendering, and the `explain` CLI

**This is the proof milestone.** At the end of this task the whole data layer runs against the real account, read-only, with no code that can deny anything yet.

**Files:**
- Create: `packages/core/render.mjs`
- Create: `scripts/release.mjs`
- Create: `plugins/usage-guard/bin/explain.mjs`
- Test: `packages/core/test/render.test.mjs`
- Test: `packages/core/test/release.test.mjs`

**Interfaces:**
- Consumes: `decide`/`STATE` (decide), `DEFAULTS` (config), gauge shapes (usage)
- Produces:
  - `formatMoney(usedMinor, limitMinor, currency, decimals) -> string`
  - `bar(percent, width) -> string`
  - `renderStatus({ gauges, thresholds, decision, mode, blind, reason }) -> string`
  - `vendorCore(coreDir, targetLibDir) -> string[]` (list of copied filenames)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/render.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMoney, bar, renderStatus } from '../render.mjs'
import { STATE } from '../decide.mjs'
import { DEFAULTS } from '../config.mjs'

test('money is decoded from minor units', () => {
  assert.equal(formatMoney(5048, 6000, 'EUR', 2), 'EUR 50.48 / 60.00')
})

test('a zero-decimal currency is not divided', () => {
  assert.equal(formatMoney(500, 1000, 'JPY', 0), 'JPY 500 / 1000')
})

test('the bar is clamped at both ends', () => {
  assert.equal(bar(0, 10).length, 10)
  assert.equal(bar(150, 10).length, 10)
  assert.equal(bar(-5, 10).length, 10)
})

test('a blind guard says so and never prints a number', () => {
  const out = renderStatus({ gauges: null, thresholds: DEFAULTS.gauges, decision: null, mode: 'enforce', blind: true, reason: 'no-credentials' })
  assert.match(out, /no usage data/i)
  assert.match(out, /no-credentials/)
  assert.doesNotMatch(out, /\d+%/)
})

test('a governed gauge shows its percent and thresholds', () => {
  const gauges = { five_hour: { percent: 35, resetsAt: '2026-09-11T20:00:00Z' }, seven_day: null, extra_usage: null, scoped: [] }
  const out = renderStatus({ gauges, thresholds: DEFAULTS.gauges, decision: { state: STATE.OK }, mode: 'enforce', blind: false })
  assert.match(out, /five_hour/)
  assert.match(out, /35/)
  assert.match(out, /75/)
})
```

Create `packages/core/test/release.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vendorCore } from '../../../scripts/release.mjs'

test('vendorCore copies core modules but not tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacos-'))
  const core = join(root, 'core')
  const lib = join(root, 'lib')
  mkdirSync(join(core, 'test'), { recursive: true })
  writeFileSync(join(core, 'decide.mjs'), 'export const a = 1')
  writeFileSync(join(core, 'usage.mjs'), 'export const b = 2')
  writeFileSync(join(core, 'test', 'decide.test.mjs'), 'nope')

  const copied = vendorCore(core, lib)

  assert.deepEqual(copied.sort(), ['decide.mjs', 'usage.mjs'])
  assert.ok(existsSync(join(lib, 'decide.mjs')))
  assert.ok(!existsSync(join(lib, 'test')), 'tests must not ship to users')
  assert.match(readFileSync(join(lib, 'decide.mjs'), 'utf8'), /export const a/)
})

test('vendoring twice is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacos-'))
  const core = join(root, 'core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'decide.mjs'), 'export const a = 1')
  vendorCore(core, join(root, 'lib'))
  assert.doesNotThrow(() => vendorCore(core, join(root, 'lib')))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/core/test/render.test.mjs packages/core/test/release.test.mjs`
Expected: FAIL — cannot find `../render.mjs` and `../../../scripts/release.mjs`.

- [ ] **Step 3: Write `render.mjs`**

```js
import { STATE } from './decide.mjs'

export function formatMoney(usedMinor, limitMinor, currency, decimals = 2) {
  const f = (v) => (decimals > 0 ? (v / 10 ** decimals).toFixed(decimals) : String(v))
  return `${currency} ${f(usedMinor)} / ${f(limitMinor)}`
}

export function bar(percent, width = 14) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  const filled = Math.round((clamped / 100) * width)
  return '='.repeat(filled) + '.'.repeat(width - filled)
}

export function renderStatus({ gauges, thresholds, decision, mode, blind, reason }) {
  const lines = [`usage-guard  [mode: ${mode}]`, '']
  if (blind || !gauges) {
    lines.push(`  no usage data available (${reason || 'unknown'})`)
    lines.push('  the guard is blind and is allowing everything.')
    return lines.join('\n')
  }
  for (const [name, limit] of Object.entries(thresholds)) {
    if (name === 'scoped') continue
    const g = gauges[name]
    if (!g) { lines.push(`  ${name.padEnd(12)} not reported by this account`); continue }
    const money = g.usedMinor != null
      ? `  (${formatMoney(g.usedMinor, g.limitMinor, g.currency, g.decimals)})` : ''
    lines.push(`  ${name.padEnd(12)} [${bar(g.percent)}] ${String(Math.round(g.percent)).padStart(3)}%` +
      `  soft ${limit.soft} / hard ${limit.hard}${money}`)
    if (g.resetsAt) lines.push(`  ${''.padEnd(12)} resets ${g.resetsAt}`)
  }
  for (const s of gauges.scoped || []) {
    lines.push(`  ${`scoped:${s.model}`.padEnd(12)} [${bar(s.percent)}] ${String(Math.round(s.percent)).padStart(3)}%  (informational)`)
  }
  lines.push('')
  const state = decision?.state ?? STATE.OK
  if (state === STATE.OK) lines.push('  decision: allow — below every soft threshold.')
  else if (state === STATE.SOFT) lines.push(`  decision: advise — ${decision.gauge} at ${decision.percent}% (soft ${decision.soft}). New fan-out would be declined.`)
  else lines.push(`  decision: deny — ${decision.gauge} at ${decision.percent}% (ceiling ${decision.hard}).`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Write `scripts/release.mjs`**

```js
#!/usr/bin/env node
import { readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Copies every top-level .mjs from coreDir into targetLibDir. Returns copied filenames. */
export function vendorCore(coreDir, targetLibDir) {
  mkdirSync(targetLibDir, { recursive: true })
  const copied = []
  for (const name of readdirSync(coreDir)) {
    if (!name.endsWith('.mjs')) continue
    if (statSync(join(coreDir, name)).isDirectory()) continue
    copyFileSync(join(coreDir, name), join(targetLibDir, name))
    copied.push(name)
  }
  return copied
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const core = join(root, 'packages', 'core')
  for (const plugin of readdirSync(join(root, 'plugins'))) {
    const lib = join(root, 'plugins', plugin, 'lib')
    const copied = vendorCore(core, lib)
    console.log(`vendored ${copied.length} modules into plugins/${plugin}/lib/`)
  }
}
```

- [ ] **Step 5: Write `plugins/usage-guard/bin/explain.mjs`**

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { configDir, readConfig } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { decide } = await load('decide.mjs')
const { renderStatus } = await load('render.mjs')

const dir = configDir(process.env)
const sessionId = process.argv[2] || null
const cfg = readConfig({ dir, sessionId, readFile: readFileSync })
const { gauges, blind, reason } = await getGauges({ dir, now: Date.now() })
const decision = blind ? null : decide(gauges, cfg.gauges)
console.log(renderStatus({ gauges, thresholds: cfg.gauges, decision, mode: cfg.mode, blind, reason }))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the two new files.

- [ ] **Step 7: MILESTONE — run it against the real account**

```bash
node scripts/release.mjs && node plugins/usage-guard/bin/explain.mjs
```

Expected: real percentages for `five_hour` and `seven_day`, a euro figure for `extra_usage` if the account has metered usage, any scoped model buckets, and `decision: allow`.

Sanity-check the output against `/usage` in a Claude Code session. **If the numbers disagree, stop and fix before continuing** — everything after this task trusts this layer.

- [ ] **Step 8: Commit**

```bash
git add packages/core/render.mjs scripts/release.mjs plugins/usage-guard/bin/explain.mjs packages/core/test/render.test.mjs packages/core/test/release.test.mjs
git commit -m "feat: core vendoring, status rendering and read-only explain CLI

explain proves the whole data layer against a real account before any code
that can deny a tool call exists. Vendoring keeps the repo DRY while each
installed plugin stays self-contained, since Claude Code will not run an
install step for a plugin."
```

---

### Task 8: `hookio.mjs` — stdin, decision JSON, guaranteed exit 0

**Files:**
- Create: `packages/core/hookio.mjs`
- Test: `packages/core/test/hookio.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseHookInput(raw) -> object` (never throws; `{}` on junk)
  - `allowOutput() -> null`
  - `denyOutput(hookEventName, reason) -> object`
  - `contextOutput(hookEventName, text) -> object`
  - `run(main)` — reads stdin, awaits `main(input)`, prints its returned object as JSON if non-null, and **always exits 0**

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHookInput, allowOutput, denyOutput, contextOutput } from '../hookio.mjs'

const CORE = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '')

test('junk stdin parses to an empty object, never throws', () => {
  assert.deepEqual(parseHookInput('not json'), {})
  assert.deepEqual(parseHookInput(''), {})
  assert.deepEqual(parseHookInput('null'), {})
})

test('allow emits nothing at all', () => {
  assert.equal(allowOutput(), null)
})

test('deny emits the exact documented shape', () => {
  const o = denyOutput('PreToolUse', 'ceiling hit')
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'ceiling hit')
})

test('context emits additionalContext', () => {
  const o = contextOutput('UserPromptSubmit', 'at 76%')
  assert.equal(o.hookSpecificOutput.additionalContext, 'at 76%')
  assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
})

test('run exits 0 even when main throws', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => { throw new Error('boom') })
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  assert.equal(out.trim(), '', 'a crashing hook must emit nothing and allow')
})

test('run exits 0 and emits nothing when stdin is garbage', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run, allowOutput } from '${join(CORE, 'hookio.mjs')}'
    run(async () => allowOutput())
  `)
  const out = execFileSync('node', [script], { input: '<<<garbage>>>', encoding: 'utf8' })
  assert.equal(out.trim(), '')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/hookio.test.mjs`
Expected: FAIL — cannot find module `../hookio.mjs`.

- [ ] **Step 3: Write the implementation**

```js
export function parseHookInput(raw) {
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}

export function allowOutput() { return null }

export function denyOutput(hookEventName, reason) {
  return { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason } }
}

export function contextOutput(hookEventName, text) {
  return { hookSpecificOutput: { hookEventName, additionalContext: text } }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * ALWAYS exits 0. exit 2 is the only code that blocks a tool call, so an
 * uncaught throw here would deny every matching call.
 */
export function run(main) {
  const finish = (output) => {
    try { if (output) process.stdout.write(JSON.stringify(output)) } catch { /* ignore */ }
    process.exit(0)
  }
  const guard = setTimeout(() => finish(null), 4500).unref?.() ?? null
  readStdin()
    .then((raw) => main(parseHookInput(raw)))
    .then((out) => { clearTimeout(guard); finish(out) })
    .catch(() => { clearTimeout(guard); finish(null) })
  process.on('uncaughtException', () => finish(null))
  process.on('unhandledRejection', () => finish(null))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/test/hookio.test.mjs`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/hookio.mjs packages/core/test/hookio.test.mjs
git commit -m "feat(core): hook io with a guaranteed exit 0

exit 2 is the only code that blocks a tool call, so every path here -- throw,
junk stdin, unhandled rejection, internal deadline -- funnels to exit 0 with
no output, which Claude Code treats as allow."
```

---

### Task 9: `guard.mjs` and `hooks.json` — wired, but dry-run only

The hook is registered and observes real sessions, but the deny paths do not exist yet. `mode` ships as `dry-run` in this task and flips to `enforce` in Task 11.

**Files:**
- Create: `plugins/usage-guard/hooks/guard.mjs`
- Create: `plugins/usage-guard/hooks/hooks.json`
- Test: `packages/core/test/guard.contract.test.mjs`

**Interfaces:**
- Consumes: every core module
- Produces: `decideForHook({ input, cfg, gauges, blind }) -> { action, text }` where `action` is `'allow' | 'context' | 'deny'`

- [ ] **Step 1: Write the failing contract test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideForHook } from '../../../plugins/usage-guard/hooks/guard.mjs'
import { DEFAULTS } from '../config.mjs'

const cfg = { gauges: DEFAULTS.gauges, mode: 'dry-run' }
const at = (p) => ({ five_hour: { percent: p, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] })
const input = (over = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's', ...over })

test('a blind guard always allows', () => {
  assert.equal(decideForHook({ input: input(), cfg, gauges: null, blind: true }).action, 'allow')
})

test('below soft, nothing is injected', () => {
  assert.equal(decideForHook({ input: input(), cfg, gauges: at(10), blind: false }).action, 'allow')
})

test('dry-run never denies, however high the gauge', () => {
  const r = decideForHook({ input: input(), cfg, gauges: at(99), blind: false })
  assert.notEqual(r.action, 'deny')
})

test('mode off allows even at 100%', () => {
  const r = decideForHook({ input: input(), cfg: { ...cfg, mode: 'off' }, gauges: at(100), blind: false })
  assert.equal(r.action, 'allow')
})

test('above soft on UserPromptSubmit injects advisory text that forbids quality cuts', () => {
  const r = decideForHook({ input: input({ hook_event_name: 'UserPromptSubmit' }), cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'context')
  assert.match(r.text, /do not reduce effort/i)
  assert.match(r.text, /80/)
})

test('the Workflow tool is treated as fan-out, exactly like Agent', () => {
  const r = decideForHook({ input: input({ tool_name: 'Workflow' }), cfg: { ...cfg, mode: 'enforce' }, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})

test('tool_name Task is never expected, but is handled defensively', () => {
  const r = decideForHook({ input: input({ tool_name: 'Task' }), cfg: { ...cfg, mode: 'enforce' }, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/guard.contract.test.mjs`
Expected: FAIL — cannot find `guard.mjs`.

- [ ] **Step 3: Write `guard.mjs`**

```js
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { decide, STATE } = await load('decide.mjs')
const { configDir, readConfig } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { run, allowOutput, denyOutput, contextOutput } = await load('hookio.mjs')

const FANOUT = new Set(['Agent', 'Workflow', 'Task'])

const advisory = (d) => [
  `Usage budget: ${d.gauge} is at ${Math.round(d.percent)}% (soft ${d.soft}, ceiling ${d.hard}).`,
  'Finish the current task properly. Do NOT start new large-scope work.',
  'Prefer a small number of targeted subagents over broad fan-out.',
  'Do NOT reduce effort, switch model, shorten reasoning, or cut corners on work already underway —',
  'quality is not the lever here; scope is.',
].join(' ')

/** Pure, so it can be tested without fs or network. */
export function decideForHook({ input, cfg, gauges, blind }) {
  if (blind || !gauges || cfg.mode === 'off') return { action: 'allow', text: null }
  const d = decide(gauges, cfg.gauges)
  if (d.state === STATE.OK) return { action: 'allow', text: null }

  const event = input.hook_event_name
  const enforcing = cfg.mode === 'enforce'

  if (d.state === STATE.HARD && enforcing && event === 'PreToolUse') {
    return { action: 'deny', text: `Usage ceiling reached: ${d.gauge} at ${Math.round(d.percent)}% (ceiling ${d.hard}). Winding down; nothing new will start.` }
  }
  if (d.state === STATE.SOFT && enforcing && event === 'PreToolUse' && FANOUT.has(input.tool_name)) {
    return { action: 'deny', text: `Usage budget: ${d.gauge} at ${Math.round(d.percent)}% (soft ${d.soft}). New fan-out is paused. Continue with the work already in progress.` }
  }
  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    return { action: 'context', text: advisory(d) }
  }
  return { action: 'allow', text: null }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) run(async (input) => {
  const dir = configDir(process.env)
  const cfg = readConfig({ dir, sessionId: input.session_id, readFile: readFileSync })
  const { gauges, blind } = await getGauges({ dir, now: Date.now() })
  const { action, text } = decideForHook({ input, cfg, gauges, blind })
  if (action === 'deny') return denyOutput(input.hook_event_name, text)
  if (action === 'context') return contextOutput(input.hook_event_name, text)
  return allowOutput()
})
```

- [ ] **Step 4: Write `hooks.json`**

Note the explicit `timeout` on every entry, the omitted `matcher` on the all-tools entry, and the quoted braced variable.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "timeout": 5, "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs\"" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "timeout": 5, "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs\"" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Agent|Workflow",
        "hooks": [ { "type": "command", "timeout": 5, "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs\"" } ] },
      { "hooks": [ { "type": "command", "timeout": 5, "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs\"" } ] }
    ]
  }
}
```

- [ ] **Step 5: Set the shipped default to dry-run**

In `packages/core/config.mjs`, change `DEFAULTS.mode` to `'dry-run'`, and update the assertion in `packages/core/test/config.test.mjs` from `'enforce'` to `'dry-run'`.

- [ ] **Step 6: Run the whole suite**

Run: `node scripts/release.mjs && npm test`
Expected: all tests pass.

- [ ] **Step 7: Install locally and observe a real session**

```bash
claude plugin marketplace add /home/danja/Projects/TacosPlugins
claude plugin install usage-guard@tacos-plugins
```

Start a session, run a few tools, then confirm with `node plugins/usage-guard/bin/explain.mjs` that the cache is being populated. Nothing should ever be blocked in this mode.

- [ ] **Step 8: Commit**

```bash
git add plugins/usage-guard/hooks packages/core/test/guard.contract.test.mjs packages/core/config.mjs packages/core/test/config.test.mjs
git commit -m "feat(usage-guard): wire hooks in dry-run mode

Ships as dry-run so the hook can be observed against real sessions before it
is allowed to deny anything. Fan-out matching covers Workflow as well as
Agent, since the Workflow tool spawns subagents under its own tool name."
```

---

### Task 10: `/budget` command and per-session state

A plugin command expands to a prompt, so it cannot write a file by itself. `/budget` therefore instructs Claude to run a small CLI that does the writing.

**Files:**
- Create: `packages/core/session.mjs`
- Create: `plugins/usage-guard/bin/budget.mjs`
- Create: `plugins/usage-guard/commands/budget.md`
- Test: `packages/core/test/session.test.mjs`

**Interfaces:**
- Consumes: `configDir` (config)
- Produces:
  - `sessionPath(dir, sessionId) -> string`
  - `writeSessionConfig(dir, sessionId, patch, { writeFile, mkdir }) -> void`
  - `parseBudgetArgs(argv) -> { gauge, soft, hard, mode } | { error }`
  - `gcSessions(dir, { now, maxAgeMs, readdir, stat, remove }) -> string[]`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBudgetArgs, gcSessions } from '../session.mjs'

test('a bare number sets the five_hour ceiling', () => {
  assert.deepEqual(parseBudgetArgs(['80']), { gauge: 'five_hour', hard: 80 })
})

test('a named gauge is honoured', () => {
  assert.deepEqual(parseBudgetArgs(['weekly', '70']), { gauge: 'seven_day', hard: 70 })
  assert.deepEqual(parseBudgetArgs(['money', '60']), { gauge: 'extra_usage', hard: 60 })
})

test('off sets mode off', () => {
  assert.deepEqual(parseBudgetArgs(['off']), { mode: 'off' })
})

test('an out-of-range or unparseable value is rejected, not clamped', () => {
  assert.ok(parseBudgetArgs(['150']).error)
  assert.ok(parseBudgetArgs(['-3']).error)
  assert.ok(parseBudgetArgs(['banana']).error)
  assert.ok(parseBudgetArgs(['weekly']).error)
})

test('gc removes only entries older than the max age', () => {
  const removed = gcSessions('/d', {
    now: 1_000_000_000, maxAgeMs: 100,
    readdir: () => ['old.json', 'new.json'],
    stat: (p) => ({ mtimeMs: p.includes('old') ? 0 : 999_999_999 }),
    remove: () => {},
  })
  assert.deepEqual(removed, ['old.json'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/session.test.mjs`
Expected: FAIL — cannot find module `../session.mjs`.

- [ ] **Step 3: Write `session.mjs`**

```js
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ALIASES = {
  '5h': 'five_hour', session: 'five_hour', five_hour: 'five_hour',
  weekly: 'seven_day', week: 'seven_day', seven_day: 'seven_day',
  money: 'extra_usage', spend: 'extra_usage', extra_usage: 'extra_usage',
}

export function sessionPath(dir, sessionId) {
  return join(dir, 'tacos', 'sessions', `${sessionId}.json`)
}

export function parseBudgetArgs(argv) {
  const a = argv.filter(Boolean)
  if (a.length === 0) return { error: 'no arguments' }
  if (a[0] === 'off') return { mode: 'off' }
  if (a[0] === 'on') return { mode: 'enforce' }

  const [gaugeWord, valueWord] = a.length === 1 ? ['five_hour', a[0]] : [a[0], a[1]]
  const gauge = ALIASES[String(gaugeWord).toLowerCase()]
  if (!gauge) return { error: `unknown gauge "${gaugeWord}"` }
  const hard = Number(valueWord)
  if (!Number.isFinite(hard) || hard <= 0 || hard > 100) return { error: `"${valueWord}" is not a percentage between 1 and 100` }
  return { gauge, hard }
}

export function writeSessionConfig(dir, sessionId, patch, {
  writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  const path = sessionPath(dir, sessionId)
  mkdir(join(dir, 'tacos', 'sessions'), { recursive: true })
  writeFile(path, JSON.stringify(patch, null, 2), { mode: 0o600 })
}

export function gcSessions(dir, {
  now, maxAgeMs = 7 * 24 * 3600 * 1000,
  readdir = readdirSync, stat = statSync, remove = unlinkSync,
}) {
  const base = join(dir, 'tacos', 'sessions')
  const removed = []
  let names = []
  try { names = readdir(base) } catch { return removed }
  for (const name of names) {
    try {
      if (now - stat(join(base, name)).mtimeMs > maxAgeMs) { remove(join(base, name)); removed.push(name) }
    } catch { /* ignore */ }
  }
  return removed
}
```

- [ ] **Step 4: Write `plugins/usage-guard/bin/budget.mjs`**

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { configDir, readConfig } = await load('config.mjs')
const { parseBudgetArgs, writeSessionConfig, gcSessions } = await load('session.mjs')
const { getGauges } = await load('usage.mjs')
const { decide } = await load('decide.mjs')
const { renderStatus } = await load('render.mjs')

const dir = configDir(process.env)
const sessionId = process.env.TACOS_SESSION_ID || process.argv[2]
const rest = process.argv.slice(3)

if (!sessionId) { console.log('usage-guard: no session id available; cannot scope a budget.'); process.exit(0) }
gcSessions(dir, { now: Date.now() })

if (rest.length === 0) {
  const cfg = readConfig({ dir, sessionId, readFile: readFileSync })
  const { gauges, blind, reason } = await getGauges({ dir, now: Date.now() })
  console.log(renderStatus({ gauges, thresholds: cfg.gauges, decision: blind ? null : decide(gauges, cfg.gauges), mode: cfg.mode, blind, reason }))
  process.exit(0)
}

const parsed = parseBudgetArgs(rest)
if (parsed.error) { console.log(`usage-guard: ${parsed.error}`); process.exit(0) }

const existing = readConfig({ dir, sessionId, readFile: readFileSync })
const patch = parsed.mode
  ? { mode: parsed.mode }
  : { gauges: { [parsed.gauge]: { soft: Math.max(1, parsed.hard - 15), hard: parsed.hard } } }
writeSessionConfig(dir, sessionId, patch)
console.log(parsed.mode
  ? `usage-guard: mode set to ${parsed.mode} for this chat.`
  : `usage-guard: ${parsed.gauge} ceiling set to ${parsed.hard}% for this chat (advisory at ${Math.max(1, parsed.hard - 15)}%). Previous mode: ${existing.mode}.`)
```

- [ ] **Step 5: Write `plugins/usage-guard/commands/budget.md`**

The `name` frontmatter is what registers the bare `/budget` alias alongside `/usage-guard:budget`.

```markdown
---
name: budget
description: Show or set this chat's usage budget against your account rate limits.
---

Run this command and show the user its raw output verbatim. Do not summarise it,
do not add commentary, and do not re-run it with different arguments.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/budget.mjs" "$CLAUDE_SESSION_ID" $ARGUMENTS`

Usage the user may not know:
- `/budget` - show current gauges, thresholds and what would happen right now
- `/budget 80` - set this chat's 5-hour ceiling to 80%
- `/budget weekly 70` - set this chat's weekly ceiling
- `/budget money 60` - set this chat's metered-spend ceiling
- `/budget off` / `/budget on` - disable or re-enable the guard for this chat
```

- [ ] **Step 6: Run the tests and verify the command end to end**

Run: `node scripts/release.mjs && npm test`
Then in a Claude Code session: `/usage-guard:budget` and `/usage-guard:budget 80`.
Expected: the first prints the status block; the second writes `~/.claude/tacos/sessions/<id>.json` and confirms.

- [ ] **Step 7: Commit**

```bash
git add packages/core/session.mjs packages/core/test/session.test.mjs plugins/usage-guard/bin/budget.mjs plugins/usage-guard/commands/budget.md
git commit -m "feat(usage-guard): budget command and per-session state

A plugin command expands to a prompt rather than executing directly, so the
command delegates to a small CLI that owns the write. Frontmatter name gives
both /usage-guard:budget and the bare /budget alias."
```

---

### Task 11: Enable enforcement

Everything needed to deny already exists and is tested. This task flips the default and proves the deny path end to end.

**Files:**
- Modify: `packages/core/config.mjs` (`DEFAULTS.mode`)
- Modify: `packages/core/test/config.test.mjs`
- Test: `packages/core/test/guard.enforce.test.mjs`

**Interfaces:**
- Consumes: `decideForHook` (guard)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideForHook } from '../../../plugins/usage-guard/hooks/guard.mjs'
import { DEFAULTS } from '../config.mjs'

const cfg = { gauges: DEFAULTS.gauges, mode: 'enforce' }
const at = (p) => ({ five_hour: { percent: p, resetsAt: 'R' }, seven_day: null, extra_usage: null, scoped: [] })

test('the shipped default is enforce', () => {
  assert.equal(DEFAULTS.mode, 'enforce')
})

test('at the ceiling every tool is denied, not just fan-out', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cfg, gauges: at(95), blind: false })
  assert.equal(r.action, 'deny')
  assert.match(r.text, /ceiling/i)
})

test('between soft and hard, ordinary tools still run', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'allow')
})

test('between soft and hard, fan-out is denied', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Agent' }, cfg, gauges: at(80), blind: false })
  assert.equal(r.action, 'deny')
})

test('a blind guard never denies even in enforce mode', () => {
  const r = decideForHook({ input: { hook_event_name: 'PreToolUse', tool_name: 'Agent' }, cfg, gauges: null, blind: true })
  assert.equal(r.action, 'allow')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/guard.enforce.test.mjs`
Expected: FAIL on `DEFAULTS.mode` — it is still `dry-run`.

- [ ] **Step 3: Flip the default**

In `packages/core/config.mjs` set `mode: 'enforce'`, and update `packages/core/test/config.test.mjs` back to expect `'enforce'`.

- [ ] **Step 4: Run the tests to verify they pass**

`config.mjs` is a vendored module, so re-vendor before running the suite.

Run: `node scripts/release.mjs && npm test`
Expected: all tests pass.

- [ ] **Step 5: Prove the deny path against a real session**

Set a deliberately low ceiling so the guard must fire without burning a real window:

```bash
node scripts/release.mjs
```

Then in a Claude Code session run `/usage-guard:budget 1` and ask for something that spawns a subagent. Expected: the `Agent` call is denied with the readable reason. Restore with `/usage-guard:budget off`, then `/usage-guard:budget 90`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/config.mjs packages/core/test/config.test.mjs packages/core/test/guard.enforce.test.mjs
git commit -m "feat(usage-guard): enable enforcement by default

Ceiling denies every tool; the soft band denies only new fan-out so work
already underway can finish. A blind guard still never denies."
```

---

### Task 12: README and release checks

**Files:**
- Create: `README.md`
- Create: `plugins/usage-guard/README.md`
- Test: `packages/core/test/docs.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('the root readme documents installation via the marketplace', () => {
  const r = read('README.md')
  assert.match(r, /plugin marketplace add/)
  assert.match(r, /tacodx\/TacosPlugins/)
})

test('the plugin readme states the undocumented-endpoint caveat', () => {
  const r = read('plugins/usage-guard/README.md')
  assert.match(r, /undocumented/i)
  assert.match(r, /fails? open/i)
})

test('no readme promises macos keychain support', () => {
  const r = read('plugins/usage-guard/README.md')
  assert.doesNotMatch(r, /keychain support/i)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/docs.test.mjs`
Expected: FAIL — `ENOENT` on `README.md`.

- [ ] **Step 3: Write the READMEs**

`README.md` covers: what TacosPlugins is, `claude plugin marketplace add tacodx/TacosPlugins`, the plugin list, how to run tests, and the vendoring rule (edit `packages/core`, never `plugins/*/lib`).

`plugins/usage-guard/README.md` covers: what it does, the four gauges, `/budget` usage, the config file and its defaults, `dry-run` first, `explain`, and a **Limitations** section stating plainly that the usage endpoint is undocumented and may break, that the guard always fails open, that a workflow already running when the ceiling is crossed will finish, and that macOS credential storage is unverified.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/release.mjs && npm test && node plugins/usage-guard/bin/explain.mjs`
Expected: all tests pass and `explain` prints real numbers.

- [ ] **Step 5: Commit and push**

```bash
git add README.md plugins/usage-guard/README.md packages/core/test/docs.test.mjs
git commit -m "docs: readmes with limitations stated plainly"
gh repo create TacosPlugins --public --source=. --remote=origin --push
```
