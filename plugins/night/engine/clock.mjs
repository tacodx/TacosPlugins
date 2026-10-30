// The night's window in local time. Pure: every function takes the instant and the
// time zone it works in, so tests cross midnight and daylight-saving switches
// without touching the machine's clock.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** "23:30" -> { h: 23, m: 30 }. Throws on anything else. */
export function parseHHMM(text) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text).trim())
  if (!match) throw new Error(`not a time of day (HH:MM): ${text}`)
  return { h: Number(match[1]), m: Number(match[2]) }
}

const formats = new Map()
function formatFor(zone) {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formats.set(zone, format)
  }
  return format
}

/** The local calendar fields of an instant in `zone`. */
export function localParts(ms, zone) {
  const parts = {}
  for (const { type, value } of formatFor(zone).formatToParts(new Date(ms))) parts[type] = value
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  }
}

/** "2026-10-29" for an instant in `zone`. */
export function localDate(ms, zone) {
  const { y, mo, d } = localParts(ms, zone)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "06:30" for an instant in `zone`. */
export function localTime(ms, zone) {
  const { h, mi } = localParts(ms, zone)
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/** How far `zone` is ahead of UTC at instant `ms`, in milliseconds. */
export function zoneOffset(ms, zone) {
  const p = localParts(ms, zone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at which the local clock in `zone` shows y-mo-d h:mi. A time that
 * does not exist (skipped by a spring-forward) lands just after the gap; a time
 * that exists twice (autumn) is its first occurrence.
 */
export function localToInstant({ y, mo, d, h, mi }, zone) {
  // A day either side of any switch carries the two offsets in play that day.
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess - zoneOffset(guess - DAY, zone)
  const second = guess - zoneOffset(guess + DAY, zone)
  const candidates = [first, second].filter((t) => {
    const p = localParts(t, zone)
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi
  })
  if (candidates.length) return Math.min(...candidates)
  return Math.max(first, second)
}

/** The local date `days` after the one `ms` falls on. */
function shiftDay(ms, zone, days) {
  const { y, mo, d } = localParts(ms, zone)
  const t = new Date(Date.UTC(y, mo - 1, d) + days * DAY)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** The first instant at or after `ms` whose local time is `hhmm`. */
export function nextAt(hhmm, ms, zone) {
  const { h, m } = parseHHMM(hhmm)
  for (let days = 0; days < 3; days++) {
    const t = localToInstant({ ...shiftDay(ms, zone, days), h, mi: m }, zone)
    if (t >= ms) return t
  }
  throw new Error(`no next ${hhmm} after ${new Date(ms).toISOString()}`)
}

/** The last instant at or before `ms` whose local time is `hhmm`. */
export function lastAt(hhmm, ms, zone) {
  const { h, m } = parseHHMM(hhmm)
  for (let days = 0; days > -3; days--) {
    const t = localToInstant({ ...shiftDay(ms, zone, days), h, mi: m }, zone)
    if (t <= ms) return t
  }
  throw new Error(`no last ${hhmm} before ${new Date(ms).toISOString()}`)
}

/**
 * The night to arm at `ms` for a from-to window: the window running now if `ms` is
 * inside one (then it starts at `ms`), else the next one. `date` is the local date
 * the night starts on, which names its folder.
 */
export function planNight({ from, to }, ms, zone) {
  parseHHMM(from)
  parseHHMM(to)
  if (from === to) throw new Error('from and to are the same time')
  const lastFrom = lastAt(from, ms, zone)
  const endOfLast = nextAt(to, lastFrom, zone)
  const inside = ms < endOfLast
  const start = inside ? ms : nextAt(from, ms, zone)
  const end = inside ? endOfLast : nextAt(to, start, zone)
  return { start, end, date: localDate(inside ? lastFrom : start, zone), inside }
}

/** "2026-10-29 22:30:00 UTC": an exact instant systemd's OnCalendar understands. */
export function calendarUtc(ms) {
  return `${new Date(Math.ceil(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
