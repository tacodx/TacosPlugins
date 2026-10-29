import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nightFiles, nightPaths } from '../engine/config.mjs'
import { readJson, readJsonl, writeJson } from '../engine/fsx.mjs'
import { ensureWorktree } from '../engine/git.mjs'
import { addPlan, emptyQueue, readQueue } from '../engine/queue.mjs'
import { writeCurrent } from '../engine/state.mjs'
import { commitLeftovers, runClaude, workerTurn } from '../engine/worker.mjs'
import { tempDir } from './helpers.mjs'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fakes', 'claude.mjs')
const DATE = '2026-03-10'
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
}

function setup(t, { mode = 'done', items = 1, extraEnv = {} } = {}) {
  const home = tempDir(t)
  const repo = join(home, 'Projects', 'alpha')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT_ENV } })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'alpha\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('checkout', '-q', '-b', 'feature')
  const env = { ...process.env, ...GIT_ENV, HOME: home, XDG_RUNTIME_DIR: join(home, 'run'), FAKE_MODE: mode, FAKE_LOG: join(home, 'fake.log'), ...extraEnv }
  const paths = nightPaths({ env, home })
  writeCurrent(paths, { phase: 'night', date: DATE })
  writeJson(paths.config, { sessions: 2 })
  let queue = emptyQueue(DATE)
  queue = addPlan(queue, { name: 'alpha', repo, base: 'feature', rank: 0 }, {
    map: { basis: 'b', tasks: [{ id: 't1', title: 'One', done: false }, { id: 't2', title: 'Two', done: false }] },
    items: Array.from({ length: items }, (_, i) => ({ title: `Item ${i + 1}`, why: 'w', doneWhen: 'd', task: `t${i + 1}` })),
  }, 0).queue
  writeJson(nightFiles(paths, DATE).queue, queue)
  let clock = Date.parse('2026-03-10T23:00:00Z')
  let n = 0
  const deps = {
    now: () => clock,
    uuid: () => `00000000-0000-4000-8000-00000000000${++n}`,
    env,
    claude: FAKE,
    node: process.execPath,
    guard: '/x/guard.mjs',
    ensureWorktree,
    runClaude: (options) => runClaude({ ...options, intervalMs: 100 }),
  }
  const calls = () => readJsonl(join(home, 'fake.log'))
  return { home, repo, paths, files: nightFiles(paths, DATE), deps, calls, tick: (ms) => { clock += ms } }
}

test('a worker takes an item, works in a night worktree, and the item ends done with its task ticked', async (t) => {
  const s = setup(t)
  const turn = await workerTurn(1, { paths: s.paths, deps: s.deps })
  assert.equal(turn.state, 'done')
  const q = readQueue(s.paths, DATE)
  assert.equal(q.items[0].status, 'done')
  assert.match(q.items[0].result, /wrote work.txt/)
  assert.equal(q.maps.alpha.now[0].done, true)
  const call = s.calls()[0]
  assert.match(call.cwd, /\.local\/share\/night\/worktrees\/2026-03-10\/alpha$/)
  assert.equal(call.env.NIGHT_WORKER, '1')
  assert.equal(call.env.GIT_CONFIG_COUNT, '7')
  assert.ok(call.args.includes('--session-id'))
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], 'project,local')
  const branch = execFileSync('git', ['log', '-1', '--format=%s', 'night/2026-03-10/alpha'], { cwd: s.repo, encoding: 'utf8' })
  assert.equal(branch.trim(), 'night work')
  assert.ok(readJsonl(s.files.events).some((e) => e.kind === 'worker.result' && e.outcome === 'done'))
})

test('the next item of the same project resumes the same Claude session', async (t) => {
  const s = setup(t, { items: 2 })
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  const [first, second] = s.calls()
  const id = first.args[first.args.indexOf('--session-id') + 1]
  assert.equal(second.args[second.args.indexOf('--resume') + 1], id)
})

test('a usage limit makes the worker wait until a minute after the reset, then resume the same item', async (t) => {
  const resetsAt = Date.parse('2026-03-11T01:00:00Z') / 1000
  const s = setup(t, { mode: 'limit', extraEnv: { FAKE_RESETS_AT: String(resetsAt) } })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'limited')
  const ws = readJson(join(s.files.workers, '1.json'))
  assert.equal(ws.limitedUntil, resetsAt * 1000 + 60_000)
  assert.equal(readQueue(s.paths, DATE).items[0].status, 'taken')
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'limited')
  s.tick(3 * 3600_000)
  s.deps.env.FAKE_MODE = 'done'
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'done')
  const last = s.calls().at(-1)
  assert.ok(last.args.includes('--resume'))
  assert.match(last.args[1], /usage limit/)
})

test('a crash counts an attempt and the same session is resumed; the third crash fails the item', async (t) => {
  const s = setup(t, { mode: 'crash' })
  for (let i = 0; i < 3; i++) assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'retry')
  const item = readQueue(s.paths, DATE).items[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 3)
  assert.ok(s.calls()[1].args.includes('--resume'))
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'waiting for work')
})

test('a login error stops this worker and tells every other worker to wait', async (t) => {
  const s = setup(t, { mode: 'login' })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'login')
  assert.equal(readJson(s.files.usage).loginError, true)
  assert.equal((await workerTurn(2, { paths: s.paths, deps: s.deps })).state, 'login')
})

test('a paused slot ends its Claude run, commits what it left and gives the item back', async (t) => {
  const s = setup(t, { mode: 'hang' })
  setTimeout(() => writeJson(join(s.files.dir, 'paused.json'), { slots: [1] }), 300)
  const turn = await workerTurn(1, { paths: s.paths, deps: s.deps })
  assert.equal(turn.state, 'paused')
  assert.equal(readQueue(s.paths, DATE).items[0].status, 'open')
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'paused')
})

test('nothing runs outside a night, above the session count, or under a health blocker', async (t) => {
  const s = setup(t)
  assert.equal((await workerTurn(3, { paths: s.paths, deps: s.deps })).state, 'off')
  writeJson(s.files.health, { verdict: { blockers: [{ code: 'swap-full' }] } })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'blocked')
  writeCurrent(s.paths, { phase: 'stopped', date: DATE })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'off')
  assert.equal(s.calls().length, 0)
})

test('a project a busy desktop session holds is left alone', async (t) => {
  const s = setup(t)
  writeJson(s.files.sessions, { sessions: [{ kind: 'desktop', project: 'alpha', label: 'working' }] })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'waiting for work')
  writeJson(s.files.sessions, { sessions: [{ kind: 'desktop', project: 'alpha', label: 'idle' }] })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'done')
})

test('the worker settings carry the sandbox, the fail-closed guard and no attribution', async (t) => {
  const s = setup(t)
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  const settings = JSON.parse(readFileSync(join(s.files.dir, 'worker-settings.json'), 'utf8'))
  assert.equal(settings.sandbox.enabled, true)
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false)
  assert.equal(settings.includeCoAuthoredBy, false)
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /\|\| exit 2$/)
})

test('after a failed canary no worker starts any Claude run', async (t) => {
  const s = setup(t)
  writeCurrent(s.paths, { phase: 'night', date: DATE, unsafe: ['the guard hook did not deny a git push'] })
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'unsafe')
  assert.equal(s.calls().length, 0)
})

test('when memory is tight only the first worker runs', async (t) => {
  const s = setup(t)
  writeJson(s.files.health, { verdict: { blockers: [], tight: true } })
  assert.equal((await workerTurn(2, { paths: s.paths, deps: s.deps })).state, 'tight on memory')
  assert.equal((await workerTurn(1, { paths: s.paths, deps: s.deps })).state, 'done')
})

test('a Claude killed on the first item of a new project resumes that session, whatever the last project counted', async (t) => {
  const s = setup(t, { mode: 'crash' })
  writeJson(join(s.files.workers, '1.json'), { slot: 1, sessionId: 'old-session', sessionProject: 'other', sessionStarted: true, itemsInSession: 6 })
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  s.deps.env.FAKE_MODE = 'done'
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  const [first, second] = s.calls()
  const id = first.args[first.args.indexOf('--session-id') + 1]
  assert.notEqual(id, 'old-session')
  assert.equal(second.args[second.args.indexOf('--resume') + 1], id)
  assert.match(second.args[1], /Continue the item/)
})

test('a run that dies before Claude names its session is not resumed: the next run starts a session of its own', async (t) => {
  const s = setup(t, { mode: 'crash-silent' })
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  s.deps.env.FAKE_MODE = 'done'
  await workerTurn(1, { paths: s.paths, deps: s.deps })
  const [, second] = s.calls()
  assert.ok(second.args.includes('--session-id'))
  assert.ok(!second.args.includes('--resume'))
})

test('leftovers at a stop are committed without the empty mount points the sandbox leaves', (t) => {
  const s = setup(t)
  const wt = join(s.home, 'wt')
  ensureWorktree(s.repo, wt, 'night/x/alpha', 'feature')
  for (const f of ['.bashrc', '.gitconfig']) writeFileSync(join(wt, f), '')
  mkdirSync(join(wt, '.claude'), { recursive: true })
  writeFileSync(join(wt, '.claude', 'settings.json'), '')
  writeFileSync(join(wt, 'empty-but-mine.txt'), '')
  writeFileSync(join(wt, 'notes.md'), 'real work\n')
  writeFileSync(join(wt, 'README.md'), 'alpha, changed\n')
  const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  const env = process.env
  Object.assign(process.env, GIT_ENV)
  t.after(() => { for (const k of Object.keys(GIT_ENV)) delete env[k] })
  assert.equal(commitLeftovers(wt, 'stop'), true)
  const files = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()
  assert.deepEqual(files, ['README.md', 'notes.md'])
})

test('the worker\'s git ignores the placeholders on top of the owner\'s own ignore file', async () => {
  const { excludesText } = await import('../engine/claude.mjs')
  const text = excludesText('node_modules/\n.DS_Store\n')
  assert.match(text, /^node_modules\/\n\.DS_Store\n# night/)
  assert.match(text, /^\/\.claude\/settings\.json$/m)
  assert.match(text, /^\/\.bashrc$/m)
})
