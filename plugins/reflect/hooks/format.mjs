// Numbers and names as the pane words them. Pure: no Node, no engine.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 6215 -> "6,215". */
export const count = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 950 -> "950", 35700 -> "36K", 94800000 -> "94.8M", 15600000000 -> "15.6B". */
export function tokens(n) {
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1e3)}K`
  if (n < 999_950_000) return `${(n / 1e6).toFixed(1)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

/** A share between 0 and 1 as a percentage. Something that is there never reads as 0%. */
export function percent(share) {
  const rounded = Math.round(share * 100)
  return share > 0 && rounded === 0 ? '<1%' : `${rounded}%`
}

/** 2700000 -> "45 min", 27000000 -> "7.5 h", 565200000 -> "157 h". */
export function duration(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = ms / 3_600_000
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`
}

/** "2026-10-07" -> "7 Oct". */
export const dayLabel = (day) => `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`

/** "2026-10" -> "Oct 2026". */
export const monthLabel = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`

/** "claude-opus-5-5" -> "Opus 5.5"; "claude-haiku-4-5-20251001" -> "Haiku 4.5". */
export function modelName(id) {
  const [family, ...version] = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  if (!family) return id
  const name = family[0].toUpperCase() + family.slice(1)
  return version.length > 0 ? `${name} ${version.join('.')}` : name
}

/** How a number moved against the one before it: "+42%", "-10%", or null when there is nothing to compare with. */
export function change(now, before) {
  if (!Number.isFinite(before) || before <= 0) return null
  const moved = Math.round(((now - before) / before) * 100)
  return `${moved >= 0 ? '+' : ''}${moved}%`
}

/** "tool" or "tools", by the number. */
export const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`
