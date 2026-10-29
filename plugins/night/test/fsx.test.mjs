import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { appendJsonl, readJson, readJsonl, withLock, writeJson } from '../engine/fsx.mjs'
import { tempDir } from './helpers.mjs'

test('a missing or broken file reads as the fallback', (t) => {
  const dir = tempDir(t)
  assert.equal(readJson(join(dir, 'none.json'), 'fallback'), 'fallback')
  writeFileSync(join(dir, 'half.json'), '{"a": 1')
  assert.deepEqual(readJson(join(dir, 'half.json'), {}), {})
})

test('a write lands whole, private, and leaves no temporary file behind', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'deep', 'state.json')
  writeJson(path, { phase: 'night' })
  assert.deepEqual(readJson(path), { phase: 'night' })
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(join(dir, 'deep')), ['state.json'])
})

test('a line cut short by a kill is skipped, the others are read', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'events.jsonl')
  appendJsonl(path, { kind: 'one' })
  writeFileSync(path, '{"kind":"cut', { flag: 'a' })
  writeFileSync(path, '\n', { flag: 'a' })
  appendJsonl(path, { kind: 'two' })
  assert.deepEqual(readJsonl(path).map((e) => e.kind), ['one', 'two'])
})

test('two holders of one lock never overlap', async (t) => {
  const dir = tempDir(t)
  const lock = join(dir, 'queue.lock')
  let inside = 0
  let most = 0
  const hold = () => withLock(lock, async () => {
    inside++
    most = Math.max(most, inside)
    await new Promise((resolve) => setTimeout(resolve, 20))
    inside--
  })
  await Promise.all([hold(), hold(), hold(), hold()])
  assert.equal(most, 1)
})

test('a lock left by a dead process is taken over', async (t) => {
  const dir = tempDir(t)
  const lock = join(dir, 'queue.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 0 }))
  assert.equal(await withLock(lock, () => 'ran', { timeoutMs: 1000 }), 'ran')
})

test('a lock held by a live process makes the next holder wait, then give up', async (t) => {
  const dir = tempDir(t)
  const lock = join(dir, 'queue.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
  await assert.rejects(withLock(lock, () => 'ran', { timeoutMs: 200 }), /lock busy/)
})
