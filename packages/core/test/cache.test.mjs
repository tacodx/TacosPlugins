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

test('writeCache writes fetchedAt and data, then renames tmp over path', () => {
  let wrote = null
  let renamed = null
  writeCache('/c/usage.json', { five_hour: { percent: 5 } }, {
    now: 1234,
    mkdir: () => {},
    writeFile: (p, body) => { wrote = { p, body } },
    rename: (from, to) => { renamed = { from, to } },
    remove: () => {},
  })
  // Assert AFTER the call returns. An assertion thrown inside an injected mock
  // would be swallowed by writeCache's own fail-open catch, making this vacuous.
  assert.ok(wrote, 'writeFile must be called')
  const entry = JSON.parse(wrote.body)
  assert.equal(entry.fetchedAt, 1234)
  assert.deepEqual(entry.data, { five_hour: { percent: 5 } })
  assert.ok(renamed, 'rename must be called')
  assert.equal(renamed.from, wrote.p, 'rename must move the tmp file that was written')
  assert.equal(renamed.to, '/c/usage.json')
})

test('writeCache cleans up tmp on rename failure', () => {
  let removed = null
  let writtenTmp = null
  writeCache('/c', { a: 1 }, {
    now: 1,
    mkdir: () => {},
    writeFile: (p) => { writtenTmp = p },
    rename: () => { throw new Error('readonly') },
    remove: (path) => { removed = path },
  })
  // Assert AFTER the call returns. An assertion inside the remove mock would be
  // swallowed by writeCache's own fail-open catch.
  assert.equal(removed, writtenTmp, 'the exact tmp file that was written must be the one cleaned up')
})

test('writeCache uses a freshly-named tmp file (uuid + wx), same hardening as auth.mjs and session.mjs', () => {
  let writeArgs, renameArgs
  writeCache('/c/usage.json', { a: 1 }, {
    now: 1,
    mkdir: () => {},
    writeFile: (p, _b, opts) => { writeArgs = { path: p, opts } },
    rename: (from, to) => { renameArgs = { from, to } },
    uuid: () => 'FIXED',
  })
  assert.equal(writeArgs.path, '/c/usage.json.' + process.pid + '.FIXED.tmp')
  assert.equal(writeArgs.opts.mode, 0o600)
  assert.equal(writeArgs.opts.flag, 'wx', 'wx guarantees mode is applied on every write, never reusing a stale tmp file')
  assert.equal(renameArgs.from, writeArgs.path)
  assert.equal(renameArgs.to, '/c/usage.json')
})

test('uncontended lock acquire calls removeLock after fn resolves', async () => {
  let removed = false
  const fs = {
    writeLock: () => {},
    removeLock: () => { removed = true },
  }
  let fnRan = false
  await withLock('/l', async () => { fnRan = true }, { now: 1000, staleMs: 5000, fs })
  assert.equal(fnRan, true)
  assert.equal(removed, true)
})

test('lock cleanup happens even if fn throws', async () => {
  let removed = false
  const fs = {
    writeLock: () => {},
    removeLock: () => { removed = true },
  }
  const fnError = new Error('fn failed')
  let caught
  try {
    await withLock('/l', async () => { throw fnError }, { now: 1000, staleMs: 5000, fs })
  } catch (e) {
    caught = e
  }
  assert.equal(caught, fnError, 'error must propagate out of withLock')
  assert.equal(removed, true, 'removeLock must be called even when fn throws')
})

test('readCache rejects valid json that is an array', () => {
  const r = readCache('/c', { now: 1000, ttlMs: 60000, maxStaleMs: 900000, readFile: () => JSON.stringify([1, 2, 3]) })
  assert.equal(r, null)
})

test('readCache rejects valid json object missing required fields', () => {
  const r = readCache('/c', { now: 1000, ttlMs: 60000, maxStaleMs: 900000, readFile: () => JSON.stringify({ foo: 1 }) })
  assert.equal(r, null)
})
