// Work mix from the claude-mem plugin's database, read through the sqlite3
// command line tool. Both are optional: without either there is no work mix.
import { execFileSync } from 'node:child_process'

import { isPlausible } from './clock.mjs'

const QUARTER_HOUR = 15 * 60 * 1000

// Grouped by quarter hour, not by day: the day depends on the reader's time
// zone, which the caller's clock knows and SQLite's `localtime` may not match.
export const WORK_SQL = `select created_at_epoch / ${QUARTER_HOUR} as q, project, type, count(*) as n from observations group by 1, 2, 3`

function sqlite(argv) {
  return execFileSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * @returns {null | Array<{ day: string, project: string, type: string, n: number }>}
 *   null when the database or the sqlite3 tool cannot be used
 */
export function readWork(dbPath, clock, run = sqlite) {
  let rows
  try {
    // sqlite3 prints nothing at all for a result with no rows.
    rows = JSON.parse(run(['sqlite3', '-readonly', '-json', dbPath, WORK_SQL]) || '[]')
  } catch {
    return null // no sqlite3, no such table, a locked or foreign file: there is no work mix to show
  }
  if (!Array.isArray(rows)) return null

  const merged = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !Number.isFinite(row.n)) continue
    const at = row.q * QUARTER_HOUR
    if (!isPlausible(at)) continue
    const entry = { day: clock(at).day, project: String(row.project), type: String(row.type), n: row.n }
    const key = JSON.stringify([entry.day, entry.project, entry.type])
    const seen = merged.get(key)
    if (seen === undefined) merged.set(key, entry)
    else seen.n += entry.n
  }
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry)
}
