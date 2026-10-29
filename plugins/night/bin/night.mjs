#!/usr/bin/env node
// `night <command>`: the one entry point for the pane, the systemd units and a
// terminal. Commands the pane uses print one JSON object; the services never
// return. Inside a night worker (NIGHT_WORKER=1) every command that changes the
// night is refused, so a worker on this very repo cannot stop or rearm it.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { localTime } from '../engine/clock.mjs'
import { loadConfig, nightFiles, nightPaths, saveConfig } from '../engine/config.mjs'
import { readJson, writeJson, writeText } from '../engine/fsx.mjs'
import { arm, canary, dawn, disarm, dusk, install, keep, machine, recapInput, requestStop, stop, uninstall, view } from '../engine/night.mjs'
import { conductorTurn, healthTurn, logsTurn, medicTurn, serviceLoop, usageTurn } from '../engine/services.mjs'
import { readCurrent } from '../engine/state.mjs'
import { liveDeps, workerLoop } from '../engine/worker.mjs'
import { chaos } from '../engine/chaos.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = join(HERE, 'guard.mjs')
const SELF = join(HERE, 'night.mjs')
const READ_ONLY = new Set(['view', 'status', 'doctor', 'help'])

/** The newest Claude Code binary on this machine: the desktop app's own copies, then PATH. */
export function findClaude(home, env = process.env) {
  const root = join(home, '.config', 'Claude', 'claude-code')
  const found = []
  try {
    for (const version of readdirSync(root)) {
      for (const build of readdirSync(join(root, version))) {
        const path = join(root, version, build, 'claude')
        if (existsSync(path)) found.push({ version: version.split('.').map(Number), path })
      }
    }
  } catch { /* no desktop app */ }
  found.sort((a, b) => {
    for (let i = 0; i < 3; i++) if ((a.version[i] ?? 0) !== (b.version[i] ?? 0)) return (b.version[i] ?? 0) - (a.version[i] ?? 0)
    return 0
  })
  if (found.length) return found[0].path
  const which = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8', env })
  return which.status === 0 ? which.stdout.trim() : null
}

/**
 * Runs Claude with argv and resolves with stdout (planner and publisher calls).
 * Asynchronous on purpose: a blocking call would stop the service's heartbeat and
 * its SIGTERM handler for minutes.
 */
function callClaude(claude, cwd, { timeoutMs = 6 * 60_000 } = {}) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !out) reject(new Error((err || `claude exited ${code}`).slice(-500)))
      else resolve(out)
    })
  })
}

/** Writes the recap for the night, and publishes it when asked. */
async function makeRecap(paths, m, { publish = false } = {}) {
  const current = readCurrent(paths)
  if (!current.date) return null
  const files = nightFiles(paths, current.date)
  const { buildRecap } = await import('../engine/recap/data.mjs')
  const { renderPage } = await import('../engine/recap/page.mjs')
  const recap = buildRecap(recapInput(paths, current.date, { now: m.now(), zone: m.zone }))
  writeJson(files.recap, recap)
  writeText(files.recapHtml, renderPage(recap))
  const { config } = loadConfig(paths)
  if (config.recapCopyDir) {
    const dir = join(config.recapCopyDir.replace(/^~(?=\/)/, paths.home), current.date)
    mkdirSync(dir, { recursive: true })
    copyFileSync(files.recapHtml, join(dir, 'recap.html'))
  }
  if (publish && config.artifact.publish) await publishRecap(paths, files, config)
  return recap
}

/** Publishes recap.html to the owner's private artifact with a headless Claude that has only the Artifact tool. */
async function publishRecap(paths, files, config) {
  const claude = config.binaries.claude || findClaude(paths.home)
  if (!claude) return null
  const url = config.artifact.url
  const prompt = url
    ? `Read the local file ${files.recapHtml} with the Read tool. Then, with the Artifact tool, read the artifact ${url} (action "read") and publish the local file ${files.recapHtml} to that same artifact (action "publish", file_path "${files.recapHtml}", url "${url}"). Reply with only the artifact URL.`
    : `Read the local file ${files.recapHtml} with the Read tool. Then publish it with the Artifact tool as a new artifact (action "publish", file_path "${files.recapHtml}", icon "moon", description "What the night's Claude Code sessions did, project by project"). Reply with only the artifact URL.`
  // Read too: the Artifact tool wants the page read before it is published. Nothing else: the page holds text workers wrote.
  const args = ['-p', prompt, '--model', config.models.publisher, '--tools', 'Artifact,Read', '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config', '--setting-sources', 'local', '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--output-format', 'json']
  try {
    const out = JSON.parse(await callClaude(claude, files.dir)(args))
    const found = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/.exec(String(out.result ?? ''))
    if (found && found[0] !== url) saveConfig(paths, { artifact: { url: found[0] } })
    return found?.[0] ?? null
  } catch {
    return null
  }
}

function human(v) {
  const t = (ms) => (ms ? localTime(ms, machine().zone) : '?')
  const lines = [`Night mode: ${v.phase}${v.armed ? `, ${t(v.armed.start)} to ${t(v.armed.end)}` : ''} (window ${v.window.from} to ${v.window.to}, ${v.sessions} sessions)`]
  for (const w of v.workers) lines.push(`  worker ${w.slot}: ${w.state}${w.project ? `, ${w.project}` : ''}${w.item ? `: ${w.item}` : ''}`)
  lines.push(`  queue: ${v.queue.open} open, ${v.queue.taken} taken, ${v.queue.done} done, ${v.queue.parked} parked, ${v.queue.failed} failed`)
  if (v.health.line) lines.push(`  health: ${v.health.line}`)
  for (const p of v.problems) lines.push(`  problem: ${p}`)
  return lines.join('\n')
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv
  const paths = nightPaths({ env })
  const m = machine({ env })
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  if (env.NIGHT_WORKER === '1' && !READ_ONLY.has(command)) {
    out({ ok: false, error: 'night commands that change the night are refused inside a night worker' })
    return 1
  }
  const recap = (p, mm) => makeRecap(p, mm, { publish: true })
  const act = async (fn) => {
    try {
      await fn()
      out({ ok: true, view: view(paths, m) })
      return 0
    } catch (err) {
      out({ ok: false, error: String(err?.message ?? err) })
      return 1
    }
  }
  switch (command) {
    case 'view': out(view(paths, m)); return 0
    case 'status': process.stdout.write(`${human(view(paths, m))}\n`); return 0
    case 'set': return act(() => saveConfig(paths, { window: { from: rest[0], to: rest[1] } }))
    case 'sessions': return act(async () => {
      saveConfig(paths, { sessions: Number(rest[0]) })
      if (existsSync(join(paths.units, 'night.target'))) await install(paths, m, installArgs(env))
    })
    case 'project': return act(() => {
      const { config } = loadConfig(paths)
      const on = rest[1] !== 'off'
      const exclude = config.projects.exclude.filter((n) => n !== rest[0])
      if (!on) exclude.push(rest[0])
      const include = config.projects.include.length && on ? [...new Set([...config.projects.include, rest[0]])] : config.projects.include.filter((n) => on || n !== rest[0])
      saveConfig(paths, { projects: { exclude, include } })
    })
    case 'arm': return act(async () => { await ensureInstalled(paths, m, env); await arm(paths, m) })
    case 'start': return act(async () => { await ensureInstalled(paths, m, env); await arm(paths, m, { startNow: true }) })
    case 'disarm': return act(() => disarm(paths, m))
    case 'stop': return act(() => (existsSync(join(paths.units, 'night-stop.service')) ? requestStop(paths, m) : stop(paths, m, { recap })))
    case 'stop-now': await stop(paths, m, { recap }); return 0
    case 'dusk': await dusk(paths, m, { guard: GUARD }); return 0
    case 'dawn': await dawn(paths, m, { recap }); return 0
    case 'keep': await keep(paths, m, { guard: GUARD, recap }); return 0
    case 'recap': out(await makeRecap(paths, m, { publish: rest[0] === '--publish' })); return 0
    case 'canary': {
      const scratch = join(paths.share, 'scratch', 'canary')
      writeText(join(scratch, '.keep'), '')
      const problems = await canary({ node: process.execPath, guard: GUARD, scratch })
      out({ ok: problems.length === 0, problems })
      return problems.length ? 1 : 0
    }
    case 'chaos':
      try {
        out({ ok: true, report: await chaos(paths, m, { only: rest.length ? rest : undefined }) })
        return 0
      } catch (err) {
        out({ ok: false, error: String(err?.message ?? err) })
        return 1
      }
    case 'install': out({ ok: true, changed: await install(paths, m, installArgs(env)) }); return 0
    case 'uninstall': out({ ok: true, removed: await uninstall(paths, m) }); return 0
    case 'doctor': out(doctor(paths, env)); return 0
    case 'worker': {
      const slot = Number(rest[0])
      const claude = () => loadConfig(paths).config.binaries.claude || findClaude(paths.home, env)
      const deps = liveDeps({ claude, node: process.execPath, guard: GUARD, env })
      await workerLoop(slot, { paths, deps })
      return 0
    }
    case 'run': {
      const { config } = loadConfig(paths)
      const claude = config.binaries.claude || findClaude(paths.home, env)
      const plannerCwd = join(paths.share, 'scratch', 'planner')
      mkdirSync(plannerCwd, { recursive: true })
      const turns = {
        conductor: [conductorTurn(paths, m, { call: callClaude(claude, plannerCwd) }), 60_000],
        health: [healthTurn(paths, m), 30_000],
        logs: [logsTurn(paths, m), 30_000],
        usage: [usageTurn(paths, m), 60_000],
        medic: [medicTurn(paths, m), 60_000],
      }
      const chosen = turns[rest[0]]
      if (!chosen) throw new Error(`unknown service: ${rest[0]}`)
      await serviceLoop(rest[0], chosen[0], { paths, intervalMs: chosen[1] })
      return 0
    }
    default:
      process.stdout.write('usage: night view|status|set FROM TO|sessions N|project NAME on|off|arm|disarm|start|stop|recap [--publish]|canary|install|uninstall|doctor\n')
      return command === 'help' ? 0 : 2
  }
}

/** Installs the units first if they are not there, so Arm works on a fresh machine. */
async function ensureInstalled(paths, m, env) {
  if (!existsSync(join(paths.units, 'night.target'))) await install(paths, m, installArgs(env))
}

function installArgs(env) {
  return { node: process.execPath, cli: SELF, pathEnv: env.PATH || '/usr/local/bin:/usr/bin:/bin' }
}

/** What is set up and what is missing, in plain sentences. */
export function doctor(paths, env) {
  const { config, problems } = loadConfig(paths)
  const notes = []
  const claude = config.binaries.claude || findClaude(paths.home, env)
  notes.push(claude ? `Claude Code: ${claude}` : 'Claude Code: not found')
  notes.push(config.sources.notesDir ? `Project notes: ${config.sources.notesDir}` : 'Project notes: not set (sources.notesDir), so no projects are found')
  notes.push(`Roadmaps: ${config.sources.roadmaps.length}`)
  notes.push(config.hardware.rgb.off ? 'RGB: set' : 'RGB: not set, skipped')
  notes.push(config.hardware.fans.tokenFile ? `Fans: token file ${config.hardware.fans.tokenFile}` : 'Fans: no CoolerControl token file set, skipped')
  notes.push(existsSync(join(paths.units, 'night.target')) ? 'Units: installed' : 'Units: not installed (night install)')
  notes.push(`Sessions: ${config.sessions}, window ${config.window.from} to ${config.window.to}`)
  return { ok: problems.length === 0 && Boolean(claude), problems, notes, current: readJson(paths.current, null) }
}

let isMain = false
try { isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { isMain = false }
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    process.stderr.write(`${err?.stack ?? err}\n`)
    process.exitCode = 1
  })
}
