import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saveBudget } from '../../../plugins/usage-guard/bin/budget.mjs'

test('a write that fails to persist reports failure, says the budget is unchanged, and never prints the success line', () => {
  const logged = []
  let exitCode = null

  saveBudget('/d', 's1', { mode: 'enforce' }, 'usage-guard: mode set to enforce for this chat.', {
    writeSessionConfig: () => { throw new Error('disk full') },
    log: (line) => logged.push(line),
    exit: (code) => { exitCode = code },
  })

  assert.equal(exitCode, 0)
  assert.ok(logged.some((l) => /could not save this chat's budget — disk full/.test(l)))
  assert.ok(logged.some((l) => /your budget is unchanged/i.test(l)))
  assert.ok(!logged.some((l) => /mode set to enforce/.test(l)),
    'a failed save must never print the success message')
})

test('a successful write prints only the success line and never exits early', () => {
  const logged = []
  let exitCode = null
  const saved = []

  saveBudget('/d', 's1', { mode: 'enforce' }, 'usage-guard: mode set to enforce for this chat.', {
    writeSessionConfig: (dir, sessionId, patch) => { saved.push({ dir, sessionId, patch }) },
    log: (line) => logged.push(line),
    exit: (code) => { exitCode = code },
  })

  assert.equal(exitCode, null)
  assert.deepEqual(logged, ['usage-guard: mode set to enforce for this chat.'])
  assert.deepEqual(saved, [{ dir: '/d', sessionId: 's1', patch: { mode: 'enforce' } }])
})
