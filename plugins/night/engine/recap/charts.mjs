// The recap's three drawings as SVG text: commits per hour stacked by project,
// commits per project, and each project's % done at dusk and now. Pure: the recap
// object in, strings out.
//
// The page is read on a phone as often as at a desk, so no drawing scales its text.
// Each SVG is as wide as its column and has no viewBox: marks are placed across in
// percent and down in pixels, and a label is 12 px at every width. A column's shape
// sits in a nested <svg> placed at a percent, so its top can be rounded in pixels.
//
// Colour does one job: it names the project, in the fixed slot order of a palette
// checked for colour-blind separation on both of the page's surfaces. Each colour is
// a CSS variable the page sets for light and dark. Text wears ink, never a series
// colour. Hover text is a <title> on each mark, and each drawing's <desc> says in
// words everything it shows.

/** The categorical slots in their fixed order, light and dark steps of the same eight hues. */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}
/** "Other", for projects past the seventh when there are more than eight. */
export const OTHER = { light: '#969ca8', dark: '#646c7b' }

export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const list = (v) => (Array.isArray(v) ? v : [])
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const sum = (values) => values.reduce((total, v) => total + (isNum(v) ? v : 0), 0)
const fixed = (n) => String(Math.round(n * 100) / 100)
/** 12,345 */
export const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** The rules the drawings need; the page puts them in its own <style> beside the colour tokens. */
export const CHART_CSS = `
.chart{display:block;width:100%;overflow:visible}
.chart text{font:12px/1 var(--sans);fill:var(--ink-2)}
.chart .num{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
.chart .ink{fill:var(--ink)}
.chart .dim{fill:var(--ink-3)}
.chart .strong{font-weight:600}
.chart .grid{stroke:var(--rule);stroke-width:1;shape-rendering:crispEdges}
.chart .base{stroke:var(--axis);stroke-width:1;shape-rendering:crispEdges}
.chart .track{fill:var(--track)}
.chart .dusk{fill:var(--dusk)}
.chart .gain{fill:var(--ink)}
.chart .lost{fill:var(--dusk);fill-opacity:.35}
.chart .gap{stroke:var(--bg);stroke-width:2}
.chart .hit{fill:transparent}
.chart .hit:hover{fill:var(--wash)}
.chart .mark:hover{opacity:.8}
.k1{fill:var(--s1)}.k2{fill:var(--s2)}.k3{fill:var(--s3)}.k4{fill:var(--s4)}
.k5{fill:var(--s5)}.k6{fill:var(--s6)}.k7{fill:var(--s7)}.k8{fill:var(--s8)}.ko{fill:var(--other)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 10px;font-size:.8125rem;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}
.legend svg{flex:none}
@media (max-width:520px){.chart .xn{display:none}}
@media (prefers-reduced-motion:reduce){.chart .mark:hover{opacity:1}}`

function open(id, height, title, desc) {
  return (
    `<svg class="chart" xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}" role="img" ` +
    `aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`
  )
}

function empty(id, title, note) {
  return `${open(id, 24, title, note)}<text x="0" y="16" class="dim">${esc(note)}</text></svg>`
}

// The top of the axis: the next round number, so the tallest column fills most of the
// plot and the middle gridline is a round number too (below ten only even tops).
const LADDER = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]
const SMALL_LADDER = [2, 4, 6, 8, 10]
function niceMax(value) {
  if (value <= 0) return 2
  const power = 10 ** Math.floor(Math.log10(value))
  const ladder = power < 10 ? SMALL_LADDER : LADDER
  return Math.round(ladder.find((step) => value / power <= step) * power)
}

/**
 * The stack the hourly chart draws, bottom up: each named project in its slot, then
 * one "Other" for every project folded into it.
 */
function stackOf(recap) {
  const named = []
  const folded = new Set()
  for (const s of list(recap?.series)) {
    if (isNum(s?.slot) && s.slot >= 0 && s.slot < SERIES.light.length) named.push({ names: [s.name], label: s.name, cls: `k${s.slot + 1}` })
    else folded.add(s?.name)
  }
  // A project in the hours that the series does not name is folded too.
  const known = new Set(named.map((s) => s.label))
  for (const h of list(recap?.perHour)) for (const name of Object.keys(h?.byProject ?? {})) if (!known.has(name)) folded.add(name)
  if (folded.size > 0) named.push({ names: [...folded], label: 'Other', cls: 'ko' })
  return named
}

/** The swatches that name the hourly chart's colours, as HTML; empty for a single project. */
export function legend(recap) {
  const stack = stackOf(recap)
  if (stack.length < 2) return ''
  const items = stack.map((s) =>
    `<span><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" class="${s.cls}"/></svg>${esc(s.label)}</span>`)
  return `<p class="legend">${items.join('')}</p>`
}

// A column's segment with a rounded top and a square foot, centred on 0.
function roundedTop(half, top, bottom) {
  const r = Math.min(4, half, (bottom - top) / 2)
  return (
    `M${fixed(-half)} ${fixed(bottom)}V${fixed(top + r)}A${fixed(r)} ${fixed(r)} 0 0 1 ${fixed(-half + r)} ${fixed(top)}` +
    `H${fixed(half - r)}A${fixed(r)} ${fixed(r)} 0 0 1 ${fixed(half)} ${fixed(top + r)}V${fixed(bottom)}Z`
  )
}

const hourRange = (label) => `${label}:00`

/** Commits per hour across the night, each column stacked by project. */
export function hourChart(recap) {
  const hours = list(recap?.perHour)
  const stack = stackOf(recap)
  const valueOf = (h, s) => sum(s.names.map((name) => h?.byProject?.[name]))
  const totals = hours.map((h) => sum(stack.map((s) => valueOf(h, s))))
  const all = sum(totals)
  const title = 'Commits per hour'
  if (hours.length === 0 || all === 0) return empty('hours', title, 'No commits in this window.')

  const busiest = totals.reduce((best, n, i) => (n > totals[best] ? i : best), 0)
  const busy = hours
    .map((h, i) => [h, totals[i]])
    .filter(([, n]) => n > 0)
    .map(([h, n]) => `${hourRange(h.label)} ${n}`)
  const desc =
    `${all} commits from ${hourRange(hours[0].label)} to ${hourRange(hours[hours.length - 1].label)}, by hour: ${busy.join(', ')}. ` +
    `The busiest hour was ${hourRange(hours[busiest].label)} with ${totals[busiest]}.`

  const TOP = 24
  const PLOT = 128
  const BASE = TOP + PLOT
  const HEIGHT = BASE + 24
  const LEFT = 8
  const step = (100 - LEFT) / hours.length
  const half = hours.length <= 14 ? 9 : hours.length <= 22 ? 6 : 4
  const GAP = 2
  const max = niceMax(Math.max(...totals))
  const parts = [open('hours', HEIGHT, title, desc)]

  for (const share of [0.5, 1]) {
    const y = BASE - share * PLOT + 0.5
    parts.push(`<line class="grid" x1="${LEFT}%" x2="100%" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="num dim" x="${LEFT - 1.5}%" y="${y + 4}" text-anchor="end">${group(max * share)}</text>`)
  }
  parts.push(`<line class="base" x1="${LEFT}%" x2="100%" y1="${BASE + 0.5}" y2="${BASE + 0.5}"/>`)
  parts.push(`<text class="num dim" x="${LEFT - 1.5}%" y="${BASE + 4}" text-anchor="end">0</text>`)

  const wide = hours.length <= 16 ? 1 : hours.length <= 32 ? 2 : 3
  const narrow = hours.length <= 7 ? 1 : hours.length <= 14 ? 2 : hours.length <= 21 ? 3 : 4
  hours.forEach((h, i) => {
    const centre = LEFT + (i + 0.5) * step
    const next = hours[i + 1]?.label ?? String((Number(h.label) + 1) % 24).padStart(2, '0')
    const split = stack.map((s) => [s.label, valueOf(h, s)]).filter(([, n]) => n > 0)
    const words = `${hourRange(h.label)} to ${hourRange(next)}: ${totals[i]} commit${totals[i] === 1 ? '' : 's'}` +
      (split.length > 1 ? ` (${split.map(([name, n]) => `${name} ${n}`).join(', ')})` : split.length === 1 ? `, ${split[0][0]}` : '')
    parts.push(
      `<rect class="hit" x="${fixed(LEFT + i * step)}%" y="${TOP}" width="${fixed(step)}%" height="${PLOT}"><title>${esc(words)}</title></rect>`,
    )
    if (totals[i] > 0) {
      const segments = stack.map((s) => ({ s, n: valueOf(h, s) })).filter(({ n }) => n > 0)
      let y = BASE
      const shapes = segments.map(({ s, n }, k) => {
        const height = (n / max) * PLOT
        const bottom = y - (k > 0 ? GAP : 0)
        const top = Math.min(bottom - 1, y - height)
        y -= height
        const shape = k === segments.length - 1
          ? `<path class="mark ${s.cls}" d="${roundedTop(half, top, bottom)}">`
          : `<rect class="mark ${s.cls}" x="${-half}" y="${fixed(top)}" width="${half * 2}" height="${fixed(bottom - top)}">`
        return `${shape}<title>${esc(`${hourRange(h.label)}, ${s.label}: ${n}`)}</title>${shape.startsWith('<path') ? '</path>' : '</rect>'}`
      })
      parts.push(`<svg x="${fixed(centre)}%" y="0" overflow="visible">${shapes.join('')}</svg>`)
    }
    if (i % wide === 0) {
      const cls = i % narrow === 0 ? 'num dim' : 'num dim xn'
      parts.push(`<text class="${cls}" x="${fixed(centre)}%" y="${BASE + 17}" text-anchor="middle">${esc(h.label)}</text>`)
    }
  })
  const peakTop = BASE - (totals[busiest] / max) * PLOT
  parts.push(
    `<text class="num ink strong" x="${fixed(LEFT + (busiest + 0.5) * step)}%" y="${fixed(peakTop - 7)}" text-anchor="middle">${totals[busiest]}</text>`,
  )
  parts.push('</svg>')
  return parts.join('')
}

/** Commits per project as horizontal bars, longest first, in each project's own colour. */
export function projectChart(recap) {
  const rows = list(recap?.perProject).filter((p) => isNum(p?.commits) && p.commits > 0)
  const title = 'Commits per project'
  if (rows.length === 0) return empty('projects', title, 'No commits in this window.')

  const ROW = 40
  const MAX_WIDTH = 84
  const max = Math.max(...rows.map((p) => p.commits))
  const desc = `${rows.map((p) => `${p.name} ${p.commits} commits, ${group(p.linesAdded ?? 0)} lines added and ${group(p.linesRemoved ?? 0)} removed`).join('; ')}.`
  const parts = [open('projects', rows.length * ROW, title, desc)]
  rows.forEach((p, i) => {
    const y = i * ROW
    const width = (p.commits / max) * MAX_WIDTH
    const cls = isNum(p.slot) && p.slot >= 0 && p.slot < SERIES.light.length ? `k${p.slot + 1}` : 'ko'
    const lines = `+${group(p.linesAdded ?? 0)} -${group(p.linesRemoved ?? 0)}`
    parts.push(`<text class="ink" x="0" y="${y + 13}">${esc(cut(String(p.name), 32))}<title>${esc(p.name)}</title></text>`)
    parts.push(`<text class="num dim" x="100%" y="${y + 13}" text-anchor="end">${esc(lines)}<title>lines added and removed</title></text>`)
    parts.push(
      `<g class="mark"><title>${esc(`${p.name}: ${p.commits} commits, ${lines} lines`)}</title>` +
        `<rect class="${cls}" x="0" y="${y + 20}" width="${fixed(width)}%" height="12" rx="4"/>` +
        `<rect class="${cls}" x="0" y="${y + 20}" width="4" height="12"/></g>`,
    )
    parts.push(`<text class="num ink strong" x="${fixed(width)}%" dx="7" y="${y + 30}">${p.commits}</text>`)
  })
  parts.push('</svg>')
  return parts.join('')
}

/** Each measured project's % done: grey up to dusk, ink for what tonight added, on a 0 to 100 track. */
export function progressChart(recap) {
  const rows = list(recap?.projects).filter((p) => isNum(p?.duskPct) && isNum(p?.nowPct))
  const title = 'Done at dusk and now'
  if (rows.length === 0) return empty('progress', title, 'No project has a plan to measure yet.')

  const ROW = 44
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v)))
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `-${-n}` : '+0')
  const desc = `${rows.map((p) => `${p.name} ${pct(p.duskPct)} % at dusk, ${pct(p.nowPct)} % now`).join('; ')}.`
  const parts = [
    open('progress', rows.length * ROW, title, desc),
    '<defs><clipPath id="progress-track"><rect x="0" y="21" width="100%" height="10" rx="5"/></clipPath></defs>',
  ]
  rows.forEach((p, i) => {
    const dusk = pct(p.duskPct)
    const now = pct(p.nowPct)
    const won = isNum(p.won) ? p.won : now - dusk
    const row = [`<svg y="${i * ROW}" overflow="visible">`]
    row.push(`<text class="ink" x="0" y="14">${esc(cut(String(p.name), 30))}<title>${esc(p.name)}</title></text>`)
    row.push(
      `<text class="num" x="100%" y="14" text-anchor="end"><tspan class="dim">${dusk} % to ${now} %</tspan> ` +
        `<tspan class="ink strong">${signed(won)}</tspan></text>`,
    )
    row.push(`<g clip-path="url(#progress-track)"><title>${esc(`${p.name}: ${dusk} % at dusk, ${now} % now, ${signed(won)} points`)}</title>`)
    row.push('<rect class="track" x="0" y="21" width="100%" height="10"/>')
    if (Math.min(dusk, now) > 0) row.push(`<rect class="dusk" x="0" y="21" width="${Math.min(dusk, now)}%" height="10"/>`)
    if (now > dusk) row.push(`<rect class="gain" x="${dusk}%" y="21" width="${now - dusk}%" height="10"/>`)
    if (now < dusk) row.push(`<rect class="lost" x="${now}%" y="21" width="${dusk - now}%" height="10"/>`)
    if (now !== dusk && dusk > 0 && dusk < 100) row.push(`<line class="gap" x1="${dusk}%" x2="${dusk}%" y1="21" y2="31"/>`)
    row.push('</g></svg>')
    parts.push(row.join(''))
  })
  parts.push('</svg>')
  return parts.join('')
}
