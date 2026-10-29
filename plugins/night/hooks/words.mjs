// What the pane says, worked out from the view `bin/night.mjs view` prints.
// Pure: no Node, no engine. Times are read in `zone`, an IANA name, or in the
// machine's own zone when none is given: the pane gives none, the tests do.

const formats = new Map()

/** An instant (ms, or an ISO string) as "HH:MM" in `zone`; "" for anything that is no time. */
export function clock(at, zone) {
  const ms = typeof at === 'string' ? Date.parse(at) : at
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const id = zone ?? ''
  let format = formats.get(id)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(zone === undefined ? {} : { timeZone: zone }) })
    formats.set(id, format)
  }
  const parts = {}
  for (const { type, value } of format.formatToParts(new Date(ms))) parts[type] = value
  return `${parts.hour}:${parts.minute}`
}

/** "7:05" or "07:05" -> "07:05"; null for anything that is not a time of day. */
export function timeOfDay(text) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text).trim())
  return match === null ? null : `${match[1].padStart(2, '0')}:${match[2]}`
}

/** "a", "a and b", "a, b and c" (or "or"). */
export function list(names, word = 'and') {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`
}

const RUNNING = ['dusk', 'night', 'day']

/** Whether a night is under way: from dusk until Stop. */
export const isRunning = (phase) => RUNNING.includes(phase)

/** Which of Arm, Disarm, Start now and Stop the pane offers in a phase. */
export function controls(phase) {
  return {
    arm: phase === 'armed' ? 'disarm' : phase === 'idle' || phase === 'stopped' ? 'arm' : null,
    start: !isRunning(phase),
    stop: isRunning(phase),
  }
}

/** What the pane says while an action of `bin/night.mjs` runs. */
export const DOING = {
  view: 'Reading…',
  arm: 'Arming…',
  disarm: 'Disarming…',
  start: 'Starting the night…',
  stop: 'Stopping the night…',
  set: 'Saving the window…',
  sessions: 'Saving…',
  project: 'Saving…',
}

// The states the view names, and the five the pane tells apart.
const TONES = { working: 'working', busy: 'working', waiting: 'waiting', idle: 'waiting', limited: 'limited', paused: 'paused' }

/** A worker's state as one of working, waiting, limited, paused or off. */
export const toneOf = (state) => TONES[state] ?? 'off'

/** A worker's state in plain words: "working", "limited until 02:10", ... */
export function stateWords(worker, zone) {
  const tone = toneOf(worker.state)
  if (tone === 'working') return 'working'
  if (tone === 'waiting') return 'waiting for work'
  if (tone === 'paused') return 'paused for memory'
  if (tone === 'limited') {
    const until = clock(worker.limitedUntil, zone)
    return until === '' ? 'limited' : `limited until ${until}`
  }
  return 'off'
}

/** One worker in one line: "1. slait: Add the login form, working". */
export function workerLine(worker, zone) {
  const state = stateWords(worker, zone)
  if (!worker.project) return `${worker.slot}. ${state}`
  if (!worker.item) return `${worker.slot}. ${worker.project}, ${state}`
  return `${worker.slot}. ${worker.project}: ${worker.item}, ${state}`
}

/** The night's window, as armed when it is, else as set: "23:30 to 06:30". */
export function span(view, zone) {
  const from = clock(view.armed?.start, zone) || view.window.from
  const to = clock(view.armed?.end, zone) || view.window.to
  return `${from} to ${to}`
}

/** The phase in plain words. */
export function phaseLine(view, zone) {
  switch (view.phase) {
    case 'armed':
      return `Armed for ${span(view, zone)}`
    case 'dusk':
      return 'Night starting'
    case 'night': {
      const since = clock(view.armed?.start, zone)
      return since === '' ? 'Night running' : `Night running since ${since}`
    }
    case 'day':
      return view.workers.some((each) => toneOf(each.state) !== 'off') ? 'Morning: workers still going' : 'Morning: workers done'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Not armed'
  }
}

/** The watchers: "all fine", or which of them are late. */
export function watchersWords(watchers) {
  const late = watchers.filter((each) => !each.ok).map((each) => each.name)
  if (late.length === 0) return 'all fine'
  return `${list(late)} ${late.length === 1 ? 'is' : 'are'} late`
}

/** "12 open, 5 done, 1 parked". */
export const queueWords = (queue) => `${queue.open} open, ${queue.done} done, ${queue.parked} parked`

/** "42 % of five hours, 18 % of the week, resets 02:00", or "not read yet". */
export function usageWords(usage, zone) {
  if (usage === null || usage === undefined) return 'not read yet'
  const parts = []
  if (typeof usage.fiveHour === 'number') parts.push(`${Math.round(usage.fiveHour)} % of five hours`)
  if (typeof usage.sevenDay === 'number') parts.push(`${Math.round(usage.sevenDay)} % of the week`)
  const reset = clock(usage.resetsAt, zone)
  if (parts.length > 0 && reset !== '') parts.push(`resets ${reset}`)
  return parts.length === 0 ? 'not read yet' : parts.join(', ')
}

/** At most one short line for what needs the owner: a health blocker first, else the first problem. */
export function attention(view) {
  if (view.health.blockers > 0 && view.health.line) return view.health.line
  const [first, ...rest] = view.problems
  if (first === undefined) return null
  return rest.length === 0 ? first : `${first} (and ${rest.length} more)`
}

/** A recap's project line: "slait, 40 % to 58 %, +18". */
export const recapLine = (project) => (project.line.startsWith(project.name) ? project.line : `${project.name}, ${project.line}`)

/**
 * @typedef {{ slot: number, tone: string, state: string, project: string, item: string, line: string }} WorkerSaid
 * @typedef {{ label: string, value: string, isLate: boolean }} RowSaid
 * @typedef {{ headline: string, lines: string[], url: string | null }} RecapSaid
 * @typedef {{ phase: string, window: string, workers: WorkerSaid[], noWorkers: boolean, rows: RowSaid[], recap: RecapSaid | null, attention: string | null }} Said
 */

/**
 * Everything the Tonight tab says, worked out once for the drawing and the
 * plain text alike.
 * @returns {Said}
 */
export function summary(view, zone) {
  const running = isRunning(view.phase)
  const queued = view.queue.open + view.queue.taken + view.queue.done + view.queue.parked + view.queue.failed
  const rows = []
  if (running) rows.push({ label: 'Watchers', value: watchersWords(view.watchers), isLate: view.watchers.some((each) => !each.ok) })
  if (running || queued > 0) rows.push({ label: 'Queue', value: queueWords(view.queue), isLate: false })
  rows.push({ label: 'Usage', value: usageWords(view.usage, zone), isLate: false })

  return {
    phase: phaseLine(view, zone),
    window: span(view, zone),
    workers: view.workers.map((each) => ({
      slot: each.slot,
      tone: toneOf(each.state),
      state: stateWords(each, zone),
      project: each.project ?? '',
      item: each.item ?? '',
      line: workerLine(each, zone),
    })),
    noWorkers: running && view.workers.length === 0,
    rows,
    recap: view.recap === null ? null : { headline: view.recap.headline, lines: view.recap.projects.map(recapLine), url: view.recap.artifactUrl ?? null },
    attention: attention(view),
  }
}

/**
 * The fans in one line, and when something is missing a two-line guide to it.
 * The token itself is never asked for here: it is a file the owner saves.
 */
export function fansLines(fans) {
  if (fans.token && fans.dayMode && fans.nightMode) return ['Fans: the CoolerControl token and the Day and Night modes are there.']

  const missing = []
  if (!fans.token) missing.push('CoolerControl token')
  if (!fans.dayMode) missing.push('Day mode')
  if (!fans.nightMode) missing.push('Night mode')
  const modes = []
  if (!fans.dayMode) modes.push('a mode called Day from your current fans')
  if (!fans.nightMode) modes.push(`${fans.dayMode ? 'a mode' : 'one'} called Night with the quiet curves you want overnight`)

  const lines = [`Fans: no ${list(missing, 'or')} found yet.`]
  if (modes.length > 0) lines.push(`In CoolerControl, make ${modes.join(' and ')}${fans.token ? '.' : ','}`)
  if (!fans.token) lines.push(modes.length > 0 ? `then save an access token to ${fans.tokenPath}.` : `In CoolerControl, make an access token and save it to ${fans.tokenPath}.`)
  return lines
}
