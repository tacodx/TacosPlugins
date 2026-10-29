// Numbers, days and spans of time as the pane words them. Pure: no Node, no engine.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 6215 -> "6,215". */
export const count = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** As `count` up to 99,999; then "128K", "2.4M": a figure never wider than six characters. */
export function compact(n) {
  if (n < 99_999.5) return count(n)
  if (n < 999_500) return `${Math.round(n / 1e3)}K`
  return `${(n / 1e6).toFixed(1)}M`
}

/** "1 commit", "2 commits". */
export const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/** "2026-10-29" -> "Thu". */
export const weekday = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]

/** "2026-10-29" -> "Thu 29 Oct". */
export const dayLabel = (day) => `${weekday(day)} ${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`

/** 7 -> "07:00". */
export const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`

/** A span of time, coarse: "under a minute", "12 min", "1 h 5 min", "26 h". */
export function span(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours >= 10 || rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
