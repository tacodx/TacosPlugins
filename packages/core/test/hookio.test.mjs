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

test('run exits 0 and emits nothing when main resolves to a value JSON.stringify cannot serialise', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => ({ bad: 1n })) // BigInt is not JSON-serialisable
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  assert.equal(out.trim(), '', 'an unserialisable decision object must still allow, never crash')
})

test('run exits 0 via the deadline when something else would otherwise hang the process forever', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => {
      setInterval(() => {}, 1000) // a lingering handle that would otherwise keep the process alive forever
      return new Promise(() => {}) // main itself never resolves
    }, 300) // short injected deadline so the suite does not sit for 4.5s
  `)
  const start = Date.now()
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8', timeout: 4000 })
  const elapsed = Date.now() - start
  assert.equal(out.trim(), '')
  assert.ok(elapsed < 2000, `expected the 300ms deadline to force an exit well under 2s, took ${elapsed}ms`)
})

test('the deadline does not itself keep the process alive when nothing else is pending', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => new Promise(() => {}), 5000) // a long deadline that a correctly-unref'd timer should never need to reach
  `)
  const start = Date.now()
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8', timeout: 2000 })
  const elapsed = Date.now() - start
  assert.equal(out.trim(), '')
  assert.ok(elapsed < 1000, `expected the unref'd deadline to let the process exit fast rather than wait out the full 5s, took ${elapsed}ms`)
})

test('run prints a deny decision exactly, round-tripping through JSON', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run, denyOutput } from '${join(CORE, 'hookio.mjs')}'
    run(async () => denyOutput('PreToolUse', 'ceiling hit'))
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  const parsed = JSON.parse(out)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'ceiling hit')
})

test('run prints a context decision exactly, round-tripping through JSON', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run, contextOutput } from '${join(CORE, 'hookio.mjs')}'
    run(async () => contextOutput('UserPromptSubmit', 'at 76%'))
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  const parsed = JSON.parse(out)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'at 76%')
})

test('run exits 0 and emits nothing when something throws outside the promise chain', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => {
      setImmediate(() => { throw new Error('boom outside the chain') })
      return new Promise(() => {}) // keep the chain's own .then/.catch from resolving first
    })
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  assert.equal(out.trim(), '', 'an uncaughtException outside the chain must still allow')
})

test('run exits 0 and emits nothing when a detached promise rejects outside the chain', () => {
  const d = mkdtempSync(join(tmpdir(), 'hookio-'))
  const script = join(d, 's.mjs')
  writeFileSync(script, `
    import { run } from '${join(CORE, 'hookio.mjs')}'
    run(async () => {
      Promise.reject(new Error('detached rejection')) // never awaited, never returned
      return new Promise(() => {}) // keep the chain's own .then/.catch from resolving first
    })
  `)
  const out = execFileSync('node', [script], { input: '{}', encoding: 'utf8' })
  assert.equal(out.trim(), '', 'an unhandledRejection outside the chain must still allow')
})
