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

test('writeCache succeeds: entry written contains fetchedAt and data', () => {
  let writtenContent
  assert.doesNotThrow(() => writeCache('/c', { result: 42 }, {
    now: 5000,
    mkdir: () => {},
    writeFile: (path, content) => {
      writtenContent = JSON.parse(content)
    },
    rename: (tmp, final) => {
      assert.equal(writtenContent.fetchedAt, 5000)
      assert.deepEqual(writtenContent.data, { result: 42 })
      assert.equal(tmp, `/c.${process.pid}.tmp`)
      assert.equal(final, '/c')
    },
  }))
})

test('writeCache failed rename cleans up tmp file', () => {
  let removed = false
  assert.doesNotThrow(() => writeCache('/c', { a: 1 }, {
    now: 1,
    mkdir: () => {},
    writeFile: () => {},
    rename: () => { throw new Error('readonly') },
    remove: (path) => {
      assert.equal(path, `/c.${process.pid}.tmp`)
      removed = true
    },
  }))
  assert.equal(removed, true, 'tmp file must be cleaned up on rename failure')
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
