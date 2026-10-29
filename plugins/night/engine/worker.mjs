// One night worker: a loop that takes items from the queue and runs a headless
// Claude Code session on each, in its own worktree, until the night is stopped.
//
// It can be killed at any moment. Its state lives in workers/<slot>.json and the
// queue, so a restart picks up the item it held and resumes the same Claude
// session. Effects come in through `deps`, so tests drive it with a fake Claude.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { backoffMs, itemPrompt, readRun, workerArgs, workerEnv, workerSettings } from './claude.mjs'
import { loadConfig, nightFiles } from './config.mjs'
import { appendJsonl, readJson, writeJson } from './fsx.mjs'
import { dirtyPaths, ensureWorktree, runGit } from './git.mjs'
import { claim, heldBy, heldByOthers, pickItem, readQueue, releaseSlot, settle, withQueue } from './queue.mjs'
import { addEvent, beat, readCurrent, RUNNING } from './state.mjs'

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Where a worker's files are on disk. */
export function workerPaths(paths, files, date, slot, project) {
  const share = paths.share ?? join(paths.home, '.local', 'share', 'night')
  return {
    state: join(files.workers, `${slot}.json`),
    stream: join(files.streams, `${slot}.jsonl`),
    worktree: project ? join(share, 'worktrees', date, project) : null,
    scratch: join(share, 'scratch', date, String(slot)),
    settings: join(files.dir, 'worker-settings.json'),
    decisions: join(files.dir, 'decisions.md'),
    testLock: join(paths.runtime, 'night-tests.lock'),
  }
}

/** Projects a desktop session holds right now: busy, waiting on a dialog, limited or hung. */
export function desktopHeld(files) {
  const sessions = readJson(files.sessions, null)
  const held = new Set()
  for (const s of sessions?.sessions ?? []) {
    if (s.kind === 'desktop' && s.project && ['working', 'waiting', 'limited', 'hung'].includes(s.label)) held.add(s.project)
  }
  return held
}

const isPaused = (files, slot) => (readJson(join(files.dir, 'paused.json'), {})?.slots ?? []).includes(slot)
const blockers = (files) => readJson(files.health, {})?.verdict?.blockers?.length ?? 0
const loginBlocked = (files) => readJson(files.usage, {})?.loginError === true

/** Clears a git index lock older than two minutes: a kill during a commit leaves one behind. */
export function clearStaleIndexLock(worktree, { now = Date.now() } = {}) {
  let gitDir = join(worktree, '.git')
  try {
    const pointer = readFileSync(gitDir, 'utf8')
    if (pointer.startsWith('gitdir:')) gitDir = pointer.slice(7).trim()
  } catch { /* a folder, not a pointer file */ }
  const lock = join(gitDir, 'index.lock')
  try {
    if (now - statSync(lock).mtimeMs > 120_000) rmSync(lock, { force: true })
  } catch { /* no lock */ }
}

/**
 * Runs Claude once and resolves with its stream lines and exit. While it runs,
 * `watch` is called every few seconds and may return a reason to stop it.
 */
export function runClaude({ claude, args, cwd, env, streamPath, watch, onLine, intervalMs = 5000 }) {
  return new Promise((resolve) => {
    const lines = []
    let buffer = ''
    let lastOutput = Date.now()
    let stopping = null
    const child = spawn(claude, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal) } catch { /* gone */ }
    }
    child.stdout.on('data', (chunk) => {
      lastOutput = Date.now()
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!raw.trim()) continue
        try {
          const line = JSON.parse(raw)
          lines.push(line)
          onLine?.(line)
        } catch { /* not JSON */ }
        try { appendJsonl(streamPath, raw.length > 4000 ? { cut: raw.slice(0, 4000) } : JSON.parse(raw)) } catch { /* best effort */ }
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    const timer = setInterval(() => {
      if (stopping) return
      const reason = watch?.({ lastOutput })
      if (reason) {
        stopping = reason
        killGroup('SIGTERM')
        setTimeout(() => killGroup('SIGKILL'), 10_000).unref()
      }
    }, intervalMs)
    const stopNow = () => {
      if (stopping) return
      stopping = 'stop'
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref()
    }
    process.once('SIGTERM', stopNow)
    child.on('error', (err) => { stderr += String(err) })
    child.on('close', (code, signal) => {
      clearInterval(timer)
      process.removeListener('SIGTERM', stopNow)
      resolve({ lines, exitCode: code, signal: signal ?? (stopping ? 'SIGTERM' : null), stopping, stderr, pid: child.pid })
    })
  })
}

/** Commits whatever a stopped worker left in its worktree, so nothing is lost. */
export function commitLeftovers(worktree, note, { run = runGit } = {}) {
  if (!worktree || !existsSync(worktree) || dirtyPaths(worktree, { run }).length === 0) return false
  try {
    run(['add', '-A'], { cwd: worktree })
    run(['-c', 'user.useConfigOnly=false', 'commit', '-q', '-m', `night: work in progress at ${note}`], { cwd: worktree })
    return true
  } catch {
    return false
  }
}

/**
 * One turn of the worker loop: decides what to do now, does it, and returns how
 * long to wait before the next turn. Exported for tests; `workerLoop` repeats it.
 */
export async function workerTurn(slot, { paths, deps }) {
  const now = deps.now()
  const current = readCurrent(paths)
  if (!RUNNING.has(current.phase)) return { wait: 30_000, state: 'off' }
  const files = nightFiles(paths, current.date)
  const { config } = loadConfig(paths)
  const wp = workerPaths(paths, files, current.date, slot)
  const ws = readJson(wp.state, {}) ?? {}
  const save = (change) => writeJson(wp.state, { ...(readJson(wp.state, {}) ?? {}), ...change, slot, at: deps.now() })
  const idle = (state, wait, extra = {}) => {
    save({ state, ...extra })
    beat(files, `worker-${slot}`, { state }, now)
    return { wait, state }
  }

  if (slot > config.sessions) return idle('off', 60_000)
  if (isPaused(files, slot)) return idle('paused', 15_000)
  if (blockers(files) > 0) return idle('blocked', 30_000)
  if (loginBlocked(files)) return idle('login', 60_000)
  if ((ws.limitedUntil ?? 0) > now) return idle('limited', Math.min(60_000, ws.limitedUntil - now), { limitedUntil: ws.limitedUntil })
  if ((ws.backoffUntil ?? 0) > now) return idle('backoff', Math.min(60_000, ws.backoffUntil - now))

  const desktop = desktopHeld(files)
  const item = await withQueue(paths, current.date, (q) => {
    const held = heldBy(q, slot)
    if (held) return { queue: q, result: held }
    const next = pickItem(q, { slot, busy: new Set([...heldByOthers(q, slot), ...desktop]), prefer: ws.sessionProject })
    return next ? { queue: claim(q, next.id, { slot, now }), result: next } : { queue: q, result: null }
  })
  if (!item) return idle('waiting for work', 30_000)

  const branch = `night/${current.date}/${item.project}`
  const place = workerPaths(paths, files, current.date, slot, item.project)
  mkdirSync(join(place.scratch, 'tmp'), { recursive: true })
  try {
    deps.ensureWorktree(item.repo, place.worktree, branch, item.base)
    clearStaleIndexLock(place.worktree, { now })
  } catch (err) {
    addEvent(files, 'worker.worktree-failed', { slot, item: item.id, error: String(err.message ?? err).slice(0, 300) }, now)
    await withQueue(paths, current.date, (q) => ({ queue: settle(q, item.id, { outcome: 'crash', line: 'could not make the worktree', now }) }))
    return idle('error', 60_000)
  }
  writeJson(place.settings, workerSettings({ node: deps.node, guard: deps.guard }))

  const sameSession = ws.sessionId && ws.sessionProject === item.project && (ws.itemsInSession ?? 0) < config.worker.itemsPerSession
  const continuing = sameSession && ws.itemId === item.id ? ws.interrupted ?? 'a restart' : null
  const sessionId = sameSession ? ws.sessionId : deps.uuid()
  const resume = Boolean(sameSession && ws.sessionStarted)
  const prompt = itemPrompt(item, { branch, resumed: resume && !continuing, continuing })
  const env = workerEnv(deps.env, {
    slot,
    worktree: place.worktree,
    scratch: place.scratch,
    protectedBranches: config.protectedBranches,
    testLock: place.testLock,
    events: files.events,
    decisions: place.decisions,
    secrets: config.worker.secrets ?? [],
  })
  const addDirs = [place.scratch, ...(config.worker.cacheDirs ?? []).map((d) => d.replace(/^~(?=\/)/, paths.home))]
  const args = workerArgs({
    prompt, sessionId, resume, model: config.models.worker, settingsPath: place.settings, addDirs, name: `Night ${slot} · ${item.project}`,
  })
  save({
    state: 'working', project: item.project, itemId: item.id, itemTitle: item.title, sessionId, sessionProject: item.project,
    sessionStarted: true, since: now, interrupted: 'a restart',
  })
  addEvent(files, 'worker.start', { slot, item: item.id, project: item.project, title: item.title, sessionId, resume }, now)

  const silentMs = config.worker.silentMinutes * 60_000
  const beatTimer = setInterval(() => beat(files, `worker-${slot}`, { state: 'working', item: item.id }), 30_000)
  beat(files, `worker-${slot}`, { state: 'working', item: item.id }, now)
  const run = await deps.runClaude({
    claude: typeof deps.claude === 'function' ? deps.claude() : deps.claude,
    args,
    cwd: place.worktree,
    env,
    streamPath: wp.stream,
    watch: ({ lastOutput }) => {
      if (isPaused(files, slot)) return 'paused'
      if (!RUNNING.has(readCurrent(paths).phase)) return 'stop'
      if (deps.now() - lastOutput > silentMs) return 'silent'
      return null
    },
  })
  clearInterval(beatTimer)
  const end = deps.now()
  const outcome = readRun(run.lines, { exitCode: run.exitCode, signal: run.signal })
  const realSession = outcome.sessionId ?? sessionId

  if (run.stopping === 'stop' || run.stopping === 'paused') {
    const note = run.stopping === 'stop' ? 'stop' : 'a memory pause'
    const saved = commitLeftovers(place.worktree, note)
    await withQueue(paths, current.date, (q) => ({ queue: releaseSlot(q, slot, end) }))
    addEvent(files, 'worker.interrupted', { slot, item: item.id, why: run.stopping, committed: saved }, end)
    save({ state: run.stopping === 'stop' ? 'stopped' : 'paused', sessionId: realSession, interrupted: note })
    return { wait: 5_000, state: run.stopping }
  }

  if (outcome.stop === 'limit') {
    const until = (outcome.limit?.resetsAt ?? deps.limitResetsAt?.() ?? end + 15 * 60_000) + 60_000
    addEvent(files, 'limit.hit', { slot, item: item.id, until: new Date(until).toISOString() }, end)
    save({ state: 'limited', limitedUntil: until, sessionId: realSession, interrupted: 'a usage limit, which has reset now' })
    return { wait: 5_000, state: 'limited' }
  }
  if (outcome.stop === 'login') {
    writeJson(files.usage, { ...(readJson(files.usage, {}) ?? {}), loginError: true, at: end })
    addEvent(files, 'worker.login-error', { slot, text: outcome.text.slice(-300) }, end)
    save({ state: 'login', sessionId: realSession })
    return { wait: 60_000, state: 'login' }
  }
  if (outcome.stop === 'transient') {
    const step = (ws.backoffStep ?? 0)
    save({ state: 'backoff', backoffUntil: end + backoffMs(step), backoffStep: step + 1, sessionId: realSession, interrupted: 'a passing API error' })
    await withQueue(paths, current.date, (q) => ({ queue: settle(q, item.id, { outcome: 'transient', line: 'API error, will retry', now: end, sessionId: realSession }) }))
    addEvent(files, 'worker.backoff', { slot, item: item.id, step, text: outcome.text.slice(-200) }, end)
    return { wait: 5_000, state: 'backoff' }
  }
  if (outcome.stop === 'result' && outcome.parsed) {
    const { outcome: result, line } = outcome.parsed
    await withQueue(paths, current.date, (q) => ({ queue: settle(q, item.id, { outcome: result, line, now: end, sessionId: realSession }) }))
    addEvent(files, 'worker.result', { slot, item: item.id, project: item.project, outcome: result, line, cost: outcome.cost }, end)
    save({
      state: 'between items', sessionId: realSession, sessionProject: item.project, itemId: null,
      itemsInSession: (sameSession ? ws.itemsInSession ?? 0 : 0) + 1, backoffStep: 0, interrupted: null,
    })
    return { wait: 2_000, state: 'done' }
  }
  // Ended without a result line, crashed, went silent or was killed from outside.
  const why = run.stopping === 'silent' ? 'silent too long' : outcome.stop === 'result' ? 'no result line' : `exit ${run.exitCode ?? run.signal}`
  await withQueue(paths, current.date, (q) => ({
    queue: settle(q, item.id, { outcome: outcome.stop === 'result' ? 'partial' : 'crash', line: why, now: end, sessionId: realSession }),
  }))
  addEvent(files, 'worker.retry', { slot, item: item.id, why, stderr: run.stderr?.slice(-300) }, end)
  save({ state: 'retrying', sessionId: realSession, interrupted: why })
  return { wait: 10_000, state: 'retry' }
}

/** The worker service: turns forever. A SIGTERM between runs ends it at once. */
export async function workerLoop(slot, { paths, deps }) {
  let stopping = false
  process.once('SIGTERM', () => { stopping = true })
  while (!stopping) {
    let wait = 30_000
    try {
      ;({ wait } = await workerTurn(slot, { paths, deps }))
    } catch (err) {
      const current = readCurrent(paths)
      if (current.date) addEvent(nightFiles(paths, current.date), 'worker.error', { slot, error: String(err?.stack ?? err).slice(0, 500) })
    }
    const until = Date.now() + wait
    while (!stopping && Date.now() < until) await sleepFor(Math.min(1000, until - Date.now()))
  }
}

/** The real effects a worker uses. */
export function liveDeps({ claude, node, guard, env = process.env }) {
  return {
    now: Date.now,
    uuid: randomUUID,
    env,
    claude,
    node,
    guard,
    ensureWorktree: (repo, path, branch, base) => ensureWorktree(repo, path, branch, base),
    runClaude,
  }
}
