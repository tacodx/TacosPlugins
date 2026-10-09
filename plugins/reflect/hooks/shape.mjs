// Turns parts of a View into what a chart draws. Pure: no Node, no engine.
import { dayLabel, monthLabel } from './format.mjs'

// A chart is 360 units wide. Past this many columns the bars are hairlines, and
// an "all time" chart of a few years would not fit a drawing's size limit.
const MAX_COLUMNS = 92

const DAY = 24 * 60 * 60 * 1000
const weekdayOf = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)

/**
 * One column per day, or per week or month when there are too many days.
 * @param {{ day: string }[]} days every day of the range, in order
 * @param {(day: object) => Record<string, number>} valuesOf the numbers to add up for a day
 * @returns {{ label: string, title: string, values: Record<string, number> }[]}
 */
export function columnsOf(days, valuesOf) {
  const perWeek = Math.ceil(days.length / 7) <= MAX_COLUMNS
  const groupOf =
    days.length <= MAX_COLUMNS
      ? (day) => ({ key: day, label: dayLabel(day), title: dayLabel(day) })
      : perWeek
        ? (day) => {
            const monday = addDays(day, -weekdayOf(day))
            return { key: monday, label: dayLabel(monday), title: `Week of ${dayLabel(monday)}` }
          }
        : (day) => ({ key: day.slice(0, 7), label: monthLabel(day.slice(0, 7)), title: monthLabel(day.slice(0, 7)) })

  const columns = []
  let current = null
  for (const each of days) {
    const group = groupOf(each.day)
    if (current === null || current.key !== group.key) {
      current = { key: group.key, label: group.label, title: group.title, values: {} }
      columns.push(current)
    }
    for (const [name, n] of Object.entries(valuesOf(each))) {
      current.values[name] = (Object.hasOwn(current.values, name) ? current.values[name] : 0) + n
    }
  }
  return columns.map(({ label, title, values }) => ({ label, title, values }))
}

/**
 * Whether the window before this one can be compared with it. It can when it
 * lies wholly inside the time transcripts cover: before that only some prompts
 * are known, and "up 1,300%" would be a statement about deleted files.
 */
export function isComparable(view) {
  const since = view.coverage.transcriptsFrom
  if (view.previous === null || since === null) return false
  return addDays(view.range.from, -view.range.days) >= since
}

/** The first `limit` of a ranked list, and the rest summed into one "Other" entry when there is a rest. */
export function withOther(list, limit, valueOf, nameOf = (each) => each.name) {
  const named = list.slice(0, limit).map((each) => ({ name: nameOf(each), value: valueOf(each) }))
  const rest = list.slice(limit).reduce((sum, each) => sum + valueOf(each), 0)
  return rest > 0 ? [...named, { name: 'Other', value: rest }] : named
}

/**
 * The weeks a calendar shows: at most a year of them, each seven cells from Monday.
 * @param {{ day: string, prompts: number }[]} days every day of the range, in order
 * @returns {{ weeks: ({ day: string, value: number } | null)[][], months: { column: number, label: string }[] }}
 */
export function calendarOf(days) {
  const shown = days.slice(-53 * 7)
  const weeks = []
  const months = []
  let seenMonth = null
  for (const each of shown) {
    const row = weekdayOf(each.day)
    if (weeks.length === 0 || row === 0) weeks.push(new Array(7).fill(null))
    weeks.at(-1)[row] = { day: each.day, value: each.prompts }
    const month = each.day.slice(0, 7)
    if (month !== seenMonth) {
      // A month is labelled at the week its first day falls in, unless that would crowd the last label.
      if (months.length === 0 || weeks.length - 1 - months.at(-1).column >= 3) {
        months.push({ column: weeks.length - 1, label: monthLabel(month).slice(0, 3) })
      }
      seenMonth = month
    }
  }
  return { weeks, months }
}

/** The busiest cell of the weekday-by-hour grid, or null when it is empty. */
export function busiestHour(hours) {
  let best = null
  hours.forEach((row, weekday) => {
    row.forEach((n, hour) => {
      if (n > 0 && (best === null || n > best.n)) best = { weekday, hour, n }
    })
  })
  return best
}

/** The share of prompts typed between 22:00 and 05:00, or null when there are none. */
export function lateShare(hours) {
  let late = 0
  let all = 0
  for (const row of hours) {
    row.forEach((n, hour) => {
      all += n
      if (hour >= 22 || hour < 5) late += n
    })
  }
  return all === 0 ? null : late / all
}
