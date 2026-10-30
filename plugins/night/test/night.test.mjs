import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nightFiles, nightPaths } from '../engine/config.mjs'
import { readJsonl, writeJson } from '../engine/fsx.mjs'
import { arm, canary, dawn, disarm, dusk, keep, requestStop, stop, view } from '../engine/night.mjs'
import { addPlan, claim, emptyQueue, readQueue } from '../engine/queue.mjs'
import { readCurrent, writeCurrent } from '../engine/state.mjs'
import { tempDir } from './helpers.mjs'

const ZONE = 'Europe/Berlin'
const EVENING = Date.parse('2026-03-10T19:00:00Z') // 20:00 local

function fakeMachine(t, { now = EVENING } = {}) {
  const home = tempDir(t)
  const paths = nightPaths({ env: { HOME: home }, home })
  writeJson(paths.config, { window: { from: '23:30', to: '06:30' }, sessions: 2 })
  const calls = []
  let clock = now
  const m = {
    now: () => clock,
    zone: ZONE,
    run: async (argv) => { calls.push(['run', ...argv]); return { code: 0, stdout: '', stderr: '' } },
    runSync: () => '',
    systemctl: async (...args) => { calls.push(['systemctl', ...args]); return { code: 0, stdout: '', stderr: '' } },
    fetch: async () => { throw new Error('no network in tests') },
    sleep: async () => {},
    readFile: readFileSync,
    notify: async (text) => { calls.push(['notify', text]) },
  }
  const guardOk = join(home, 'guard-ok.sh')
  // A stand-in guard: denies a push, allows everything else.
  writeFileSync(guardOk, '#!/bin/sh\nif grep -q "git push"; then echo \'{"hookSpecificOutput":{"permissionDecision":"deny"}}\'; fi\n')
  chmodSync(guardOk, 0o755)
  return { home, paths, m, calls, set: (ms) => { clock = ms }, guardOk }
}

const has = (calls, ...words) => calls.some((c) => words.every((w) => c.includes(w)))

/** Arms a night inside its window and lets its dusk timer fire. */
async function armAndRun(s) {
  await arm(s.paths, s.m)
  s.set(s.m.now() + 11_000)
  await dusk(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
}

test('arming in the evening sets exact UTC timers for tonight and enables them', async (t) => {
  const s = fakeMachine(t)
  const current = await arm(s.paths, s.m)
  assert.equal(current.phase, 'armed')
  assert.equal(current.date, '2026-03-10')
  const dusk = readFileSync(join(s.paths.units, 'night-dusk.timer'), 'utf8')
  assert.match(dusk, /OnCalendar=2026-03-10 22:30:00 UTC/)
  assert.match(readFileSync(join(s.paths.units, 'night-dawn.timer'), 'utf8'), /OnCalendar=2026-03-11 05:30:00 UTC/)
  assert.ok(has(s.calls, 'enable', '--now', 'night-dusk.timer', 'night-dawn.timer'))
  assert.ok(!has(s.calls, 'start', 'night.target'))
})

test('arming inside the window hands dusk to its timer ten seconds out, so the call returns at once', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  const current = await arm(s.paths, s.m)
  assert.equal(current.phase, 'armed')
  assert.equal(current.start, Date.parse('2026-03-11T01:00:10Z'))
  assert.match(readFileSync(join(s.paths.units, 'night-dusk.timer'), 'utf8'), /OnCalendar=2026-03-11 01:00:10 UTC/)
  assert.ok(!has(s.calls, 'start', 'night.target'))
  await armAndRun({ ...s, m: s.m })
})

test('dusk runs every step on its own, records it, and starts the night\'s services', async (t) => {
  const s = fakeMachine(t)
  await arm(s.paths, s.m)
  s.set(Date.parse('2026-03-10T22:30:00Z'))
  await dusk(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  const current = readCurrent(s.paths)
  assert.equal(current.phase, 'night')
  assert.equal(current.unsafe, null)
  assert.deepEqual(Object.keys(current.steps.dusk), ['inhibit', 'power', 'fans', 'rgb', 'screens'])
  assert.equal(current.steps.dusk.fans.skipped, true) // no CoolerControl token in this config
  assert.ok(has(s.calls, 'start', 'night-inhibit.service'))
  assert.ok(has(s.calls, 'run', 'qdbus-qt6'))
  assert.ok(readJsonl(nightFiles(s.paths, '2026-03-10').events).some((e) => e.kind === 'dusk.step' && e.step === 'screens'))
})

test('a guard that lets a push through marks the night unsafe and says so', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-10T22:31:00Z') })
  const leaky = join(s.home, 'leaky.sh')
  writeFileSync(leaky, '#!/bin/sh\nexit 0\n')
  await arm(s.paths, s.m)
  s.set(s.m.now() + 11_000)
  await dusk(s.paths, s.m, { node: '/bin/sh', guard: leaky })
  assert.deepEqual(readCurrent(s.paths).unsafe, ['the guard hook did not deny a git push'])
  assert.ok(has(s.calls, 'notify'))
})

test('the canary sees that git with the worker environment cannot push', async (t) => {
  const s = fakeMachine(t)
  assert.deepEqual(await canary({ node: '/bin/sh', guard: s.guardOk, scratch: s.home }), [])
})

test('a dusk that fires after the window (a reboot in the afternoon) does nothing', async (t) => {
  const s = fakeMachine(t)
  await arm(s.paths, s.m)
  s.set(Date.parse('2026-03-11T13:00:00Z'))
  await dusk(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  assert.equal(readCurrent(s.paths).phase, 'idle')
  assert.ok(!has(s.calls, 'start', 'night.target'))
})

test('the keeper runs a missed dusk, keeps the target up, stops spare workers and runs a missed dawn', async (t) => {
  const s = fakeMachine(t)
  await arm(s.paths, s.m)
  s.set(Date.parse('2026-03-10T23:00:00Z'))
  await keep(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  assert.equal(readCurrent(s.paths).phase, 'night')
  s.calls.length = 0
  await keep(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  assert.ok(has(s.calls, 'start', 'night.target'))
  assert.ok(has(s.calls, 'stop', 'night-worker@3.service'))
  assert.ok(has(s.calls, 'restart', 'night-medic.service')) // no medic beat yet
  s.set(Date.parse('2026-03-11T05:40:00Z'))
  let recapped = false
  await keep(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk, recap: async () => { recapped = true } })
  assert.equal(readCurrent(s.paths).phase, 'day')
  assert.ok(recapped)
  assert.ok(has(s.calls, 'run', 'kscreen-doctor', '--dpms', 'on'))
})

test('dawn brings the machine back, keeps sleep blocked, and the night goes on as day', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  s.calls.length = 0
  await dawn(s.paths, s.m)
  assert.equal(readCurrent(s.paths).phase, 'day')
  assert.ok(!has(s.calls, 'stop', 'night-inhibit.service'))
  assert.ok(!has(s.calls, 'stop', 'night.target'))
})

test('stop writes stopped first, ends the services, restores the machine, and gives items back', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  const date = readCurrent(s.paths).date
  let q = addPlan(emptyQueue(date), { name: 'alpha', repo: '/r', base: 'b', rank: 0 }, { items: [{ title: 'x' }] }, 0).queue
  q = claim(q, q.items[0].id, { slot: 1, now: 0 })
  writeJson(nightFiles(s.paths, date).queue, q)
  s.calls.length = 0
  let phaseWhenStopping = null
  const realSystemctl = s.m.systemctl
  s.m.systemctl = async (...args) => {
    if (args[0] === 'stop' && args[1] === 'night.target') phaseWhenStopping = readCurrent(s.paths).phase
    return realSystemctl(...args)
  }
  await stop(s.paths, s.m)
  assert.equal(phaseWhenStopping, 'stopped')
  assert.equal(readCurrent(s.paths).phase, 'stopped')
  assert.ok(has(s.calls, 'run', 'kscreen-doctor'))
  assert.ok(has(s.calls, 'stop', 'night-inhibit.service'))
  assert.ok(has(s.calls, 'disable', '--now', 'night-dusk.timer'))
  assert.equal(readQueue(s.paths, date).items[0].status, 'open')
  assert.ok(!existsSync(join(s.paths.units, 'night-dawn.timer')))
  s.calls.length = 0
  await keep(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  assert.equal(s.calls.length, 0)
})

test('arming twice while a night runs is refused; disarming an armed night removes its timers', async (t) => {
  const s = fakeMachine(t)
  await arm(s.paths, s.m)
  await disarm(s.paths, s.m)
  assert.equal(readCurrent(s.paths).phase, 'idle')
  assert.ok(!existsSync(join(s.paths.units, 'night-dusk.timer')))
  s.set(Date.parse('2026-03-11T01:00:00Z'))
  await armAndRun(s)
  await assert.rejects(arm(s.paths, s.m), /running/)
  await assert.rejects(disarm(s.paths, s.m), /stop/)
})

test('the view tells the pane the phase, the window, each worker and the queue', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  const v = view(s.paths, s.m)
  assert.equal(v.phase, 'night')
  assert.deepEqual(v.window, { from: '23:30', to: '06:30' })
  assert.equal(v.workers.length, 2)
  assert.deepEqual(v.queue, { open: 0, taken: 0, done: 0, parked: 0, failed: 0 })
  assert.equal(v.fans.token, false)
  assert.ok(v.watchers.length >= 5)
})

test('dawn runs once: a timer that fires again changes nothing', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  await dawn(s.paths, s.m)
  s.calls.length = 0
  let recaps = 0
  await dawn(s.paths, s.m, { recap: async () => { recaps++ } })
  assert.equal(s.calls.length, 0)
  assert.equal(recaps, 0)
})

test('before any night the view lists the open projects from the notes', async (t) => {
  const s = fakeMachine(t)
  const v = view(s.paths, s.m)
  assert.deepEqual(v.projects, [])
  assert.equal(v.phase, 'idle')
})

test('Stop from the pane marks the night stopped at once and leaves the slow part to night-stop.service', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  s.calls.length = 0
  const current = await requestStop(s.paths, s.m)
  assert.equal(current.phase, 'stopped')
  assert.deepEqual(s.calls, [['systemctl', 'start', '--no-block', 'night-stop.service']])
  await stop(s.paths, s.m)
  assert.equal(readCurrent(s.paths).stopping, false)
  assert.ok(has(s.calls, 'stop', 'night.target'))
})

test('a dawn timer and a keeper that both see the window end run dawn once between them', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  s.set(Date.parse('2026-03-11T05:31:00Z'))
  const fast = s.m.run
  s.m.run = async (argv) => { await new Promise((r) => setTimeout(r, 150)); return fast(argv) }
  s.calls.length = 0
  let recaps = 0
  const recap = async () => { recaps++ }
  await Promise.all([dawn(s.paths, s.m, { recap }), keep(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk, recap })])
  assert.equal(s.calls.filter((c) => c.includes('kscreen-doctor')).length, 1)
  assert.equal(recaps, 1)
  assert.equal(readCurrent(s.paths).phase, 'day')
})

test('a Stop that lands during dusk keeps the later steps and the services from starting', async (t) => {
  const s = fakeMachine(t)
  await arm(s.paths, s.m)
  s.set(Date.parse('2026-03-10T22:30:05Z'))
  const fast = s.m.run
  s.m.run = async (argv) => {
    if (argv[0] === 'qdbus-qt6') throw new Error('screens must not go off after Stop')
    // The owner presses Stop while the power step runs.
    if (argv.includes('night-power.service')) writeCurrent(s.paths, { ...readCurrent(s.paths), phase: 'stopped' })
    return fast(argv)
  }
  await dusk(s.paths, s.m, { node: '/bin/sh', guard: s.guardOk })
  assert.equal(readCurrent(s.paths).phase, 'stopped')
  assert.ok(!has(s.calls, 'start', 'night.target'))
  assert.ok(!has(s.calls, 'run', 'qdbus-qt6'))
})

test('a guard that cannot start fails the canary: exit 2 alone is not a deny', async (t) => {
  const s = fakeMachine(t)
  const broken = join(s.home, 'broken.sh')
  writeFileSync(broken, '#!/bin/sh\nexit 1\n')
  const problems = await canary({ node: '/bin/sh', guard: broken, scratch: s.home })
  assert.ok(problems.includes('the guard hook did not deny a git push'))
})

test('the canary passes with the real guard: a push denied, a read allowed, no credentials, no ssh', async (t) => {
  const s = fakeMachine(t)
  writeFileSync(join(s.home, '.keep'), '')
  const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'guard.mjs')
  assert.deepEqual(await canary({ node: process.execPath, guard, scratch: s.home }), [])
})

test('with a working guard the night is not marked unsafe', async (t) => {
  const s = fakeMachine(t, { now: Date.parse('2026-03-11T01:00:00Z') })
  await armAndRun(s)
  assert.equal(readCurrent(s.paths).unsafe, null)
})
