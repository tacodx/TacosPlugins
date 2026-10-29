// The morning recap as data. Pure: the night's commits, each project's progress,
// what every session reported and the night's events go in, with the time zone and
// the instant the recap is made at; the numbers and short sentences the page and the
// pane show come out. Nothing here reads the disk or the clock.
//
// Every sentence is plain text. The page escapes it, because result lines, task
// titles and commit subjects are written by models and may hold anything.
import { localDate, localParts, localTime, systemTimeZone } from '../clock.mjs'

const HOUR = 3_600_000
/** A night never needs more columns than this, whatever a broken clock says. */
const MAX_HOURS = 48
/** Named colour slots. With more projects than this, the ones past the seventh share "Other". */
export const SLOTS = 8
export const QUIET = 'Quiet night: no restarts, no memory pressure, no limits.'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const count = (v) => (isNum(v) && v > 0 ? Math.round(v) : 0)
const list = (v) => (Array.isArray(v) ? v : [])
const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `-${-n}` : '+0')
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** An instant as milliseconds, from a number or an ISO string; null for anything else. */
function toMs(v) {
  if (isNum(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** `s` cut to at most `max` characters, at a space where one is near, with an ellipsis when cut. */
export function clip(s, max) {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

/** "2026-10-29" -> "29 October". */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''))
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return String(date ?? '')
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

/**
 * One bucket per local hour from the hour `from` falls in up to `to`. Buckets are
 * real hours: across an autumn switch the repeated hour appears twice, and a spring
 * switch skips one label. Zones with half-hour offsets start their buckets on their
 * own full hours.
 */
export function hourBuckets(from, to, zone) {
  const out = []
  if (!isNum(from) || !isNum(to) || to <= from) return out
  const p = localParts(from, zone)
  let t = Math.floor(from / 1000) * 1000 - p.mi * 60_000 - p.s * 1000
  while (t < to && out.length < MAX_HOURS) {
    out.push({ hourStart: t, label: String(localParts(t, zone).h).padStart(2, '0') })
    t += HOUR
  }
  return out
}

/** Points won: the difference of the rounded percentages, so a line like "40 % to 58 %, +18" always adds up. */
export function pointsWon(duskPct, nowPct) {
  if (!isNum(duskPct) || !isNum(nowPct)) return null
  return Math.round(nowPct) - Math.round(duskPct)
}

/** What is done and left in one project, as one sentence, or null when nothing is known. */
function leftLine({ doneTasks, totalTasks, addedTasks, left }) {
  const parts = []
  if (totalTasks > 0) {
    parts.push(doneTasks >= totalTasks ? `All ${totalTasks} tasks done` : `${doneTasks} of ${plural(totalTasks, 'task')} done`)
  }
  if (addedTasks > 0) parts.push(`${addedTasks} added tonight`)
  let sentence = parts.join(', ')
  const remaining = totalTasks > 0 ? Math.max(0, totalTasks - doneTasks) : left.length
  if (left.length > 0 && remaining > 0) {
    const shown = left.slice(0, 3)
    const more = Math.max(0, remaining - shown.length)
    sentence += `${sentence ? '. ' : ''}Left: ${shown.join('; ')}${more ? `; and ${more} more` : ''}`
  }
  return sentence ? `${sentence}.` : null
}

function projectRow(p, name, made) {
  const duskPct = isNum(p.duskPct) ? p.duskPct : null
  const nowPct = isNum(p.nowPct) ? p.nowPct : null
  const won = pointsWon(duskPct, nowPct)
  const row = {
    name,
    duskPct,
    nowPct,
    won,
    doneTasks: count(p.doneTasks),
    totalTasks: count(p.totalTasks),
    addedTasks: count(p.addedTasks),
    itemsDone: count(p.itemsDone),
    itemsParked: count(p.itemsParked),
    left: list(p.left).map(text).filter(Boolean).slice(0, 5).map((title) => clip(title, 70)),
    branch: text(p.branch) || null,
    commits: made.commits,
    linesAdded: made.linesAdded,
    linesRemoved: made.linesRemoved,
    slot: null,
  }
  const moved = row.itemsDone > 0 ? `${plural(row.itemsDone, 'item')} done` : row.commits > 0 ? plural(row.commits, 'commit') : 'nothing moved'
  row.line = won === null
    ? `${name}, ${moved}`
    : `${name}, ${Math.round(duskPct)} % to ${Math.round(nowPct)} %, ${signed(won)}`
  row.leftLine = leftLine(row)
  return row
}

const STATE_WORDS = {
  working: 'still working',
  idle: 'idle',
  waiting: 'waiting on a dialog',
  limited: 'waiting for the usage limit',
  hung: 'hung',
  dead: 'ended',
  paused: 'paused',
  stopped: 'stopped',
}

/** At most two lines per session: what it did, and where it is now. */
function sessionRow(s, commits) {
  const kind = s?.kind === 'desktop' ? 'desktop' : 'worker'
  const name = text(s?.name) || (kind === 'desktop' ? 'Desktop session' : 'Worker')
  const project = text(s?.project) || null
  const branch = text(s?.branch) || null
  const made = count(s?.commits)
  const tally = { done: [], partial: [], 'needs-owner': [], failed: [] }
  const results = list(s?.results).filter((r) => r && typeof r === 'object' && tally[r.status])
  for (const r of results) tally[r.status].push(text(r.line))

  let did
  if (tally.done.length > 0) {
    const shown = tally.done.filter(Boolean).slice(0, 2).map((line) => clip(line, 80))
    const more = tally.done.length - shown.length
    did = `Finished ${plural(tally.done.length, 'item')}${shown.length ? `: ${shown.join('; ')}${more ? `; and ${more} more` : ''}` : ''}.`
  } else if (results.length > 0) {
    did = 'No item finished.'
  } else if (made > 0) {
    const last = commits
      .filter((c) => c.project === project && branch !== null && c.branch === branch && c.subject)
      .reduce((best, c) => (best === null || c.at > best.at ? c : best), null)
    did = `Made ${plural(made, 'commit')}${last ? `, the last: ${clip(last.subject, 80)}` : ''}.`
  } else {
    did = 'Nothing recorded.'
  }
  const rest = [['partial', 'partial'], ['failed', 'failed'], ['needs-owner', 'parked']]
    .filter(([status]) => tally[status].length > 0)
    .map(([status, word]) => `${tally[status].length} ${word}`)
  if (rest.length > 0) did += ` ${capital(rest.join(', '))}.`

  const where = []
  if (kind === 'desktop') where.push('desktop')
  where.push(project ? (branch ? `${project} on ${branch}` : project) : (branch ?? 'no project'))
  if (made > 0 && results.length > 0) where.push(plural(made, 'commit'))
  const state = text(s?.state)
  if (state) where.push(STATE_WORDS[state] ?? state)

  return { kind, name, project, branch, state: state || null, commits: made, did, where: where.join(', ') }
}

/** The night's events as one sentence: the quiet sentence when nothing went wrong. */
export function healthLine(events) {
  const n = {}
  let disk = 0
  let failedSteps = 0
  for (const e of list(events)) {
    if (!e || typeof e.kind !== 'string') continue
    if (e.kind === 'health.blocker' && e.code === 'disk-full') disk += 1
    else n[e.kind] = (n[e.kind] ?? 0) + 1
    if ((e.kind === 'dusk.step' || e.kind === 'dawn.step') && e.ok === false && !e.skipped) failedSteps += 1
  }
  const parts = []
  const restarts = (n['worker.restart'] ?? 0) + (n['watcher.restart'] ?? 0)
  if (restarts) parts.push(plural(restarts, 'restart'))
  const pressure = (n['health.blocker'] ?? 0) + (n['health.thrash'] ?? 0)
  if (pressure) parts.push(`memory pressure ${times(pressure)}`)
  if (disk) parts.push(`disk nearly full ${times(disk)}`)
  if (n['health.hot']) parts.push(`ran hot ${times(n['health.hot'])}`)
  if (n['pump.low']) parts.push(`pump below its floor ${times(n['pump.low'])}`)
  if (n['limit.hit']) parts.push(`usage limit hit ${times(n['limit.hit'])}`)
  if (n['guard.deny']) parts.push(`${plural(n['guard.deny'], 'command')} blocked`)
  if (failedSteps) parts.push(`${plural(failedSteps, 'dusk or dawn step')} failed`)
  return parts.length > 0 ? `${capital(parts.join(', '))}.` : QUIET
}

/** "Needs you: a; b; c; and 2 more." or null when nothing needs the owner. */
export function needsLine(items) {
  const clean = list(items).map((item) => clip(text(item).replace(/[.;,\s]+$/, ''), 90)).filter(Boolean)
  if (clean.length === 0) return null
  const shown = clean.slice(0, 3)
  const more = clean.length - shown.length
  return `Needs you: ${shown.join('; ')}${more ? `; and ${more} more` : ''}.`
}

const gauge = (v) => (isNum(v) ? v : v && isNum(v.percent) ? v.percent : null)

/** The usage gauges in one sentence, or null when none was read. */
export function usageLine(usage) {
  if (!usage || typeof usage !== 'object') return null
  const parts = []
  const five = gauge(usage.fiveHour)
  const week = gauge(usage.sevenDay)
  if (five !== null) parts.push(`${Math.round(five)} % of the five-hour limit`)
  if (week !== null) parts.push(`${Math.round(week)} % of the week`)
  return parts.length > 0 ? `Usage now: ${parts.join(', ')}.` : null
}

/**
 * The recap of one night. Commits count from the window's start up to the later of
 * its end and `now`, because workers keep going after dawn until Stop; the hourly
 * columns run from the start to the earlier of the end and `now`, stretched to the
 * last commit counted.
 */
export function buildRecap(input = {}) {
  const zone = text(input.zone) || systemTimeZone()
  const start = toMs(input.window?.start)
  const end = toMs(input.window?.end)
  const now = toMs(input.now)
  const until = Math.max(end ?? -Infinity, now ?? -Infinity)

  const commits = list(input.commits)
    .map((c) => ({
      project: text(c?.project) || 'unnamed',
      branch: text(c?.branch) || null,
      at: toMs(c?.at),
      subject: text(c?.subject),
      added: count(c?.added),
      removed: count(c?.removed),
    }))
    .filter((c) => c.at !== null && (start === null || c.at >= start) && (!Number.isFinite(until) || c.at <= until))

  const made = new Map()
  for (const c of commits) {
    const m = made.get(c.project) ?? { commits: 0, linesAdded: 0, linesRemoved: 0 }
    m.commits += 1
    m.linesAdded += c.added
    m.linesRemoved += c.removed
    made.set(c.project, m)
  }
  const none = { commits: 0, linesAdded: 0, linesRemoved: 0 }

  // Projects in the owner's order first, then any repo that only shows up in git.
  const rows = []
  const seen = new Set()
  for (const p of list(input.projects)) {
    const name = text(p?.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    rows.push(projectRow(p, name, made.get(name) ?? none))
  }
  for (const name of [...made.keys()].sort()) {
    if (!seen.has(name)) rows.push(projectRow({}, name, made.get(name)))
  }

  // Colour follows the project, in the owner's order, never its rank tonight.
  const series = rows.filter((p) => p.commits > 0).map((p, i, all) => ({
    name: p.name,
    slot: all.length > SLOTS && i >= SLOTS - 1 ? -1 : i,
  }))
  const slotOf = new Map(series.map((s) => [s.name, s.slot]))
  for (const p of rows) p.slot = slotOf.get(p.name) ?? null

  const projects = [...rows].sort((a, b) =>
    (b.won ?? 0) - (a.won ?? 0) ||
    (b.nowPct ?? -1) - (a.nowPct ?? -1) ||
    b.itemsDone - a.itemsDone ||
    b.commits - a.commits ||
    byName(a, b))

  const perProject = rows
    .filter((p) => p.commits > 0)
    .map(({ name, commits: n, linesAdded, linesRemoved, slot }) => ({ name, commits: n, linesAdded, linesRemoved, slot }))
    .sort((a, b) => b.commits - a.commits || byName(a, b))

  let perHour = []
  if (start !== null) {
    const last = commits.reduce((max, c) => Math.max(max, c.at), -Infinity)
    const close = Math.max(Math.min(end ?? now ?? start, now ?? end ?? start), last + 1)
    const buckets = hourBuckets(start, close, zone).map((b) => ({ ...b, counts: new Map() }))
    for (const c of commits) {
      const i = Math.floor((c.at - (buckets[0]?.hourStart ?? 0)) / HOUR)
      if (i < 0 || i >= buckets.length) continue
      buckets[i].counts.set(c.project, (buckets[i].counts.get(c.project) ?? 0) + 1)
    }
    perHour = buckets.map(({ hourStart, label, counts }) => ({ hourStart, label, byProject: Object.fromEntries(counts) }))
  }

  const sessions = list(input.sessions).map((s) => sessionRow(s, commits))
  const doneResults = list(input.sessions)
    .flatMap((s) => list(s?.results))
    .filter((r) => r?.status === 'done').length
  const itemsFromProjects = rows.reduce((sum, p) => sum + p.itemsDone, 0)

  const totals = {
    commits: commits.length,
    linesAdded: commits.reduce((sum, c) => sum + c.added, 0),
    linesRemoved: commits.reduce((sum, c) => sum + c.removed, 0),
    itemsDone: itemsFromProjects > 0 ? itemsFromProjects : doneResults,
    sessions: sessions.length,
    projectsMoved: rows.filter((p) => p.commits > 0 || p.itemsDone > 0 || (p.won ?? 0) > 0).length,
  }

  const date = text(input.date) || (start !== null ? localDate(start, zone) : '')
  const night = `Night of ${dayLabel(date)}`
  const headline = totals.commits > 0
    ? `${night}: ${plural(totals.commits, 'commit')} across ${plural(perProject.length, 'project')}`
    : totals.sessions > 0
      ? `${night}: no commits from ${plural(totals.sessions, 'session')}`
      : `${night}: nothing happened`

  return {
    date,
    zone,
    phase: text(input.phase) || null,
    window: { start, end },
    generatedAt: now,
    headline,
    windowLabel: start !== null && end !== null ? `${localTime(start, zone)} to ${localTime(end, zone)}` : null,
    writtenAt: now !== null ? localTime(now, zone) : null,
    totals,
    projects,
    series,
    perHour,
    perProject,
    sessions,
    health: healthLine(input.events),
    needsLine: needsLine(input.needsOwner),
    usageLine: usageLine(input.usage),
  }
}
