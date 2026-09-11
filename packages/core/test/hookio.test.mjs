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
