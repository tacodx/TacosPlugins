// The View: everything one range of the dashboard shows, as plain JSON. Pure.
// The definitions are section 6.4 of docs/superpowers/specs/2026-10-07-reflect-design.md.
import { addCounts, bump, emptyModel, own } from './agg.mjs'
import { addDays, weekdayOf } from './clock.mjs'

/** Range ids and their length in days; null is all of history. */
export const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null }

const LIMITS = { projects: 12, tools: 15, skills: 10, mcp: 10, sessions: 5, workProjects: 8, dayModels: 6 }
const SUMMED = ['activeMs', 'out', 'inp', 'cacheR', 'cacheW', 'msgs', 'subMsgs']
const COUNT_MAPS = ['tools', 'skills', 'mcp', 'efforts']
const NO_PROMPTS = { prompts: 0, hours: new Array(24).fill(0) }

const get = (map, key) => (Object.hasOwn(map, key) ? map[key] : null)
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const earliest = (keys) => (keys.length > 0 ? [...keys].sort()[0] : null)

function ranked(map, limit = Infinity) {
  return Object.entries(map)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || byName(a, b))
    .slice(0, limit)
}

function daysBetween(from, to) {
  const list = []
  for (let day = from; day <= to; day = addDays(day, 1)) list.push(day)
  return list
}

/** `active` is every day with a prompt, in order. */
function streaks(active, today) {
  const set = new Set(active)
  let best = 0
  let run = 0
  let previous = null
  for (const day of active) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1
    if (run > best) best = run
    previous = day
  }
  let current = 0
  // A day that has only just begun does not break a streak.
  for (let day = set.has(today) ? today : addDays(today, -1); set.has(day); day = addDays(day, -1)) current += 1
  return { currentStreak: current, bestStreak: best }
}

function workMix(rows, from, to) {
  const types = {}
  const months = {}
  const projects = {}
  for (const row of rows) {
    if (row.day < from || row.day > to) continue
    bump(types, row.type, row.n)
    bump(own(months, row.day.slice(0, 7), () => ({})), row.type, row.n)
    const project = own(projects, row.project, () => ({ n: 0, types: {} }))
    project.n += row.n
    bump(project.types, row.type, row.n)
  }
  return {
    types: ranked(types),
    byMonth: Object.keys(months)
      .sort()
      .map((month) => ({ month, types: months[month] })),
    byProject: Object.entries(projects)
      .map(([name, project]) => ({ name, n: project.n, types: project.types }))
      .sort((a, b) => b.n - a.n || byName(a, b))
      .slice(0, LIMITS.workProjects),
  }
}

export function buildView({ days, sessions, history, work, rangeId, today, clock, generatedAt, notes = [] }) {
  if (!Object.hasOwn(RANGES, rangeId)) throw new Error(`unknown range: ${rangeId}`)
  const length = RANGES[rangeId]

  // Each source can only under-count a day, so the larger one is that day's prompts.
  const promptsOn = (day) => {
    const transcripts = get(days, day)
    const typed = get(history, day)
    if (typed !== null && (transcripts === null || typed.prompts > transcripts.prompts)) return typed
    return transcripts ?? NO_PROMPTS
  }

  const workDays = work === null ? [] : work.map((row) => row.day)
  const known = [...new Set([...Object.keys(days), ...Object.keys(history), ...workDays])].sort()
  const firstKnown = known.length > 0 && known[0] < today ? known[0] : today
  const from = length === null ? firstKnown : addDays(today, -(length - 1))

  function collect(first, last) {
    const totals = { prompts: 0, activeDays: 0 }
    for (const field of SUMMED) totals[field] = 0
    const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
    const maps = { models: {}, projects: {} }
    for (const field of COUNT_MAPS) maps[field] = {}
    const series = []

    for (const day of daysBetween(first, last)) {
      const merged = get(days, day)
      const prompts = promptsOn(day)
      totals.prompts += prompts.prompts
      if (prompts.prompts > 0) totals.activeDays += 1
      const weekday = hours[weekdayOf(day)]
      for (let hour = 0; hour < 24; hour += 1) weekday[hour] += prompts.hours[hour]

      const point = { day, prompts: prompts.prompts, out: 0, sessions: 0, models: {} }
      if (merged !== null) {
        point.out = merged.out
        point.sessions = merged.sessions
        for (const field of SUMMED) totals[field] += merged[field]
        for (const field of COUNT_MAPS) addCounts(maps[field], merged[field])
        for (const [model, usage] of Object.entries(merged.models)) {
          const sum = own(maps.models, model, emptyModel)
          for (const field of Object.keys(sum)) sum[field] += usage[field]
          bump(point.models, model, usage.out)
        }
        for (const [name, project] of Object.entries(merged.projects)) {
          const sum = own(maps.projects, name, () => ({ prompts: 0, out: 0 }))
          sum.prompts += project.prompts
          sum.out += project.out
        }
      }
      series.push(point)
    }

    const started = sessions.filter((row) => {
      const day = clock(row.start).day
      return day >= first && day <= last
    })
    return { totals, hours, maps, series, started }
  }

  const current = collect(from, today)
  const { totals, maps, started } = current

  totals.sessions = started.length
  totals.desktopSessions = started.filter((row) => row.entrypoint === 'claude-desktop').length
  totals.cliSessions = started.filter((row) => row.entrypoint === 'cli').length
  totals.toolCalls = Object.values(maps.tools).reduce((sum, n) => sum + n, 0)
  const input = totals.cacheR + totals.cacheW + totals.inp
  totals.cacheHitRate = input === 0 ? null : totals.cacheR / input
  Object.assign(totals, streaks(known.filter((day) => promptsOn(day).prompts > 0), today))

  const models = Object.entries(maps.models)
    .map(([name, usage]) => ({ name, ...usage }))
    .sort((a, b) => b.out - a.out || byName(a, b))
  const named = new Set(models.slice(0, LIMITS.dayModels).map((model) => model.name))
  for (const point of current.series) {
    const folded = {}
    for (const [model, out] of Object.entries(point.models)) bump(folded, named.has(model) ? model : 'other', out)
    point.models = folded
  }

  const sessionsOf = {}
  for (const row of started) bump(sessionsOf, row.project)
  const projects = Object.entries(maps.projects)
    .map(([name, project]) => ({ name, prompts: project.prompts, out: project.out, sessions: get(sessionsOf, name) ?? 0 }))
    .sort((a, b) => b.out - a.out || b.prompts - a.prompts || byName(a, b))
  totals.projects = projects.length

  const brief = (row) => ({
    title: row.title,
    project: row.project,
    start: row.start,
    activeMs: row.activeMs,
    prompts: row.prompts,
  })
  const top = (field) =>
    [...started]
      .sort((a, b) => b[field] - a[field] || a.start - b.start)
      .slice(0, LIMITS.sessions)
      .map(brief)

  let previous = null
  if (length !== null) {
    const before = collect(addDays(from, -length), addDays(from, -1))
    previous = {
      prompts: before.totals.prompts,
      sessions: before.started.length,
      out: before.totals.out,
      activeMs: before.totals.activeMs,
    }
  }

  return {
    version: 1,
    generatedAt,
    range: { id: rangeId, from, to: today, days: current.series.length },
    coverage: {
      transcriptsFrom: earliest(Object.keys(days)),
      historyFrom: earliest(Object.keys(history)),
      workFrom: earliest(workDays),
    },
    totals,
    days: current.series,
    hours: current.hours,
    projects: projects.slice(0, LIMITS.projects),
    models,
    tools: ranked(maps.tools, LIMITS.tools),
    skills: ranked(maps.skills, LIMITS.skills),
    mcp: ranked(maps.mcp, LIMITS.mcp),
    efforts: ranked(maps.efforts),
    sessions: { longest: top('activeMs'), mostPrompts: top('prompts') },
    work: work === null ? null : workMix(work, from, today),
    previous,
    notes,
  }
}
