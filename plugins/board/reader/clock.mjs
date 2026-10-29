// Local calendar day and hour for an instant, in a named time zone.
//
// Intl is slow per call, so answers are cached per quarter hour: every real UTC
// offset and every daylight-saving switch falls on a quarter-hour boundary, so
// all instants inside one quarter hour share a local day and hour.

const QUARTER_HOUR = 15 * 60 * 1000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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

/** How far the zone's wall clock is ahead of UTC at `ms`, in milliseconds. */
function offsetAt(ms, timeZone) {
  const parts = {}
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  for (const { type, value } of format.formatToParts(new Date(ms))) parts[type] = Number(value)
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return wall - (ms - (((ms % 1000) + 1000) % 1000))
}

/** The instant the local hour holding `ms` began. A zone half an hour off UTC starts its hours on the half hour. */
export function hourStart(ms, timeZone) {
  const offset = offsetAt(ms, timeZone)
  return ms - ((((ms + offset) % HOUR) + HOUR) % HOUR)
}

/** "HH:MM" on the zone's wall clock. */
export function timeLabel(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
}

/** The calendar day `n` days after `day`; `n` may be negative. Noon UTC keeps it clear of any offset. */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}
