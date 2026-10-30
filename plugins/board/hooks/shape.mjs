// Turns the View into what each card draws, and into words. Pure: no Node, no engine.
import { colourOf, NEUTRAL } from './charts.mjs'
import { compact, count, dayLabel, hourLabel, plural, span, weekday } from './format.mjs'

/** Projects past the palette are drawn together under this name. */
export const OTHER = 'Other'

const slotOf = (view) => new Map(view.projects.map((each) => [each.name, each.slot]))

/** The three figures of the top row. */
export function kpiItems(view) {
  const t = view.totals
  return [
    { label: 'Commits today', figure: compact(t.commitsToday), note: t.projectsToday === 0 ? 'none yet' : `in ${plural(t.projectsToday, 'project')}` },
    { label: 'Lines added', figure: compact(t.linesToday), note: 'today' },
    { label: 'Commits 7 days', figure: compact(t.commits7d), note: `in ${plural(t.projects7d, 'project')}` },
  ]
}

/** One column per hour: midnight named by its day, every sixth hour by its time. */
export function hourColumns(view) {
  return view.hours.map((each) => ({
    label: each.hour === 0 ? weekday(each.day) : each.hour % 6 === 0 ? hourLabel(each.hour) : '',
    title: `${weekday(each.day)} ${hourLabel(each.hour)}`,
    value: each.commits,
  }))
}

/** The stack's series, bottom first: projects in the order of their colours, then "Other". */
export function projectSeries(view) {
  const coloured = view.projects.filter((each) => each.slot !== null).sort((a, b) => a.slot - b.slot)
  const series = coloured.map((each) => ({ name: each.name, colour: colourOf(each.slot) }))
  return view.projects.some((each) => each.slot === null) ? [...series, { name: OTHER, colour: NEUTRAL }] : series
}

/** One column per day, today last; a project without a colour counted under "Other". */
export function dayColumns(view) {
  const slots = slotOf(view)
  return view.days.map((each, i) => {
    const values = {}
    for (const [name, n] of Object.entries(each.projects)) {
      const key = slots.get(name) === null || !slots.has(name) ? OTHER : name
      values[key] = (values[key] ?? 0) + n
    }
    return { label: i === view.days.length - 1 ? 'Today' : weekday(each.day), title: dayLabel(each.day), values }
  })
}

/** The sessions card: what it is called, its rows, and what it says when there are none. */
export function sessionsCard(view) {
  const { source, working, idle } = view.sessions
  const slots = slotOf(view)
  const fromList = source === 'registry'
  const rows = working.map((each) => {
    const how = each.since === null ? '' : fromList ? ` · working for ${span(view.now - each.since)}` : ` · last write ${span(view.now - each.since)} ago`
    return { name: each.name, detail: `${each.project}${how}`, colour: colourOf(slots.get(each.project) ?? null) }
  })
  return {
    eyebrow: fromList ? 'Working now' : 'Active in the last 10 min',
    aside: fromList ? (idle === null ? '' : `${working.length} of ${working.length + idle} open`) : 'from transcripts',
    rows,
    empty: fromList ? 'No session is working right now.' : 'No transcript was written to in the last ten minutes.',
  }
}

/** The last part of a path, to name a file in little room. */
const fileName = (path) => path.split('/').filter(Boolean).pop() ?? path

/** What the plan card draws: the rows, or a sentence saying why there are none. */
export function planInput(view) {
  if (view.plan === null) {
    return { kind: 'text', lines: [`No plan is set. Name a Markdown file with a table under "plan" in ${view.configFile}.`] }
  }
  if ('error' in view.plan) {
    return { kind: 'text', aside: fileName(view.plan.file), lines: [`The plan in ${view.plan.file} could not be shown: ${view.plan.error}.`] }
  }
  return { kind: 'rows', aside: `${view.plan.done} of ${view.plan.total} done`, rows: view.plan.rows }
}

/** What each card says, for whoever cannot see it. */
export function altTexts(view) {
  const t = view.totals
  const peak = view.hours.reduce((best, each) => (each.commits > best.commits ? each : best), view.hours[0] ?? { commits: 0 })
  const inHours = view.hours.reduce((sum, each) => sum + each.commits, 0)
  const open = view.plan !== null && 'rows' in view.plan ? view.plan.rows.filter((row) => !row.done) : []
  return {
    kpis: `${plural(t.commitsToday, 'commit')} and ${plural(t.linesToday, 'line')} added today; ${plural(t.commits7d, 'commit')} in the last 7 days`,
    hours: inHours === 0 ? 'No commits in the last 30 hours' : `${plural(inHours, 'commit')} in the last 30 hours, most at ${weekday(peak.day)} ${hourLabel(peak.hour)}: ${peak.commits}`,
    projects: view.projects.length === 0 ? 'No commits in the last 7 days' : `Commits per project in the last 7 days: ${view.projects.map((each) => `${each.name} ${each.commits}`).join(', ')}`,
    sessions: view.sessions.working.length === 0 ? 'No session is working right now' : `Working now: ${view.sessions.working.map((each) => each.name).join(', ')}`,
    plan: view.plan === null || !('rows' in view.plan) ? 'No plan to show' : `${view.plan.done} of ${view.plan.total} done in the plan; open: ${open.map((row) => `${row.id} ${row.name}`.trim()).join(', ')}`,
  }
}

/** The board in a few lines of text, for a surface that draws no charts. */
export function summary(view) {
  const t = view.totals
  const working = view.sessions.working
  const lines = [
    `Today: ${plural(t.commitsToday, 'commit')}, ${count(t.linesToday)} lines added. Last 7 days: ${plural(t.commits7d, 'commit')} in ${plural(t.projects7d, 'project')}.`,
    working.length === 0 ? 'No session is working right now.' : `Working now: ${working.map((each) => `${each.name} (${each.project})`).join(', ')}.`,
  ]
  if (view.plan !== null && 'rows' in view.plan) {
    const next = view.plan.rows.filter((row) => !row.done).slice(0, 3).map((row) => `${row.id} ${row.name}`.trim())
    lines.push(`Plan: ${view.plan.done} of ${view.plan.total} done.${next.length > 0 ? ` Open: ${next.join(', ')}.` : ''}`)
  }
  return lines
}
