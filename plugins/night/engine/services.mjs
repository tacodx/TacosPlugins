// The night's long-running services: conductor, health, logs, usage and medic.
// Each is a loop of turns; a turn reads the files, decides with the pure modules,
// acts, and beats. systemd restarts a service that dies, the medic restarts one
// whose beat goes stale, and the keeper restarts the medic.
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { loadConfig, nightFiles } from './config.mjs'
import { readJson, writeJson } from './fsx.mjs'
import { repoRoot } from './git.mjs'
import { pausePlan, sampleHealth, verdict } from './health.mjs'
import { classify as classifyLog, createDeduper, followArgs } from './logs.mjs'
import { failedSteps, nightProjects, rerunSteps, roadmapRows } from './night.mjs'
import { planProject } from './planner.mjs'
import { addPlan, nextToPlan, readQueue, withQueue } from './queue.mjs'
import { classify, findTranscript, hasChildren, readRegistry, tailJsonl, transcriptState } from './sessions.mjs'
import { addEvent, beat, readBeats, readCurrent, RUNNING, staleBeats } from './state.mjs'
import * as fans from './hardware/fans.mjs'
import { desktopHeld } from './worker.mjs'

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `turn` forever, beating after each; returns when SIGTERM arrives. */
export async function serviceLoop(name, turn, { paths, intervalMs }) {
  let stopping = false
  process.once('SIGTERM', () => { stopping = true })
  while (!stopping) {
    const current = readCurrent(paths)
    const files = current.date ? nightFiles(paths, current.date) : null
    let wait = intervalMs
    if (RUNNING.has(current.phase)) {
      // A turn may take minutes (a planner call); the beat goes on while it runs.
      beat(files, name)
      const beating = setInterval(() => beat(files, name), 30_000)
      try {
        wait = (await turn({ current, files })) ?? intervalMs
      } catch (err) {
        addEvent(files, 'service.error', { name, error: String(err?.stack ?? err).slice(0, 500) })
      } finally {
        clearInterval(beating)
      }
      beat(files, name)
    } else {
      wait = 30_000
    }
    const until = Date.now() + wait
    while (!stopping && Date.now() < until) await sleepFor(Math.min(1000, until - Date.now()))
  }
}

// ---- conductor: keeps the queue ahead of the workers ----

export function conductorTurn(paths, m, { call, run } = {}) {
  return async ({ current, files }) => {
    const { config } = loadConfig(paths)
    const projects = nightProjects(paths, config, current.date, { now: m.now() })
    const queue = readQueue(paths, current.date)
    const busy = new Set([...desktopHeld(files)])
    const next = nextToPlan(queue, projects, { sessions: config.sessions, now: m.now(), busy })
    if (!next) return 60_000
    const started = m.now()
    try {
      const plan = await planProject(next, {
        queue, planGlobs: config.sources.planGlobs, roadmapRows: roadmapRows(paths, config), model: config.models.planner, call, run, now: started,
      })
      const added = await withQueue(paths, current.date, (q) => {
        const { queue: after, added: fresh } = addPlan(q, next, plan, m.now())
        return { queue: after, result: fresh }
      })
      addEvent(files, 'planner.done', { project: next.name, added: added.length, tasks: plan.map.tasks.length, seconds: Math.round((m.now() - started) / 1000), cost: plan.cost }, m.now())
    } catch (err) {
      await withQueue(paths, current.date, (q) => ({ queue: { ...q, planned: { ...q.planned, [next.name]: m.now() } } }))
      addEvent(files, 'planner.failed', { project: next.name, error: String(err?.message ?? err).slice(0, 300) }, m.now())
    }
    return 5_000
  }
}

// ---- health: memory, disk, temperatures, the pump ----

/** MemoryCurrent of each running worker unit, in bytes. */
async function workerSizes(m, sessions, paused) {
  const out = []
  for (let slot = 1; slot <= sessions; slot++) {
    if (paused.some((p) => p.slot === slot)) continue
    const r = await m.systemctl('show', '-p', 'MemoryCurrent', '--value', `night-worker@${slot}.service`)
    const bytes = Number(String(r.stdout).trim())
    if (Number.isFinite(bytes) && bytes > 0) out.push({ slot, bytes })
  }
  return out
}

export function healthTurn(paths, m) {
  let lastActionAt = null
  let clearSince = null
  let pumpLowCount = 0
  let pumpUnknown = 0
  let hotHandled = false
  return async ({ files }) => {
    const { config } = loadConfig(paths)
    const now = m.now()
    const sample = sampleHealth({ home: paths.home, now, run: m.runSync })
    const v = verdict(sample, config.health)
    const bad = v.blockers.length > 0 || v.thrash
    clearSince = bad ? null : clearSince ?? now
    const before = readJson(files.health, null)
    const line = v.blockers[0]?.text ?? v.warnings[0]?.text ?? 'All fine.'
    writeJson(files.health, { at: now, sample, verdict: v, line, fansHeldDay: before?.fansHeldDay === true })
    for (const b of v.blockers) if (!before?.verdict?.blockers?.some((x) => x.code === b.code)) addEvent(files, 'health.blocker', { code: b.code, text: b.text }, now)
    if (v.thrash && !before?.verdict?.thrash) addEvent(files, 'health.thrash', {}, now)

    const pausedFile = join(files.dir, 'paused.json')
    const pausedState = readJson(pausedFile, { slots: [], at: {} })
    const paused = pausedState.slots.map((slot) => ({ slot, pausedAt: pausedState.at?.[slot] ?? 0 }))
    const plan = pausePlan({ verdict: v, workers: await workerSizes(m, config.sessions, paused), paused, lastActionAt, clearSince, now })
    if (plan.action === 'pause') {
      writeJson(pausedFile, { slots: [...pausedState.slots, plan.slot], at: { ...pausedState.at, [plan.slot]: now } })
      addEvent(files, 'health.pause', { slot: plan.slot, why: line }, now)
      lastActionAt = now
    } else if (plan.action === 'resume') {
      writeJson(pausedFile, { slots: pausedState.slots.filter((s) => s !== plan.slot), at: pausedState.at })
      addEvent(files, 'health.resume', { slot: plan.slot }, now)
      lastActionAt = now
    }

    // The pump: under its floor the Day mode goes on; still low a minute later, every worker pauses.
    // Only when the owner set a pump device: without one there is nothing to watch.
    const fanCtx = { config, home: paths.home, fetch: m.fetch, run: m.run, sleep: m.sleep, readFile: m.readFile }
    const holdDay = () => writeJson(files.health, { ...readJson(files.health, {}), fansHeldDay: true })
    if (config.hardware.fans.pumpDevice) {
      const rpm = fans.pumpRpm(readSensors(m), config.hardware.fans.pumpChannel)
      if (rpm === null) {
        pumpUnknown++
        if (pumpUnknown === 4) addEvent(files, 'pump.unknown', { text: 'The pump speed could not be read for two minutes.' }, now)
      } else {
        pumpUnknown = 0
      }
      if (rpm !== null && rpm < config.hardware.fans.pumpMinRpm) {
        pumpLowCount++
        addEvent(files, 'pump.low', { rpm }, now)
        if (pumpLowCount === 1) {
          await fans.day(fanCtx)
          holdDay()
        }
        if (pumpLowCount >= 3) {
          writeJson(pausedFile, { slots: Array.from({ length: config.sessions }, (_, i) => i + 1), at: {}, pump: true })
          await m.notify(`The pump reads ${rpm} RPM. Night mode paused every worker.`)
        }
      } else if (rpm !== null) {
        pumpLowCount = 0
      }
    }
    if (v.hot && !hotHandled) {
      hotHandled = true
      addEvent(files, 'health.hot', { cpuC: sample.cpuC, gpuJunctionC: sample.gpuJunctionC }, now)
      await fans.day(fanCtx)
      holdDay()
    } else if (!v.hot) {
      hotHandled = false
    }
    return 30_000
  }
}

function readSensors(m) {
  try { return JSON.parse(m.runSync(['sensors', '-j'])) } catch { return null }
}

// ---- logs: errors in the journal ----

export function logsTurn(paths, m) {
  const dedupe = createDeduper()
  const followers = new Map()
  return async ({ files }) => {
    for (const system of [false, true]) {
      const key = system ? 'system' : 'user'
      if (followers.get(key)?.exitCode === null) continue
      const argv = followArgs({ system })
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] })
      let buffer = ''
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          let entry
          try { entry = JSON.parse(raw) } catch { continue }
          const found = classifyLog(entry)
          if (found && dedupe(found, m.now())) addEvent(files, `log.${found.kind}`, { unit: found.unit, text: found.text, repeats: found.repeats }, m.now())
        }
      })
      followers.set(key, child)
    }
    return 30_000
  }
}

// ---- usage: limits and their resets ----

export function usageTurn(paths, m) {
  return async ({ files }) => {
    const cache = readJson(paths.usageCache, null)
    const gauges = cache?.data?.gauges ?? cache?.data ?? null
    const before = readJson(files.usage, {}) ?? {}
    const now = m.now()
    const fiveHour = gauges?.five_hour ?? null
    const sevenDay = gauges?.seven_day ?? null
    let loginError = before.loginError === true
    // A login error clears once the credentials file changes (the owner logged in again).
    if (loginError) {
      try {
        if (statSync(join(paths.claude, '.credentials.json')).mtimeMs > (before.at ?? 0)) loginError = false
      } catch { /* keep it */ }
    }
    const next = {
      at: loginError ? before.at ?? now : now,
      fresh: cache ? now - (cache.fetchedAt ?? 0) < 15 * 60_000 : false,
      fiveHour: fiveHour?.percent ?? null,
      sevenDay: sevenDay?.percent ?? null,
      resetsAt: fiveHour?.resetsAt ?? null,
      loginError,
    }
    if (before.loginError && !loginError) addEvent(files, 'usage.login-back', {}, now)
    if ((before.fiveHour ?? 0) >= 100 && (next.fiveHour ?? 0) < 100) addEvent(files, 'limit.reset', { gauge: 'five_hour' }, now)
    writeJson(files.usage, next)
    return 60_000
  }
}

// ---- medic: sessions, workers, watchers, unfinished steps ----

export function medicTurn(paths, m) {
  const repos = new Map()
  const seenWaiting = new Set()
  const restartedAt = new Map()
  const repoOf = (cwd) => {
    if (!repos.has(cwd)) repos.set(cwd, repoRoot(cwd))
    return repos.get(cwd)
  }
  const restart = async (files, unit, why) => {
    const last = restartedAt.get(unit) ?? 0
    if (m.now() - last < 5 * 60_000) return
    restartedAt.set(unit, m.now())
    addEvent(files, unit.startsWith('night-worker') ? 'worker.restart' : 'watcher.restart', { unit, why }, m.now())
    await m.systemctl('restart', unit)
  }
  return async ({ current, files }) => {
    const { config } = loadConfig(paths)
    const now = m.now()
    const worktrees = join(paths.share, 'worktrees')
    const sessions = []
    for (const entry of readRegistry(paths.sessions)) {
      if (entry.entrypoint === 'sdk-cli' || entry.cwd.startsWith(worktrees)) continue
      const found = findTranscript(paths.transcripts, entry.cwd, entry.sessionId)
      const state = found ? transcriptState(tailJsonl(found.path)) : null
      const label = classify(entry, state, { now, hasChildren: entry.alive && hasChildren(entry.pid) })
      const repo = repoOf(entry.cwd)
      sessions.push({
        kind: entry.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
        name: entry.name,
        sessionId: entry.sessionId,
        hostSessionId: entry.hostSessionId,
        project: repo ? basename(repo) : null,
        cwd: entry.cwd,
        ...label,
      })
      if (label.label === 'waiting') {
        const key = `${entry.sessionId}:${entry.statusUpdatedAt}`
        if (!seenWaiting.has(key)) {
          seenWaiting.add(key)
          addEvent(files, 'session.waiting', { name: entry.name, on: label.on }, now)
        }
      }
    }
    writeJson(files.sessions, { at: now, sessions })

    // A service gets three minutes after dusk, and after each restart, before a missing beat counts.
    const graceOver = now - (current.duskAt ?? 0) > 3 * 60_000
    const beats = graceOver ? readBeats(files) : null
    const paused = readJson(join(files.dir, 'paused.json'), { slots: [] }).slots ?? []
    if (!beats) return 60_000
    for (let slot = 1; slot <= config.sessions; slot++) {
      if (paused.includes(slot)) continue
      if (staleBeats(beats, [`worker-${slot}`], now, 3 * 60_000).length) await restart(files, `night-worker@${slot}.service`, 'its beat is late')
    }
    for (const name of ['conductor', 'health', 'logs', 'usage']) {
      if (staleBeats(beats, [name], now, 3 * 60_000).length) await restart(files, `night-${name}.service`, 'its beat is late')
    }
    const duskLeft = failedSteps(current, 'dusk')
    if (duskLeft.length && current.phase === 'night') await rerunSteps(paths, m, 'dusk', duskLeft)
    const dawnLeft = failedSteps(current, 'dawn')
    if (dawnLeft.length && current.phase !== 'night') await rerunSteps(paths, m, 'dawn', dawnLeft)
    return 60_000
  }
}

