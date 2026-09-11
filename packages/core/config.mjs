import { homedir } from 'node:os'
import { join } from 'node:path'

const MODES = new Set(['enforce', 'dry-run', 'off'])

export const DEFAULTS = Object.freeze({
  gauges: {
    five_hour:   { soft: 75, hard: 90 },
    seven_day:   { soft: 60, hard: 80 },
    extra_usage: { soft: 70, hard: 85 },
    scoped:      { enabled: false },
  },
  mode: 'enforce',
})

export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Pure. Later arguments win, per gauge and per key. */
export function mergeConfig(userConfig, sessionConfig) {
  const gauges = {}
  for (const name of Object.keys(DEFAULTS.gauges)) {
    gauges[name] = {
      ...DEFAULTS.gauges[name],
      ...(isObj(userConfig?.gauges?.[name]) ? userConfig.gauges[name] : {}),
      ...(isObj(sessionConfig?.gauges?.[name]) ? sessionConfig.gauges[name] : {}),
    }
  }
  const requested = sessionConfig?.mode ?? userConfig?.mode
  return { gauges, mode: MODES.has(requested) ? requested : DEFAULTS.mode }
}

export function readConfig({ dir, sessionId, readFile }) {
  // join() lives INSIDE the try: path.join throws on a non-string segment,
  // and readConfig's contract is that no input can make it throw.
  const load = (...segments) => {
    try { return JSON.parse(readFile(join(...segments), 'utf8')) }
    catch { return {} } // fail-open: a missing or corrupt config must never block a tool call
  }
  const user = load(dir, 'tacos', 'config.json')
  const session = sessionId ? load(dir, 'tacos', 'sessions', `${sessionId}.json`) : {}
  return mergeConfig(user, session)
}
