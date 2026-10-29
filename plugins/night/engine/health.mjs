// What the health watcher knows: the readings of the machine and what they mean.
//
// The parsers, `verdict` and `pausePlan` are pure: text or numbers in, numbers or a
// decision out. `sampleHealth` and `runCommand` are the only parts that touch the
// machine, and every reader is injectable. A reader that fails gives null for its
// fields and never throws, because a watcher that dies on a missing sensor is blind
// exactly when the night needs it.
import { spawnSync } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'

import { DEFAULTS } from './config.mjs'

const GB = 1e9
const PAUSE_EVERY_MS = 120_000
const RESUME_AFTER_CLEAR_MS = 120_000

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** `/proc/meminfo` as bytes. What the text lacks is null. */
export function parseMeminfo(text) {
  const kb = {}
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB\s*$/.exec(line)
    if (m) kb[m[1]] = Number(m[2]) * 1024
  }
  return {
    memTotal: kb.MemTotal ?? null,
    memAvailable: kb.MemAvailable ?? null,
    swapTotal: kb.SwapTotal ?? null,
    swapFree: kb.SwapFree ?? null,
  }
}

/** `/proc/pressure/memory`: the `some` and `full` lines, or null for a line the kernel did not write. */
export function parsePsi(text) {
  const out = { some: null, full: null }
  for (const line of String(text ?? '').split('\n')) {
    const kind = line.split(' ')[0]
    if (kind !== 'some' && kind !== 'full') continue
    const f = {}
    for (const [, key, value] of line.matchAll(/(\w+)=([\d.]+)/g)) f[key] = Number(value)
    if ([f.avg10, f.avg60, f.avg300, f.total].every(isNum)) {
      out[kind] = { avg10: f.avg10, avg60: f.avg60, avg300: f.avg300, total: f.total }
    }
  }
  return out
}

// The first temperature in a feature: `temp1_input`, `temp2_input` and so on.
function reading(feature) {
  if (feature === null || typeof feature !== 'object') return null
  const key = Object.keys(feature).find((k) => /^temp\d+_input$/.test(k))
  return key !== undefined && isNum(feature[key]) ? feature[key] : null
}

const chipsLike = (sensors, prefix) => Object.entries(sensors).filter(([name, chip]) => (
  name.startsWith(prefix) && chip !== null && typeof chip === 'object'
)).map(([, chip]) => chip)

/** `sensors -j` (text or already parsed): the CPU control temperature and the GPU junction and edge. */
export function parseSensors(json) {
  let sensors = json
  if (typeof json === 'string') {
    try { sensors = JSON.parse(json) } catch { sensors = null }
  }
  if (sensors === null || typeof sensors !== 'object') sensors = {}
  const firstOf = (chips, feature) => {
    for (const chip of chips) {
      const value = reading(chip[feature])
      if (value !== null) return value
    }
    return null
  }
  const gpus = chipsLike(sensors, 'amdgpu-')
  return {
    cpuC: firstOf(chipsLike(sensors, 'k10temp-'), 'Tctl') ?? firstOf(chipsLike(sensors, 'coretemp-'), 'Package id 0'),
    gpuJunctionC: firstOf(gpus, 'junction'),
    gpuEdgeC: firstOf(gpus, 'edge'),
  }
}

/** Runs `argv` and returns what it printed. Throws when it cannot start, times out or fails. */
export function runCommand(argv, { timeoutMs = 10_000 } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${argv[0]} exited with ${r.status}`)
  return r.stdout
}

const attempt = (fn) => {
  try { return fn() } catch { return null }
}

/** One reading of the machine. A reader that fails leaves its fields null. */
export function sampleHealth({
  readFile = readFileSync, statfs = statfsSync, run = runCommand, home = process.env.HOME || homedir(), now = Date.now(),
} = {}) {
  const mem = attempt(() => parseMeminfo(readFile('/proc/meminfo', 'utf8'))) ?? parseMeminfo('')
  const psi = attempt(() => parsePsi(readFile('/proc/pressure/memory', 'utf8')))
  const disk = attempt(() => statfs(home))
  const tmp = attempt(() => statfs('/tmp'))
  const temps = attempt(() => parseSensors(run(['sensors', '-j']))) ?? parseSensors(null)
  return {
    at: now,
    ...mem,
    psiFullAvg10: psi?.full?.avg10 ?? null,
    psiFullAvg60: psi?.full?.avg60 ?? null,
    diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
    tmpUsedPct: tmp?.blocks > 0 ? ((tmp.blocks - tmp.bfree) * 100) / tmp.blocks : null,
    cpuC: temps.cpuC,
    gpuJunctionC: temps.gpuJunctionC,
  }
}

/**
 * What a sample means. A blocker stops new work and pauses workers; thrash pauses
 * them too; `blockTests` holds back heavy test runs; `hot` asks for the Day fan mode.
 * A reading that is missing never complains.
 */
export function verdict(sample, thresholds = DEFAULTS.health) {
  const t = { ...DEFAULTS.health, ...thresholds }
  const blockers = []
  const warnings = []
  let thrash = false
  let blockTests = false
  let hot = false
  let tight = false

  if (isNum(sample.swapTotal) && sample.swapTotal > 0 && isNum(sample.swapFree)) {
    const used = ((sample.swapTotal - sample.swapFree) * 100) / sample.swapTotal
    if (used > t.swapBlockPct) {
      // Full swap with little RAM left is the 1 October thrash: nothing new may start.
      // Full swap with plenty of RAM is only cold pages that stay until their owners
      // exit; workers cannot swap (MemorySwapMax=0), so the night goes on with one.
      const avail = isNum(sample.memAvailable) ? sample.memAvailable : null
      const text = `Swap is ${Math.round(used)} % full`
      if (avail === null || avail < t.memAvailBlockGb * GB) {
        blockers.push({ code: 'swap-full', text: `${text} and ${avail === null ? 'free RAM is unknown' : `only ${(avail / GB).toFixed(1)} GB of RAM is free`}.` })
      } else {
        tight = true
        warnings.push({ code: 'swap-full', text: `${text}, with ${(avail / GB).toFixed(1)} GB of RAM free: one worker at a time.` })
      }
    }
  }

  if (isNum(sample.psiFullAvg60) && sample.psiFullAvg60 > t.psiFullAvg60) {
    thrash = true
    warnings.push({
      code: 'thrash',
      text: `Memory is thrashing: tasks stalled on it for ${sample.psiFullAvg60.toFixed(1)} % of the last minute.`,
    })
  }

  if (isNum(sample.diskFreeBytes)) {
    const free = (sample.diskFreeBytes / GB).toFixed(1)
    if (sample.diskFreeBytes < t.diskBlockGb * GB) {
      blockers.push({ code: 'disk-full', text: `Only ${free} GB are free on the disk.` })
    } else if (sample.diskFreeBytes < t.diskWarnGb * GB) {
      warnings.push({ code: 'disk-low', text: `Only ${free} GB are free on the disk.` })
    }
  }

  if (isNum(sample.tmpUsedPct) && sample.tmpUsedPct > t.tmpBlockPct) {
    blockTests = true
    warnings.push({ code: 'tmp-full', text: `/tmp is ${Math.round(sample.tmpUsedPct)} % full, so heavy tests wait.` })
  }

  const heat = []
  if (isNum(sample.cpuC) && sample.cpuC > t.cpuHotC) heat.push(`CPU is at ${Math.round(sample.cpuC)} °C.`)
  if (isNum(sample.gpuJunctionC) && sample.gpuJunctionC > t.gpuHotC) {
    heat.push(`GPU junction is at ${Math.round(sample.gpuJunctionC)} °C.`)
  }
  if (heat.length) {
    hot = true
    warnings.push({ code: 'hot', text: heat.join(' ') })
  }

  return { blockers, warnings, thrash, blockTests, hot, tight }
}

// The element with the highest `key`; the later one wins a tie.
const largest = (list, key) => list.reduce((best, item) => (item[key] >= best[key] ? item : best))

/**
 * Whether to pause or resume one worker now. Freezing frees no memory (zram pages
 * stay in RAM), so under a blocker or thrash the worker using the most memory is
 * paused: it ends its Claude run and everything under it. Down to none if it
 * lasts. Once the verdict has been clear for two minutes the most recently paused
 * one resumes. One move every two minutes either way. `clearSince` is when the
 * verdict last turned clear; null means it is not known to be clear.
 */
export function pausePlan({ verdict: v, workers, paused, lastActionAt, clearSince, now }) {
  const nothing = { action: 'none', slot: null }
  if (isNum(lastActionAt) && now - lastActionAt < PAUSE_EVERY_MS) return nothing
  if (v.blockers.length > 0 || v.thrash) {
    return workers.length > 0 ? { action: 'pause', slot: largest(workers, 'bytes').slot } : nothing
  }
  if (paused.length > 0 && isNum(clearSince) && now - clearSince >= RESUME_AFTER_CLEAR_MS) {
    return { action: 'resume', slot: largest(paused, 'pausedAt').slot }
  }
  return nothing
}
