import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ALIASES = {
  '5h': 'five_hour', session: 'five_hour', five_hour: 'five_hour',
  weekly: 'seven_day', week: 'seven_day', seven_day: 'seven_day',
  money: 'extra_usage', spend: 'extra_usage', extra_usage: 'extra_usage',
}

export function sessionPath(dir, sessionId) {
  return join(dir, 'tacos', 'sessions', `${sessionId}.json`)
}

export function parseBudgetArgs(argv) {
  const a = argv.filter(Boolean)
  if (a.length === 0) return { error: 'no arguments' }
  if (a[0] === 'off') return { mode: 'off' }
  if (a[0] === 'on') return { mode: 'enforce' }

  const [gaugeWord, valueWord] = a.length === 1 ? ['five_hour', a[0]] : [a[0], a[1]]
  const gauge = ALIASES[String(gaugeWord).toLowerCase()]
  if (!gauge) return { error: `unknown gauge "${gaugeWord}"` }
  const hard = Number(valueWord)
  if (!Number.isFinite(hard) || hard <= 0 || hard > 100) return { error: `"${valueWord}" is not a percentage between 1 and 100` }
  return { gauge, hard }
}

export function writeSessionConfig(dir, sessionId, patch, {
  writeFile = writeFileSync, mkdir = mkdirSync, readFile = readFileSync,
} = {}) {
  const path = sessionPath(dir, sessionId)

  // MERGE, never replace. Each /budget call carries only the one setting the user just
  // named, so overwriting would make `/budget weekly 70` silently discard the ceiling
  // they set with `/budget 80` a moment earlier.
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  let existing = {}
  try { existing = JSON.parse(readFile(path, 'utf8')) }
  catch { existing = {} } // no prior file, or an unreadable one: start fresh rather than throw
  if (!isObj(existing)) existing = {}

  const merged = { ...existing, ...patch }
  // A non-object `gauges` (e.g. hand-edited to a string) must be treated as absent, not
  // spread — spreading a string yields numeric-index keys that corrupt the gauges map.
  const existingGauges = isObj(existing.gauges) ? existing.gauges : {}
  const patchGauges = isObj(patch.gauges) ? patch.gauges : {}
  const gauges = { ...existingGauges, ...patchGauges }
  if (Object.keys(gauges).length > 0) merged.gauges = gauges

  mkdir(join(dir, 'tacos', 'sessions'), { recursive: true })
  writeFile(path, JSON.stringify(merged, null, 2), { mode: 0o600 })
}

export function gcSessions(dir, {
  now, maxAgeMs = 7 * 24 * 3600 * 1000,
  readdir = readdirSync, stat = statSync, remove = unlinkSync,
}) {
  const base = join(dir, 'tacos', 'sessions')
  const removed = []
  let names = []
  try { names = readdir(base) } catch { return removed } // fail-open: a missing sessions dir must never block a budget call
  for (const name of names) {
    try {
      if (now - stat(join(base, name)).mtimeMs > maxAgeMs) { remove(join(base, name)); removed.push(name) }
    } catch { /* fail-open: a single unreadable/unremovable entry must not abort the sweep */ }
  }
  return removed
}
