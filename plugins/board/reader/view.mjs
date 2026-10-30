// Commits, sessions and the plan, put into the one View the pane draws.
import { addDays, createClock, hourStart, timeLabel } from './clock.mjs'

const HOUR = 60 * 60 * 1000
export const HOURS = 30
export const DAYS = 7
/** Distinct colours a project can hold; the pane's palette has this many. */
export const SLOTS = 8

const byCommits = (a, b) => b.commits - a.commits || a.name.localeCompare(b.name)

/** The projects that are coloured: the `slots` with the most commits. */
const coloured = (active, slots) => [...active].sort(byCommits).slice(0, slots)

/**
 * Gives each of the busiest active projects a colour slot it keeps from one
 * view to the next. Past `slots` active projects, the ones with the fewest
 * commits get none. A coloured project keeps the slot the book gave it unless
 * another coloured project already holds that one; one without a slot takes the
 * lowest slot no project in the book holds, else one only a project that is
 * not coloured now holds, which then gives it up.
 * @param {{ name: string, commits: number }[]} active
 * @param {Record<string, number>} book project -> slot, from earlier views
 * @returns {Record<string, number>} the book with every change made
 */
export function assignColours(active, book, slots = SLOTS) {
  const next = { ...book }
  const taken = new Set()
  const waiting = []
  for (const project of coloured(active, slots).sort((a, b) => a.name.localeCompare(b.name))) {
    const slot = next[project.name]
    if (Number.isInteger(slot) && slot >= 0 && slot < slots && !taken.has(slot)) taken.add(slot)
    else waiting.push(project)
  }
  for (const project of waiting.sort(byCommits)) {
    delete next[project.name]
    const held = new Set(Object.values(next))
    let slot = -1
    for (let i = 0; i < slots && slot === -1; i += 1) if (!taken.has(i) && !held.has(i)) slot = i
    // There are never more coloured projects than slots, so one is always free of them.
    for (let i = 0; i < slots && slot === -1; i += 1) if (!taken.has(i)) slot = i
    for (const [name, value] of Object.entries(next)) if (value === slot) delete next[name]
    next[project.name] = slot
    taken.add(slot)
  }
  return next
}

/**
 * @param {{
 *   commits: { h: string, t: number, a: number, project: string }[], now: number, zone: string,
 *   sessions: object, plan: object | null, colours: Record<string, number>, refreshMinutes: number,
 *   repos: { count: number, unreadable: string[] }, notes: string[], configFile?: string,
 * }} input
 * @returns {{ view: object, colours: Record<string, number> }}
 */
export function buildView({ commits, now, zone, sessions, plan, colours, refreshMinutes, repos, notes, configFile = '' }) {
  const clock = createClock(zone)
  const today = clock(now).day

  const last = hourStart(now, zone)
  const first = last - (HOURS - 1) * HOUR
  const hours = Array.from({ length: HOURS }, (_, i) => {
    const start = first + i * HOUR
    const { day, hour } = clock(start)
    return { start, day, hour, commits: 0 }
  })

  const days = Array.from({ length: DAYS }, (_, i) => ({ day: addDays(today, i - (DAYS - 1)), total: 0, projects: {} }))
  const dayIndex = new Map(days.map((each, i) => [each.day, i]))
  const perProject = new Map()
  const projectsToday = new Set()
  let commitsToday = 0
  let linesToday = 0
  let commits7d = 0

  for (const commit of commits) {
    // A commit dated after now (a clock ahead of this one) waits until it is not.
    if (commit.t > now) continue
    if (commit.t >= first) hours[Math.floor((commit.t - first) / HOUR)].commits += 1
    const { day } = clock(commit.t)
    const i = dayIndex.get(day)
    if (i === undefined) continue
    const column = days[i]
    column.total += 1
    column.projects[commit.project] = (column.projects[commit.project] ?? 0) + 1
    perProject.set(commit.project, (perProject.get(commit.project) ?? 0) + 1)
    commits7d += 1
    if (day === today) {
      commitsToday += 1
      linesToday += commit.a
      projectsToday.add(commit.project)
    }
  }

  const active = [...perProject].map(([name, n]) => ({ name, commits: n })).sort(byCommits)
  const book = assignColours(active, colours)
  const isColoured = new Set(coloured(active, SLOTS).map((each) => each.name))

  return {
    colours: book,
    view: {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      now,
      updated: timeLabel(now, zone),
      zone,
      refreshMinutes,
      today,
      totals: { commitsToday, linesToday, commits7d, projectsToday: projectsToday.size, projects7d: active.length },
      hours,
      days,
      projects: active.map(({ name, commits: n }) => ({ name, commits: n, slot: isColoured.has(name) && Number.isInteger(book[name]) ? book[name] : null })),
      sessions,
      plan,
      repos,
      configFile,
      notes,
    },
  }
}
