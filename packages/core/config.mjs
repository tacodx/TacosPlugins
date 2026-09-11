import { homedir } from 'node:os'
import { join } from 'node:path'

const MODES = new Set(['enforce', 'dry-run', 'off'])

// Any gauge may carry `enforce: false` to become watch-only: it is still fetched and
// still rendered with its percentage, but it can never produce a denial. Omitted or
// `true` means the gauge enforces normally.
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
  let unreadable = false
  const load = (...segments) => {
    try { return JSON.parse(readFile(join(...segments), 'utf8')) }
    catch (err) {
      // ENOENT is "no config yet", and the shipped defaults are the right answer.
      // Anything else means the user HAS settings we cannot read. Falling back to
      // defaults would silently re-arm a guard they may have deliberately turned off,
      // so record it and degrade to dry-run below.
      if (err?.code !== 'ENOENT') unreadable = true
      return {}
    }
  }
  const user = load(dir, 'tacos', 'config.json')
  const session = sessionId ? load(dir, 'tacos', 'sessions', `${sessionId}.json`) : {}
  const merged = mergeConfig(user, session)

  // fail-open, and this is what makes that phrase literally true: a config we could not
  // read can never produce a denial. It still observes and still reports.
  return unreadable ? { ...merged, mode: 'dry-run', configUnreadable: true } : merged
}
