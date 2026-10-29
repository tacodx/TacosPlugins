// The night as a whole: arm, dusk, dawn, stop, the keeper, and the view the pane
// reads. Every step is safe to run twice and records what it did in current.json,
// so the medic and the keeper can finish what a killed process started.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { calendarUtc, localDate, nextAt, planNight, systemTimeZone } from './clock.mjs'
import { loadConfig, nightFiles } from './config.mjs'
import { readJson, readJsonl, writeJson, writeText } from './fsx.mjs'
import { baseBranch, commitsSince, dirtyPaths, runGit } from './git.mjs'
import { counts, progressOf, readQueue, releaseSlot, withQueue } from './queue.mjs'
import { chooseProjects, findProjects, parseRoadmapRows, readNotes } from './sources.mjs'
import { addEvent, readBeats, readCurrent, RUNNING, staleBeats, updateCurrent, writeCurrent } from './state.mjs'
import { buildTimers, buildUnits, removeUnits, TIMER_NAMES, writeUnits } from './units.mjs'
import { runCommand } from './hardware/run.mjs'
import * as fans from './hardware/fans.mjs'
import * as power from './hardware/power.mjs'
import * as rgb from './hardware/rgb.mjs'
import * as screens from './hardware/screens.mjs'

export const WATCHERS = ['conductor', 'health', 'logs', 'usage', 'medic']

/** The effects night needs from the machine; tests replace them. */
export function machine({ env = process.env } = {}) {
  return {
    now: Date.now,
    zone: env.TZ || systemTimeZone(),
    run: (argv, options) => runCommand(argv, { env, ...options }),
    runSync: (argv) => {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000, env })
      if (r.status !== 0) throw new Error(`${argv[0]} exited ${r.status}`)
      return r.stdout
    },
    systemctl: (...args) => runCommand(['systemctl', '--user', ...args], { env, timeoutMs: 90_000 }),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: readFileSync,
    notify: (text) => runCommand(['notify-send', '--app-name=Night', 'Night', text], { env, timeoutMs: 10_000 }),
  }
}

/** Every open project in the owner's order, with the branch the night builds on (cached per night). */
export function nightProjects(paths, config, date, { refresh = false, now = Date.now() } = {}) {
  const files = nightFiles(paths, date)
  const cachePath = join(files.dir, 'projects.json')
  const cached = readJson(cachePath, null)
  if (!refresh && cached && now - cached.at < 30 * 60_000) return chooseProjects(cached.projects, config.projects)
  const notes = config.sources.notesDir ? readNotes(config.sources.notesDir.replace(/^~(?=\/)/, paths.home)) : []
  const found = findProjects(notes, {
    home: paths.home,
    openStatuses: config.sources.openStatuses,
    excludeAreas: config.sources.excludeAreas,
  })
  const projects = found.map((p, order) => ({
    name: p.name,
    repo: p.repo,
    rank: p.rank,
    order,
    status: ['Doing', 'Planned', 'Paused'][p.rank] ?? 'Open',
    base: cached?.projects?.find((c) => c.name === p.name)?.base ?? baseBranch(p.repo, config.protectedBranches),
    notes: p.notes.map((n) => ({ name: n.name, status: n.status, next: n.next, body: n.body.slice(0, 1500) })),
  }))
  writeJson(cachePath, { at: now, projects })
  return chooseProjects(projects, config.projects)
}

/** Every roadmap row the config names. */
export function roadmapRows(paths, config) {
  const rows = []
  for (const file of config.sources.roadmaps ?? []) {
    try { rows.push(...parseRoadmapRows(readFileSync(file.replace(/^~(?=\/)/, paths.home), 'utf8'))) } catch { /* missing */ }
  }
  return rows
}

function hardwareCtx(paths, config, m) {
  return { config, home: paths.home, fetch: m.fetch, run: m.run, sleep: m.sleep, readFile: m.readFile }
}

const DUSK_STEPS = [
  ['inhibit', (ctx) => power.inhibit(ctx)],
  ['power', (ctx) => power.night(ctx)],
  ['fans', (ctx) => fans.night(ctx)],
  ['rgb', (ctx) => rgb.night(ctx)],
  ['screens', (ctx) => screens.night(ctx)],
]
const DAWN_STEPS = [
  ['screens', (ctx) => screens.day(ctx)],
  ['fans', (ctx) => fans.day(ctx)],
  ['power', (ctx) => power.day(ctx)],
  ['rgb', (ctx) => rgb.day(ctx)],
]

/** Runs steps, each on its own, and records each result in current.json under `which`. */
async function runSteps(paths, which, steps, ctx, m, { only } = {}) {
  const files = nightFiles(paths, readCurrent(paths).date)
  for (const [name, step] of steps) {
    if (only && !only.includes(name)) continue
    let result
    try {
      result = await step(ctx)
    } catch (err) {
      result = { ok: false, detail: String(err?.message ?? err).slice(0, 300) }
    }
    const at = m.now()
    updateCurrent(paths, (c) => {
      const before = c.steps?.[which]?.[name]
      return { ...c, steps: { ...c.steps, [which]: { ...c.steps?.[which], [name]: { ...result, at, tries: (before?.tries ?? 0) + 1 } } } }
    })
    addEvent(files, `${which}.step`, { step: name, ok: result.ok, skipped: result.skipped ?? false, detail: result.detail ?? '' }, at)
  }
}

/** Runs again the named steps of dusk or dawn that failed (the medic calls this). */
export async function rerunSteps(paths, m, which, only) {
  const { config } = loadConfig(paths)
  await runSteps(paths, which, which === 'dusk' ? DUSK_STEPS : DAWN_STEPS, hardwareCtx(paths, config, m), m, { only })
}

/** The steps of `which` that failed and may be tried again (three tries each). */
export function failedSteps(current, which) {
  return Object.entries(current.steps?.[which] ?? {})
    .filter(([, r]) => !r.ok && !r.skipped && (r.tries ?? 0) < 3)
    .map(([name]) => name)
}

/**
 * Proves the walls hold before any worker starts: the guard hook denies a push,
 * and git with the worker environment cannot push. Returns the problems found.
 */
export async function canary({ node, guard, run, scratch }) {
  const problems = []
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: scratch, session_id: 'canary' })
  const hook = spawnSync('sh', ['-c', `"${node}" "${guard}" || exit 2`], {
    input,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NIGHT_WORKTREE: scratch, NIGHT_SCRATCH: scratch, NIGHT_PROTECTED: 'main', NIGHT_TEST_LOCK: '/tmp/x' },
  })
  const denied = hook.status === 2 || /"permissionDecision"\s*:\s*"deny"/.test(hook.stdout ?? '')
  if (!denied) problems.push('the guard hook did not deny a git push')
  const { workerEnv } = await import('./claude.mjs')
  const env = workerEnv(process.env, { slot: 0, worktree: scratch, scratch, protectedBranches: ['main'], testLock: '/tmp/x', events: '/dev/null', decisions: '/dev/null' })
  // A throwaway repo with a GitHub remote: git must rewrite its push URL to the blocked host.
  const repo = join(scratch, 'canary-repo')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  spawnSync('git', ['-C', repo, 'remote', 'remove', 'canary'], { encoding: 'utf8' })
  spawnSync('git', ['-C', repo, 'remote', 'add', 'canary', 'https://github.com/example/canary.git'], { encoding: 'utf8' })
  const url = spawnSync('git', ['-C', repo, 'remote', 'get-url', '--push', 'canary'], { encoding: 'utf8', env })
  if (!/night-blocked/.test(url.stdout ?? '')) problems.push('git with the worker environment still has a real push URL')
  return problems
}

/** Writes and enables the dusk and dawn timers for the current night. */
async function writeTimers(paths, current, m) {
  const timers = buildTimers({ dusk: calendarUtc(current.start), dawn: calendarUtc(current.end) })
  writeUnits(paths.units, timers)
  await m.systemctl('daemon-reload')
  await m.systemctl('enable', '--now', ...TIMER_NAMES)
}

/** Arms the next night of the owner's window, or the one running now. */
export async function arm(paths, m, { startNow = false } = {}) {
  const { config, problems } = loadConfig(paths)
  if (problems.length) throw new Error(problems.join('; '))
  const before = readCurrent(paths)
  if (RUNNING.has(before.phase)) throw new Error('a night is running; stop it first')
  const now = m.now()
  const planned = startNow
    ? { start: now, end: nextAt(config.window.to, now, m.zone), date: localDate(now, m.zone), inside: true }
    : planNight(config.window, now, m.zone)
  const current = writeCurrent(paths, {
    phase: 'armed', date: planned.date, start: planned.start, end: planned.end, window: config.window, armedAt: now, steps: {},
  })
  await writeTimers(paths, current, m)
  addEvent(nightFiles(paths, current.date), 'armed', { start: new Date(current.start).toISOString(), end: new Date(current.end).toISOString() }, now)
  if (planned.inside) await dusk(paths, m)
  return readCurrent(paths)
}

export async function disarm(paths, m) {
  const current = readCurrent(paths)
  if (RUNNING.has(current.phase)) throw new Error('a night is running; use stop')
  await m.systemctl('disable', '--now', ...TIMER_NAMES)
  removeUnits(paths.units, TIMER_NAMES)
  await m.systemctl('daemon-reload')
  if (current.phase === 'armed') writeCurrent(paths, { phase: 'idle', date: current.date, disarmedAt: m.now() })
  return readCurrent(paths)
}

/** At "from": the walls are checked, the machine goes dark and quiet, the night's services start. */
export async function dusk(paths, m, { node = process.execPath, guard } = {}) {
  const current = readCurrent(paths)
  const now = m.now()
  if (!['armed', 'dusk'].includes(current.phase)) return current
  const files = nightFiles(paths, current.date)
  if (now >= current.end) {
    addEvent(files, 'dusk.missed', {}, now)
    return writeCurrent(paths, { ...current, phase: 'idle', missedAt: now })
  }
  updateCurrent(paths, (c) => ({ ...c, phase: 'dusk', duskAt: c.duskAt ?? now }))
  const { config } = loadConfig(paths)
  const scratch = join(paths.share, 'scratch', current.date, 'canary')
  writeText(join(scratch, '.keep'), '')
  const problems = guard ? await canary({ node, guard, run: m.run, scratch }) : ['no guard path given']
  updateCurrent(paths, (c) => ({ ...c, unsafe: problems.length ? problems : null }))
  if (problems.length) {
    addEvent(files, 'canary.failed', { problems }, now)
    await m.notify(`Night mode did not start workers: ${problems.join('; ')}`)
  }
  await runSteps(paths, 'dusk', DUSK_STEPS, hardwareCtx(paths, config, m), m)
  await m.systemctl('start', 'night.target')
  return updateCurrent(paths, (c) => ({ ...c, phase: c.phase === 'dusk' ? 'night' : c.phase }))
}

/** At "to": the machine comes back and the recap is written. Workers go on until Stop. */
export async function dawn(paths, m, { recap } = {}) {
  const current = readCurrent(paths)
  if (!current.date || current.phase === 'idle' || current.phase === 'armed') return current
  const { config } = loadConfig(paths)
  await runSteps(paths, 'dawn', DAWN_STEPS, hardwareCtx(paths, config, m), m)
  const next = updateCurrent(paths, (c) => ({ ...c, phase: c.phase === 'stopped' ? 'stopped' : 'day', dawnAt: c.dawnAt ?? m.now() }))
  if (recap) await recap(paths, m)
  return next
}

/** Stop: nothing restarts any more, workers end and commit what they left, the machine is restored. */
export async function stop(paths, m, { recap } = {}) {
  const current = readCurrent(paths)
  if (!current.date) return current
  const wasDawn = Boolean(current.dawnAt)
  writeCurrent(paths, { ...current, phase: 'stopped', stoppedAt: m.now() })
  const files = nightFiles(paths, current.date)
  addEvent(files, 'stop', {}, m.now())
  await m.systemctl('stop', 'night.target')
  await m.systemctl('stop', 'night-worker@*.service')
  await withQueue(paths, current.date, (q) => {
    let next = q
    for (const slot of new Set(q.items.filter((i) => i.status === 'taken').map((i) => i.slot))) next = releaseSlot(next, slot, m.now())
    return { queue: next }
  })
  const { config } = loadConfig(paths)
  if (!wasDawn) await runSteps(paths, 'dawn', DAWN_STEPS, hardwareCtx(paths, config, m), m)
  await power.release(hardwareCtx(paths, config, m))
  await m.systemctl('disable', '--now', ...TIMER_NAMES)
  removeUnits(paths.units, TIMER_NAMES)
  removeCleanWorktrees(paths, current.date)
  if (recap) await recap(paths, m)
  return readCurrent(paths)
}

/** Removes the night's worktrees that hold no uncommitted work; their branches stay. */
export function removeCleanWorktrees(paths, date, { run = runGit } = {}) {
  const dir = join(paths.share, 'worktrees', date)
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const removed = []
  for (const name of names) {
    const path = join(dir, name)
    if (dirtyPaths(path, { run }).length) continue
    try {
      run(['worktree', 'remove', path], { cwd: path })
      removed.push(name)
    } catch { /* leave it */ }
  }
  return removed
}

/**
 * The keeper, every two minutes and after boot: rewrites the timers from
 * current.json, runs a dusk or dawn that was missed while the machine was off or
 * a process was killed, and starts night.target if it should run.
 */
export async function keep(paths, m, hooks = {}) {
  const current = readCurrent(paths)
  const now = m.now()
  if (current.phase === 'armed') {
    if (now >= current.start && now < current.end) return dusk(paths, m, hooks)
    if (now >= current.end) return writeCurrent(paths, { ...current, phase: 'idle', missedAt: now })
    await writeTimers(paths, current, m)
    return current
  }
  if (!RUNNING.has(current.phase)) return current
  if (current.phase === 'dusk' && now - (current.duskAt ?? now) > 15 * 60_000) await dusk(paths, m, hooks)
  if (current.phase !== 'day' && now >= current.end) return dawn(paths, m, hooks)
  if (current.phase !== 'day') await writeTimers(paths, current, m)
  await m.systemctl('start', 'night.target')
  const files = nightFiles(paths, current.date)
  const { config } = loadConfig(paths)
  for (let slot = config.sessions + 1; slot <= 4; slot++) await m.systemctl('stop', `night-worker@${slot}.service`)
  const late = staleBeats(readBeats(files), ['medic'], now, 5 * 60_000)
  if (late.length) {
    addEvent(files, 'watcher.restart', { name: 'medic', by: 'keeper' }, now)
    await m.systemctl('restart', 'night-medic.service')
  }
  return current
}

/** Installs every unit night needs. */
export async function install(paths, m, { node, cli, pathEnv }) {
  const { config } = loadConfig(paths)
  const units = buildUnits({ node, cli, sessions: config.sessions, memoryHigh: config.worker.memoryHigh, memoryMax: config.worker.memoryMax, pathEnv, nightHome: process.env.NIGHT_HOME || undefined, nightShare: process.env.NIGHT_SHARE || undefined })
  const changed = writeUnits(paths.units, units)
  await m.systemctl('daemon-reload')
  await m.systemctl('enable', '--now', 'night-keeper.timer')
  return changed
}

export async function uninstall(paths, m) {
  const current = readCurrent(paths)
  if (RUNNING.has(current.phase)) throw new Error('a night is running; stop it first')
  await m.systemctl('disable', '--now', 'night-keeper.timer', ...TIMER_NAMES)
  const names = readdirSync(paths.units).filter((n) => n.startsWith('night'))
  const removed = removeUnits(paths.units, names)
  await m.systemctl('daemon-reload')
  return removed
}

/** One line on the watchers: fine, or which are late. */
export function watcherLines(beats, now, sessions) {
  const names = [...WATCHERS, ...Array.from({ length: sessions }, (_, i) => `worker-${i + 1}`)]
  return names.map((name) => ({ name, ok: !staleBeats(beats, [name], now, 3 * 60_000).length, lastBeat: beats[name]?.at ?? null }))
}

/** Everything the pane shows, as one JSON object (the contract in hooks/register.tsx). */
export function view(paths, m) {
  const now = m.now()
  const { config, problems } = loadConfig(paths)
  const current = readCurrent(paths)
  const date = current.date ?? null
  const files = date ? nightFiles(paths, date) : null
  const queue = date ? readQueue(paths, date) : null
  const workers = []
  for (let slot = 1; slot <= config.sessions; slot++) {
    const ws = files ? readJson(join(files.workers, `${slot}.json`), {}) ?? {} : {}
    workers.push({ slot, state: ws.state ?? 'off', project: ws.project ?? null, item: ws.itemTitle ?? null, since: ws.since ?? null, limitedUntil: ws.limitedUntil ?? null })
  }
  const health = files ? readJson(files.health, null) : null
  const usage = files ? readJson(files.usage, null) : null
  const tokenPath = config.hardware.fans.tokenFile?.replace(/^~(?=\/)/, paths.home) ?? null
  let token = false
  try { token = Boolean(tokenPath && readFileSync(tokenPath, 'utf8').trim()) } catch { token = false }
  const recap = files ? readJson(files.recap, null) : null
  const allProjects = date ? readJson(join(files.dir, 'projects.json'), null)?.projects ?? [] : []
  return {
    version: 1,
    now,
    phase: current.phase,
    date,
    window: config.window,
    armed: current.start ? { start: current.start, end: current.end } : null,
    sessions: config.sessions,
    workers,
    watchers: files && RUNNING.has(current.phase) ? watcherLines(readBeats(files), now, config.sessions) : [],
    queue: queue ? counts(queue) : { open: 0, taken: 0, done: 0, parked: 0, failed: 0 },
    usage: usage ? { fiveHour: usage.fiveHour ?? null, sevenDay: usage.sevenDay ?? null, resetsAt: usage.resetsAt ?? null } : null,
    health: { line: health?.line ?? null, blockers: health?.verdict?.blockers?.length ?? 0 },
    projects: allProjects.map((p) => ({ name: p.name, status: p.status, on: !config.projects.exclude.includes(p.name) && (config.projects.include.length === 0 || config.projects.include.includes(p.name)) })),
    fans: { token, dayMode: Boolean(config.hardware.fans.dayMode), nightMode: Boolean(config.hardware.fans.nightMode), tokenPath },
    recap: recap ? { headline: recap.headline ?? null, projects: (recap.projects ?? []).map((p) => ({ name: p.name, line: p.line ?? '' })), artifactUrl: config.artifact.url } : null,
    problems: [...problems, ...(current.unsafe ?? [])],
  }
}

/** The recap's input for the night, from the queue, the events and git. */
export function recapInput(paths, date, { now, zone }) {
  const { config } = loadConfig(paths)
  const current = readCurrent(paths)
  const files = nightFiles(paths, date)
  const queue = readQueue(paths, date)
  const events = readJsonl(files.events)
  const projects = readJson(join(files.dir, 'projects.json'), null)?.projects ?? []
  const start = current.duskAt ?? current.start ?? now - 8 * 3600_000
  const commits = []
  for (const project of projects) {
    for (const c of commitsSince(project.repo, start)) commits.push({ ...c, project: project.name })
  }
  const touched = new Set([...queue.items.map((i) => i.project), ...commits.map((c) => c.project)])
  const progress = [...touched].map((name) => {
    const p = progressOf(queue, name)
    return { name, ...p, branch: `night/${date}/${name}` }
  })
  const sessions = []
  for (let slot = 1; slot <= config.sessions; slot++) {
    const results = events.filter((e) => e.kind === 'worker.result' && e.slot === slot).map((e) => ({ status: e.outcome, line: e.line }))
    const projectsOfSlot = [...new Set(events.filter((e) => e.kind === 'worker.start' && e.slot === slot).map((e) => e.project))]
    if (!results.length && !projectsOfSlot.length) continue
    const ws = readJson(join(files.workers, `${slot}.json`), {}) ?? {}
    sessions.push({ kind: 'worker', name: `Night ${slot}`, project: projectsOfSlot.join(', '), branch: projectsOfSlot.map((p) => `night/${date}/${p}`).join(', '), results, commits: 0, state: ws.state ?? 'off' })
  }
  const live = readJson(files.sessions, null)?.sessions ?? []
  for (const s of live.filter((x) => x.kind === 'desktop')) {
    const own = commits.filter((c) => c.project === s.project).length
    sessions.push({ kind: 'desktop', name: s.name || 'Desktop session', project: s.project ?? '', branch: s.branch ?? '', results: [], commits: own, state: s.label })
  }
  const needsOwner = []
  for (const item of queue.items.filter((i) => i.status === 'parked')) needsOwner.push(`${item.project}: ${item.result || item.title}`)
  for (const s of live.filter((x) => x.label === 'waiting')) needsOwner.push(`${s.name} waits on ${s.on}`)
  if (current.unsafe?.length) needsOwner.push('workers did not start: the safety check failed')
  if (readJson(files.usage, {})?.loginError) needsOwner.push('Claude Code needs a fresh login')
  const usage = readJson(files.usage, null)
  return {
    date,
    zone,
    window: { start, end: current.end ?? now },
    now,
    phase: current.phase,
    commits,
    projects: progress,
    sessions,
    events,
    needsOwner,
    usage: usage ? { fiveHour: usage.fiveHour ?? null, sevenDay: usage.sevenDay ?? null } : null,
  }
}

export const projectName = (repo) => basename(repo)
