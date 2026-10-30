// `night chaos`: kills each part of a running night on purpose and times how
// long it takes to come back. This is how "bulletproof" is shown, not claimed.
// It acts on the real machine, so it refuses unless a night is running.
import { join } from 'node:path'

import { loadConfig, nightFiles } from './config.mjs'
import { readJson, readJsonl } from './fsx.mjs'
import { readBeats, readCurrent, RUNNING } from './state.mjs'

const SERVICES = ['conductor', 'health', 'logs', 'usage', 'medic']

/** Waits until `check()` is true, polling every second; resolves with the seconds it took, or null. */
async function until(check, { timeoutMs, sleep, now }) {
  const start = now()
  while (now() - start < timeoutMs) {
    if (await check()) return Math.round((now() - start) / 100) / 10
    await sleep(1000)
  }
  return null
}

/** Kills every service and one worker's Claude, stops the target, and reports what came back and how fast. */
export async function chaos(paths, m, { only } = {}) {
  const current = readCurrent(paths)
  if (!RUNNING.has(current.phase)) throw new Error('no night is running')
  const files = nightFiles(paths, current.date)
  const { config } = loadConfig(paths)
  const report = []
  const wait = { sleep: m.sleep, now: m.now }

  for (const name of SERVICES) {
    if (only && !only.includes(name)) continue
    const before = readBeats(files)[name]
    const killedAt = m.now()
    await m.systemctl('kill', '-s', 'SIGKILL', `night-${name}.service`)
    const seconds = await until(() => {
      const beat = readBeats(files)[name]
      return beat && beat.at > killedAt && beat.pid !== before?.pid
    }, { timeoutMs: 120_000, ...wait })
    report.push({ part: `night-${name}`, how: 'SIGKILL', back: seconds !== null, seconds })
  }

  if (!only || only.includes('worker')) {
    for (let slot = 1; slot <= config.sessions; slot++) {
      const ws = readJson(join(files.workers, `${slot}.json`), {})
      if (ws?.state !== 'working' || !ws.childPid) continue
      const killedAt = m.now()
      try { process.kill(-ws.childPid, 'SIGKILL') } catch { try { process.kill(ws.childPid, 'SIGKILL') } catch { /* gone */ } }
      const seconds = await until(() => readJsonl(files.events).some((e) => e.kind === 'worker.start' && e.slot === slot
        && Date.parse(e.at) > killedAt && e.sessionId === ws.sessionId && e.resume === true), { timeoutMs: 180_000, ...wait })
      report.push({ part: `worker ${slot}'s Claude`, how: 'SIGKILL', back: seconds !== null, seconds, note: 'resumed the same session' })
      break
    }
  }

  if (!only || only.includes('target')) {
    const stoppedAt = m.now()
    await m.systemctl('stop', 'night.target')
    const keeperRun = await m.run(['systemctl', '--user', 'start', 'night-keeper.service'], { timeoutMs: 300_000 })
    const seconds = await until(async () => {
      const r = await m.systemctl('is-active', 'night.target')
      return String(r.stdout).trim() === 'active'
    }, { timeoutMs: 180_000, ...wait })
    report.push({ part: 'night.target', how: 'systemctl stop', back: seconds !== null, seconds, note: `brought back by the keeper (exit ${keeperRun.code})`, since: stoppedAt })
  }
  return report
}
