import { test } from 'node:test'
import assert from 'node:assert/strict'

import { backoffMs, itemPrompt, parseResultLine, readRun, workerArgs, workerEnv } from '../engine/claude.mjs'

test('the result line is read from the last NIGHT-RESULT in the text', () => {
  assert.deepEqual(parseResultLine('x\nNIGHT-RESULT: partial · half\nmore\nNIGHT-RESULT: done · all of it'), { outcome: 'done', line: 'all of it' })
  assert.deepEqual(parseResultLine('NIGHT-RESULT: needs-owner: which domain?'), { outcome: 'needs-owner', line: 'which domain?' })
  assert.equal(parseResultLine('no line here'), null)
})

const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', ...extra })

test('a run is read as a result, a limit, a login error, a passing API error or a crash', () => {
  assert.equal(readRun([result('NIGHT-RESULT: done · ok')]).stop, 'result')
  assert.equal(readRun([{ type: 'assistant', error: 'rate_limit', apiErrorParams: { rate_limit_info: { resetsAt: 100 } } }]).limit.resetsAt, 100_000)
  assert.equal(readRun([result("You've hit your weekly limit", { is_error: true })]).stop, 'limit')
  assert.equal(readRun([result('Invalid API key · Please run /login', { is_error: true })]).stop, 'login')
  assert.equal(readRun([result('API Error: 529 overloaded', { is_error: true })]).stop, 'transient')
  assert.equal(readRun([], { exitCode: 1 }).stop, 'crash')
  assert.equal(readRun([], { signal: 'SIGKILL' }).stop, 'killed')
  assert.equal(readRun([result('x')]).sessionId, 's1')
})

test('the worker environment blocks pushes in git, drops the display and points TMPDIR at scratch', () => {
  const env = workerEnv({ DISPLAY: ':0', WAYLAND_DISPLAY: 'w', GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_8: 'x', PATH: '/bin' }, {
    slot: 2, worktree: '/w', scratch: '/s', protectedBranches: ['main'], testLock: '/l', events: '/e', decisions: '/d',
  })
  assert.equal(env.DISPLAY, undefined)
  assert.equal(env.WAYLAND_DISPLAY, undefined)
  assert.equal(env.GIT_CONFIG_KEY_8, undefined)
  assert.equal(env.GIT_CONFIG_COUNT, '6')
  assert.equal(env.GIT_CONFIG_KEY_5, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_5, '')
  assert.equal(env.GIT_SSH_COMMAND, 'false')
  assert.equal(env.GIT_CONFIG_KEY_0, 'url.night-blocked:.pushInsteadOf')
  assert.equal(env.GIT_CONFIG_VALUE_2, 'git@')
  assert.equal(env.GH_TOKEN, 'night-blocked')
  assert.equal(env.TMPDIR, '/s/tmp')
  assert.equal(env.NIGHT_WORKER, '1')
  assert.equal(env.PATH, '/bin')
})

test('worker argv: isolated settings, no MCP, the rules, a session id or a resume', () => {
  const fresh = workerArgs({ prompt: 'P', sessionId: 'u1', resume: false, settingsPath: '/s.json', addDirs: ['/x'], name: 'Night 1 · a' })
  assert.equal(fresh[fresh.indexOf('--session-id') + 1], 'u1')
  assert.equal(fresh[fresh.indexOf('--add-dir') + 1], '/x')
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(fresh.includes(flag))
  assert.match(fresh[fresh.indexOf('--append-system-prompt') + 1], /NIGHT-RESULT/)
  const again = workerArgs({ prompt: 'P', sessionId: 'u1', resume: true, settingsPath: '/s.json', model: 'opus' })
  assert.equal(again[again.indexOf('--resume') + 1], 'u1')
  assert.equal(again.at(-1), 'opus')
})

test('an item prompt names the branch, the why and the done-when; a continuation says why it stopped', () => {
  const item = { title: 'Add tests', why: 'Plan step 2', doneWhen: 'tests pass', base: 'feature' }
  assert.match(itemPrompt(item, { branch: 'night/x/a' }), /night\/x\/a, cut from feature[\s\S]*Done when: tests pass/)
  assert.match(itemPrompt(item, { continuing: 'a usage limit' }), /interrupted \(a usage limit\)/)
})

test('back-off grows from one to fifteen minutes and stays there', () => {
  assert.deepEqual([0, 1, 2, 7].map(backoffMs), [60_000, 300_000, 900_000, 900_000])
})

test('a successful result that mentions a usage limit is still a result', () => {
  const run = readRun([result('Done. NIGHT-RESULT: done · noted that the usage limit page needs copy')])
  assert.equal(run.stop, 'result')
  assert.equal(run.parsed.outcome, 'done')
})

test('the worker settings outrank a project\'s own: hooks stay on and the push block rides along', async () => {
  const { workerSettings } = await import('../engine/claude.mjs')
  const settings = workerSettings({ node: '/n', guard: '/g', env: { GIT_CONFIG_COUNT: '6', GIT_CONFIG_KEY_0: 'x', GH_TOKEN: 'night-blocked', HOME: '/h' } })
  assert.equal(settings.disableAllHooks, false)
  assert.deepEqual(Object.keys(settings.env).sort(), ['GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0'])
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 120)
})
