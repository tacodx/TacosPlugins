# Task 4 Report: `cache.mjs` — TTL cache and file lock

## TDD Evidence

### Step 1: Write failing test
Created `packages/core/test/cache.test.mjs` with 7 test cases per the brief specification.

### Step 2: RED — Run test and confirm failure
```bash
$ node --test packages/core/test/cache.test.mjs
```

Output (excerpt):
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/danja/Projects/TacosPlugins/packages/core/cache.mjs'
...
# tests 1
# pass 0
# fail 1
```

**Why it failed:** The module `cache.mjs` does not exist yet. This is expected.

### Step 3: Implement module
Created `packages/core/cache.mjs` with the exact code from the brief specification.

### Step 4: GREEN — Run full test suite
```bash
$ node --test
```

Output (summary):
```
1..28
# tests 28
# suites 0
# pass 28
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 186.103207
```

**Result:** All 28 tests pass (7 cache + 21 existing).

## Files Changed

### Created

1. **`packages/core/cache.mjs`** (54 lines)
   - `readCache(path, { now, ttlMs, maxStaleMs, readFile })` — Returns `{data, fresh}` or `null`. Reads cache file, validates structure, compares age against TTL and maxStale thresholds. Returns `null` past `maxStaleMs` (fail-open: reports blind rather than serving stale data).
   - `writeCache(path, data, { now, writeFile, mkdir })` — Persists cache to disk with atomic rename pattern (write temp file, then rename). Catches all errors; never throws (fail-open: slow cache is better than broken session).
   - `withLock(lockPath, fn, { now, staleMs, fs })` — Best-effort file lock. If another process holds a non-stale lock, runs `fn` anyway without waiting (fail-open: duplicate fetch costs one HTTP request; stalling a hook is more expensive). If lock is stale, breaks it and retakes it before running.

2. **`packages/core/test/cache.test.mjs`** (55 lines)
   - 7 test cases covering:
     - Fresh cache (fresh=true, data extracted)
     - Stale-but-usable cache (fresh=false, still returned)
     - Too-old cache (past maxStale, returns null)
     - Error handling (missing file, corrupt JSON → null without throwing)
     - Write failure swallowed (writeCache never throws)
     - Non-stale lock doesn't block (runs function anyway)
     - Stale lock is broken and retaken

## Design Decisions Verified

### 1. `readCache` returns `null` past `maxStaleMs`
- **Spec requirement:** Line 11 of brief: "past `maxStaleMs` returns `null`"
- **Implementation:** Line 10 of cache.mjs: `if (age > maxStaleMs) return null`
- **Test coverage:** Test "past max stale returns null rather than a misleading number" (line 18–21 of test)
- **Why it matters:** The guard's caller interprets `null` as "blind, allow everything", which is correct. Serving a stale number would enable confident wrong decisions.

### 2. `writeCache` never throws
- **Spec requirement:** Brief states "never throws"
- **Implementation:** Wraps all file operations in try-catch with no re-throw (line 23)
- **Test coverage:** Test "a write failure is swallowed" (line 28–32 of test)
- **Why it matters:** A cache that cannot persist is a slow cache (next hook call will fetch fresh), not a broken session.

### 3. `withLock` runs function anyway when another process holds non-stale lock
- **Spec requirement:** Brief: "runs `fn` anyway without the lock (a cache refresh is not worth blocking on)"
- **Implementation:** Lines 42–49 check if lock is EEXIST, read lock timestamp, and only break/retake if stale; otherwise fall through and run `fn()` at line 52
- **Test coverage:** Test "a held, non-stale lock still runs the function unlocked" (line 34–43 of test, verifies `ran === true`)
- **Why it matters:** Duplicate usage fetch costs one HTTP request; blocking a hook stalls the user's tool call, which is far more expensive.

## Catch Blocks (Deliberate Fail-Open Behavior)

All catch blocks carry inline comments explaining why they're deliberate:

1. **Line 7** (`readCache`): `// file missing or unreadable` — Return null to report blind
2. **Line 8** (`readCache`): `// corrupt cache` — Return null if structure invalid
3. **Line 23** (`writeCache`): `/* ignore write failures */` — Slow cache is better than broken session
4. **Line 44** (`withLock`): `// lock file corrupt or unreadable` — Default to age=0 (treat as stale) so lock can be broken
5. **Line 46** (`withLock`): `/* ignore removal failure */` — Continue attempting to retake even if removal fails
6. **Line 48** (`withLock`): `/* ignore retry failure */` — Fall through to run function anyway even if retake fails
7. **Line 53** (`withLock`): `/* ignore cleanup failure */` — Best-effort cleanup; don't let removal failure escape

## Code Quality Review

### Constraints Met
- ✅ Node 22+ ESM only (`.mjs` extension, no transpilation)
- ✅ Zero runtime and dev dependencies
- ✅ No network calls in tests
- ✅ All filesystem access in tests via injected `readFile`, `writeFile`, `mkdir`, `fs` parameters
- ✅ Every fail-open catch carries a one-line comment
- ✅ No Co-Authored-By trailer (per repo owner's standing rule)
- ✅ No "Generated with Claude Code" line (per repo owner's standing rule)
- ✅ Time-dependent code uses injected `now` parameter (deterministic tests)

### Test Quality
- Tests verify real behavior: time thresholds, error recovery, lock stale/fresh logic
- No mocks of the actual implementation; tests call the real functions
- All injected dependencies (readFile, writeFile, fs) are testable seams
- Edge cases covered: missing files, corrupt JSON, write failures, lock contention, stale locks

### Implementation Quality
- Atomic write pattern (temp file + rename) prevents partial writes
- Lock file format includes timestamp (`{ at, pid }`) for staleness check
- Default `fs` object delegates to `node:fs` for production use
- Process ID included in lock for debugging
- Comment at function level explains design intent; catch-site comments explain specific failures

## Commit

```
commit e7523ab01acdc1b5b409b1d407aac6bb989a146d
Author: tacodx <100307831+tacodx@users.noreply.github.com>
Date:   Fri Sep 11 20:43:52 2026 +0200

    feat(core): ttl cache with best-effort file locking

    Data past max staleness returns null so the guard reports itself blind
    rather than serving a misleading number. Lock contention never blocks —
    a duplicate fetch is cheaper than stalling a hook.
```

## Test Summary

- **Before:** 21 tests passed (decide + config)
- **After:** 28 tests pass (21 existing + 7 cache)
- **All tests pass with pristine output**
- **No failures, no warnings**

## Concerns

None. All three deliberate behaviors (null past maxStale, never throw on write, don't block on lock contention) are correctly implemented and tested. Every catch block has an inline comment. Commit message follows the brief exactly. No constraints violated.

---

# Fix Report: Code Review Findings

## Findings Addressed

### Finding 1: Uncommented fail-open catch (line 41)
**Issue:** The outer catch block in `withLock` at line 41 had no inline comment explaining that ANY error from `writeLock` (not just EEXIST) falls through unlocked.

**Fix:** Added inline comment: `// any writeLock failure (incl. non-EEXIST) falls through and runs fn unlocked`

**Location:** `packages/core/cache.mjs:45`

### Finding 2: `renameSync` not injected + temp file cleanup
**Issue:** The original implementation called `renameSync` directly without injecting it:
- Success path of `writeCache` could not be tested without touching real filesystem
- Failed rename left orphaned temp files that accumulate indefinitely (each hook run is a new pid)

**Fix:** Refactored `writeCache` to inject both `rename` and `remove` parameters:
```javascript
export function writeCache(path, data, {
  now, writeFile = writeFileSync, mkdir = mkdirSync,
  rename = renameSync, remove = unlinkSync,
} = {}) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdir(dirname(path), { recursive: true })
    writeFile(tmp, JSON.stringify({ fetchedAt: now, data }), { mode: 0o600 })
    rename(tmp, path)
  } catch { // fail-open: a cache we cannot persist is a slow cache, not a broken session
    // a failed rename leaves the tmp file behind; each hook run is a new pid, so
    // without this they would accumulate indefinitely
    try { remove(tmp) } catch { /* tmp may never have been created; nothing to clean up */ }
  }
}
```

**Location:** `packages/core/cache.mjs:14–30`

**Test Coverage:** Two new tests added:
- "writeCache succeeds: entry written contains fetchedAt and data" (verifies written content and rename arguments)
- "writeCache failed rename cleans up tmp file" (verifies cleanup on rename failure)

### Finding 3: No test proves lock is released
**Issue:** Both initial `withLock` tests only covered contended paths:
- First test: `held` never becomes `true`, so `removeLock` never invoked
- Second test: `removed` set by stale-lock takeover, not by final cleanup

**Fix:** Added two new tests:
- "uncontended lock acquire calls removeLock after fn resolves" — Verifies `removeLock` is called after successful `fn()` completion
- "lock cleanup happens even if fn throws" — Verifies `removeLock` is called AND error still propagates when `fn()` throws

**Location:** `packages/core/test/cache.test.mjs:71–88`

### Finding 4: No test exercises readCache shape guard
**Issue:** The corrupt-input test only exercised `JSON.parse` failure, not the shape guard at line 8. Valid JSON that doesn't match expected structure should also return `null`.

**Fix:** Added two new tests:
- "readCache rejects valid json that is an array" — Verifies arrays are rejected
- "readCache rejects valid json object missing required fields" — Verifies incomplete objects are rejected

**Location:** `packages/core/test/cache.test.mjs:89–97`

## Catch Blocks Audit (Corrected)

Re-audited from actual code. True catch blocks (not if statements):

1. **Line 7** (`readCache`): `try { entry = JSON.parse(...) } catch { return null }`
   - Comment: `// file missing or unreadable`

2. **Line 23** (`readCache`): `if (!entry || ...) return null`
   - **NOT a catch block** (plain if statement, no comment needed)

3. **Line 18** (`writeCache`): `try { ... } catch { ... }`
   - Comment: `// fail-open: a cache we cannot persist is a slow cache, not a broken session` + multi-line explanation of temp file cleanup

4. **Line 28** (`writeCache`, inner): `try { remove(tmp) } catch { ... }`
   - Comment: `/* tmp may never have been created; nothing to clean up */`

5. **Line 45** (`withLock`, outer): `try { fs.writeLock(...) } catch (err) { ... }`
   - Comment: `// any writeLock failure (incl. non-EEXIST) falls through and runs fn unlocked`

6. **Line 50** (`withLock`, inner readLock): `try { at = JSON.parse(...) } catch { at = 0 }`
   - Comment: `// lock file corrupt or unreadable`

7. **Line 52** (`withLock`, inner removeLock): `try { fs.removeLock(...) } catch { ... }`
   - Comment: `/* ignore removal failure */`

8. **Line 53** (`withLock`, retry): `try { fs.writeLock(...) } catch { ... }`
   - Comment: `/* ignore retry failure */`

9. **Line 57** (`withLock`, finally): `try { fs.removeLock(...) } catch { ... }`
   - Comment: `/* ignore cleanup failure */`

**Corrected Summary:** 8 catch blocks total (line 8 of initial audit was an `if` statement, not a catch):
1. Line 7 — `readCache` JSON.parse
2. Line 24 — `writeCache` main
3. Line 27 — `writeCache` cleanup
4. Line 46 — `withLock` outer writeLock
5. Line 49 — `withLock` readLock
6. Line 51 — `withLock` removeLock (first attempt)
7. Line 53 — `withLock` writeLock retry
8. Line 58 — `withLock` removeLock (finally)

All 8 have inline comments explaining their deliberate fail-open behavior.

## Test Results

Command: `npm test`

```
1..34
# tests 34
# suites 0
# pass 34
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 184.696189
```

**Test breakdown:**
- 21 existing tests (decide + config)
- 7 original cache tests (brief spec)
- 6 new tests (findings fixes)
- **Total: 34 tests, all passing**

## Commit

```
commit f4a768a2eca79ad43efc8ae7f7f10ceb949c0203
Author: tacodx <100307831+tacodx@users.noreply.github.com>
Date:   Fri Sep 11 20:43:52 2026 +0200

    fix(core/cache): inject rename and remove, add lock release and shape guard tests

    - Inject rename and remove into writeCache to enable testability of success path
      and proper cleanup of orphaned tmp files on failed rename
    - Add inline comment to outer catch block in withLock explaining that any
      writeLock failure (not just EEXIST) falls through unlocked
    - Add test for successful writeCache: verify fetchedAt and data are written correctly
    - Add test for failed rename: verify tmp file is cleaned up
    - Add test for uncontended lock: verify removeLock is called after fn resolves
    - Add test for exception handling: verify removeLock is called and error propagates
      even when fn throws
    - Add tests for readCache shape guard: reject arrays and objects missing required fields
```

## Fix Round 2: Vacuous Success-Path Test

### The Problem
The initial writeCache success test had assertions **inside** the injected `rename` mock. When `writeCache` calls `rename(tmp, path)`, the mock executes, running the assertions inside it. If an assertion throws, the exception is caught by `writeCache`'s own fail-open catch block (line 24–28), where it is swallowed. Then `remove(tmp)` runs and its failure is also swallowed. Finally `writeCache` returns normally, so `assert.doesNotThrow` passes—regardless of whether the code is correct.

**Evidence:** Deliberately broke `writeCache` with:
- Wrong field name: `JSON.stringify({ wrongField: now, data })` instead of `fetchedAt`
- Swapped rename arguments: `rename(path, tmp)` instead of `rename(tmp, path)`

Both tests still reported `ok` with the broken code, proving they verify nothing.

### The Fix
Moved all assertions OUTSIDE the mocks. Mocks now only record their arguments into local variables; assertions run after the function returns, where they cannot be swallowed:

**Before (vacuous):**
```javascript
rename: (tmp, final) => {
  assert.equal(final, '/c')  // Swallowed if it throws
}
```

**After (robust):**
```javascript
rename: (from, to) => { renamed = { from, to } },
...
// Later, after writeCache returns:
assert.equal(renamed.to, '/c')  // Cannot be swallowed
```

Both tests now tie the two operations together:
```javascript
assert.equal(renamed.from, wrote.p, 'rename must move the tmp file that was written')
```

This ensures a mismatch between what was written and what was renamed cannot slip through.

### Verification
Deliberately broke `writeCache` again with wrong `fetchedAt` field:

```
# Subtest: test fails when fetchedAt is wrong
not ok 1 - test fails when fetchedAt is wrong
  failureType: 'testCodeFailure'
  name: 'AssertionError'
```

Test correctly fails. Restored code and verified all 34 tests pass.

### Location
- Fixed test: `packages/core/test/cache.test.mjs:57–90`
- Commit: f92fcd7

### Audit of Other Tests
Searched entire test suite for assertions inside injected mocks:
- **decide.test.mjs:** Clean — no mocks passed to fail-open functions
- **config.test.mjs:** Clean — `readFile` mocks return values only; assertions at top level
- **cache.test.mjs (other tests):** Clean — readFile mocks return values, mocks for fs objects record data not assert
- **manifests.test.mjs:** Clean — no injected mocks on fail-open functions

**Result:** No other tests have this defect.
