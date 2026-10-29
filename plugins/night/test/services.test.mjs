import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { nightFiles, nightPaths } from '../engine/config.mjs'
import { readJson, readJsonl, writeJson } from '../engine/fsx.mjs'
import { conductorTurn, medicTurn, usageTurn } from '../engine/services.mjs'
import { beat, writeCurrent } from '../engine/state.mjs'
import { tempDir } from './helpers.mjs'

const DATE = '2026-03-10'
const NOW = Date.parse('2026-03-10T23:30:00Z')

function setup(t) {
  const home = tempDir(t)
  const paths = nightPaths({ env: { HOME: home }, home })
  writeJson(paths.config, { sessions: 2 })
  const current = writeCurrent(paths, { phase: 'night', date: DATE, duskAt: NOW - 3600_000, start: NOW - 3600_000, end: NOW + 6 * 3600_000 })
  const calls = []
  let clock = NOW
  const m = {
    now: () => clock,
    systemctl: async (...args) => { calls.push(args); return { code: 0, stdout: '' } },
    run: async () => ({ code: 0, stdout: '' }),
    runSync: () => '',
    notify: async () => {},
  }
  return { home, paths, files: nightFiles(paths, DATE), current, calls, m, tick: (ms) => { clock += ms } }
}

test('the medic restarts a worker and a watcher whose beats are late, but not a paused worker, and not twice in five minutes', async (t) => {
  const s = setup(t)
  for (const name of ['conductor', 'health', 'logs', 'medic']) beat(s.files, name, {}, NOW)
  beat(s.files, 'worker-1', {}, NOW - 10 * 60_000)
  beat(s.files, 'worker-2', {}, NOW - 10 * 60_000)
  writeJson(join(s.files.dir, 'paused.json'), { slots: [2] })
  const turn = medicTurn(s.paths, s.m)
  await turn({ current: s.current, files: s.files })
  assert.deepEqual(s.calls, [['restart', 'night-worker@1.service'], ['restart', 'night-usage.service']])
  s.calls.length = 0
  s.tick(60_000)
  await turn({ current: s.current, files: s.files })
  assert.deepEqual(s.calls, [])
  assert.ok(readJsonl(s.files.events).some((e) => e.kind === 'worker.restart' && e.unit === 'night-worker@1.service'))
})

test('in the first three minutes after dusk the medic restarts nothing', async (t) => {
  const s = setup(t)
  const fresh = { ...s.current, duskAt: NOW - 60_000 }
  await medicTurn(s.paths, s.m)({ current: fresh, files: s.files })
  assert.deepEqual(s.calls, [])
})

test('the medic writes down every live session and a dialog once, and never touches the session', async (t) => {
  const s = setup(t)
  for (const name of ['conductor', 'health', 'logs', 'usage', 'worker-1', 'worker-2']) beat(s.files, name, {}, NOW)
  mkdirSync(s.paths.sessions, { recursive: true })
  writeFileSync(join(s.paths.sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 's1', cwd: s.home, name: 'Site build', status: 'waiting', waitingFor: 'permission prompt',
    statusUpdatedAt: 5, entrypoint: 'claude-desktop',
  }))
  const turn = medicTurn(s.paths, s.m)
  await turn({ current: s.current, files: s.files })
  await turn({ current: s.current, files: s.files })
  const sessions = readJson(s.files.sessions).sessions
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].label, 'waiting')
  assert.equal(sessions[0].on, 'permission prompt')
  assert.equal(readJsonl(s.files.events).filter((e) => e.kind === 'session.waiting').length, 1)
  assert.deepEqual(s.calls, [])
})

test('usage reads the shared gauges, and a login error clears once the credentials change', async (t) => {
  const s = setup(t)
  mkdirSync(join(s.paths.claude, 'tacos'), { recursive: true })
  writeJson(s.paths.usageCache, { fetchedAt: NOW, data: { five_hour: { percent: 42, resetsAt: 'x' }, seven_day: { percent: 51 } } })
  writeJson(s.files.usage, { loginError: true, at: Date.now() + 3600_000 }) // the error came after the last login
  writeFileSync(join(s.paths.claude, '.credentials.json'), '{}')
  await usageTurn(s.paths, s.m)({ files: s.files })
  let usage = readJson(s.files.usage)
  assert.equal(usage.fiveHour, 42)
  assert.equal(usage.sevenDay, 51)
  assert.equal(usage.loginError, true)
  writeJson(s.files.usage, { ...usage, at: 0 })
  await usageTurn(s.paths, s.m)({ files: s.files })
  usage = readJson(s.files.usage)
  assert.equal(usage.loginError, false)
  assert.ok(readJsonl(s.files.events).some((e) => e.kind === 'usage.login-back'))
})

test('the conductor plans the first project that needs it and records a failed plan without stopping', async (t) => {
  const s = setup(t)
  writeJson(join(s.files.dir, 'projects.json'), { at: NOW, projects: [{ name: 'alpha', repo: s.home, rank: 0, order: 0, base: 'main', notes: [] }] })
  const answer = { map: { basis: 'b', tasks: [{ id: 't1', title: 'One', done: false }] }, items: [{ title: 'Do one', why: 'w', doneWhen: 'd', task: 't1', decisionFree: true }] }
  const call = async () => JSON.stringify({ is_error: false, structured_output: answer, total_cost_usd: 0.01 })
  const run = () => ''
  await conductorTurn(s.paths, s.m, { call, run })({ current: s.current, files: s.files })
  const queue = readJson(s.files.queue)
  assert.deepEqual(queue.items.map((i) => i.title), ['Do one'])
  assert.ok(readJsonl(s.files.events).some((e) => e.kind === 'planner.done' && e.added === 1))
  s.tick(10 * 60_000)
  const failing = async () => JSON.stringify({ is_error: true, result: 'overloaded' })
  await conductorTurn(s.paths, s.m, { call: failing, run })({ current: s.current, files: s.files })
  assert.ok(readJsonl(s.files.events).some((e) => e.kind === 'planner.failed'))
})
