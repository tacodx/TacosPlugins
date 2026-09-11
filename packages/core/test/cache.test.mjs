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
