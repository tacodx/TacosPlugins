// Local calendar day and hour for an instant, in a named time zone.
//
// Intl is slow per call, so answers are cached per quarter hour: every real UTC
// offset and every daylight-saving switch falls on a quarter-hour boundary, so
// all instants inside one quarter hour share a local day and hour.

const QUARTER_HOUR = 15 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

// Claude Code did not exist before this, and no record is from the next century.
const EARLIEST = Date.UTC(2020, 0, 1)
const LATEST = Date.UTC(2100, 0, 1)

/**
 * Whether an instant can belong to a real record. One stray value near the epoch
 * would stretch "all time" over twenty thousand days, and one far enough out
 * cannot be formatted at all.
 */
export const isPlausible = (ms) => Number.isFinite(ms) && ms >= EARLIEST && ms < LATEST

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** @returns {(ms: number) => { day: string, hour: number }} */
export function createClock(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const cache = new Map()

  return (ms) => {
    const key = Math.floor(ms / QUARTER_HOUR)
    let answer = cache.get(key)
    if (answer === undefined) {
      const parts = {}
      for (const { type, value } of format.formatToParts(new Date(ms))) parts[type] = value
      answer = { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
      cache.set(key, answer)
    }
    return answer
  }
}

/** The calendar day `n` days after `day`; `n` may be negative. Noon UTC keeps it clear of any offset. */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day) {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
}
