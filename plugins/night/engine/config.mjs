// Where night keeps its files, and the owner's settings. The code carries generic
// defaults only: personal paths, project names and the artifact URL live in the
// owner's config.json, which `night doctor` checks.
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseHHMM } from './clock.mjs'
import { readJson, writeJson } from './fsx.mjs'

/** Every path night uses, from the environment it runs in. */
export function nightPaths({ env = process.env, home = env.HOME || homedir() } = {}) {
  const claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const root = env.NIGHT_HOME || join(claude, 'tacos', 'night')
  return {
    home,
    claude,
    root,
    config: join(root, 'config.json'),
    current: join(root, 'current.json'),
    nights: join(root, 'nights'),
    worktrees: join(root, 'worktrees'),
    sessions: join(claude, 'sessions'),
    transcripts: join(claude, 'projects'),
    usageCache: join(claude, 'tacos', 'usage-cache.json'),
    units: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    runtime: env.XDG_RUNTIME_DIR || join(root, 'run'),
  }
}

/** The files of one night, named by the local date it started on. */
export function nightFiles(paths, date) {
  const dir = join(paths.nights, date)
  return {
    dir,
    queue: join(dir, 'queue.json'),
    queueMd: join(dir, 'queue.md'),
    queueLock: join(dir, 'queue.lock'),
    events: join(dir, 'events.jsonl'),
    workers: join(dir, 'workers'),
    beats: join(dir, 'heartbeats'),
    sessions: join(dir, 'sessions.json'),
    health: join(dir, 'health.json'),
    usage: join(dir, 'usage.json'),
    snapshot: join(dir, 'snapshot.json'),
    recap: join(dir, 'recap.json'),
    recapHtml: join(dir, 'recap.html'),
    streams: join(dir, 'streams'),
  }
}

// The KDE Plasma way to blank every screen; `kscreen-doctor --dpms off` returns 0 and
// leaves them on. On another desktop the owner sets both commands in config.json.
const KDE_SCREENS_OFF = [
  'qdbus-qt6', 'org.kde.kglobalaccel', '/component/org_kde_powerdevil',
  'org.kde.kglobalaccel.Component.invokeShortcut', 'Turn Off Screen',
]

export const DEFAULTS = Object.freeze({
  window: { from: '23:30', to: '07:00' },
  sessions: 2,
  projects: { include: [], exclude: [], order: [] },
  sources: {
    notesDir: null,
    roadmaps: [],
    planGlobs: ['docs/superpowers/plans/*.md', 'docs/plans/*.md', 'PLAN.md', 'TODO.md'],
    openStatuses: ['Doing', 'Planned', 'Paused'],
    excludeAreas: ['Client'],
  },
  protectedBranches: ['main', 'master', 'production', 'prod', 'deploy', 'release', 'gh-pages'],
  hardware: {
    rgb: { off: null, on: null },
    screens: { off: KDE_SCREENS_OFF, on: ['kscreen-doctor', '--dpms', 'on'] },
    power: { profile: 'power-saver' },
    fans: {
      url: 'http://127.0.0.1:11987',
      tokenFile: null,
      dayMode: 'Day',
      nightMode: 'Night',
      pumpChannel: 'fan1',
      pumpMinDuty: 50,
      pumpMinRpm: 1300,
    },
  },
  binaries: { claude: null, node: null },
  models: { worker: null, planner: 'sonnet', publisher: 'haiku' },
  worker: { memoryHigh: '5G', memoryMax: '6G', silentMinutes: 20, itemsPerSession: 6 },
  health: {
    swapBlockPct: 95, psiFullAvg60: 5, diskWarnGb: 8, diskBlockGb: 3, tmpBlockPct: 75, cpuHotC: 85, gpuHotC: 100,
  },
  artifact: { url: null, title: 'Night recap' },
})

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `over` laid onto `base`: objects merge key by key, anything else replaces. */
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value)
  return out
}

/** The problems with a config, as sentences. Empty when it is usable. */
export function validate(config) {
  const problems = []
  for (const key of ['from', 'to']) {
    try { parseHHMM(config.window?.[key]) } catch { problems.push(`window.${key} is not HH:MM`) }
  }
  if (config.window?.from === config.window?.to) problems.push('window.from and window.to are the same time')
  if (!Number.isInteger(config.sessions) || config.sessions < 1 || config.sessions > 4) {
    problems.push('sessions is not a whole number from 1 to 4')
  }
  for (const key of ['include', 'exclude', 'order']) {
    if (!Array.isArray(config.projects?.[key])) problems.push(`projects.${key} is not a list`)
  }
  if (!Array.isArray(config.protectedBranches)) problems.push('protectedBranches is not a list')
  const fans = config.hardware?.fans ?? {}
  if (!(fans.pumpMinDuty >= 50)) problems.push('hardware.fans.pumpMinDuty is under 50: the pump stalls near 41 %')
  return problems
}

/** The config on disk over the defaults, and what is wrong with it. Never throws. */
export function loadConfig(paths) {
  const stored = readJson(paths.config, {})
  const config = merge(structuredClone(DEFAULTS), isObject(stored) ? stored : {})
  return { config, problems: validate(config) }
}

/** Lays `change` over the stored config and saves it, refusing a change that breaks it. */
export function saveConfig(paths, change) {
  const stored = readJson(paths.config, {})
  const next = merge(isObject(stored) ? stored : {}, change)
  const problems = validate(merge(structuredClone(DEFAULTS), next))
  if (problems.length) throw new Error(problems.join('; '))
  writeJson(paths.config, next)
  return merge(structuredClone(DEFAULTS), next)
}
