// SVG builders: numbers in, one <svg> string out. Pure: no Node, no engine.
//
// Every drawing is 360 units wide, the width of a docked pane. Colours are a
// palette validated for colour-blind separation on a light and on a dark
// surface: the light steps by default, the dark ones under prefers-color-scheme.
// Text stays in ink, never in a series colour. A mod's SVG cannot run scripts,
// so the hover layer is a <title> on every mark.
import { dayLabel, percent } from './format.mjs'

export const WIDTH = 360
/** A mod's Svg element takes at most this many characters. */
export const SVG_LIMIT = 131072

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** Classes for up to four named series, then the neutral one for "Other". */
const SERIES = ['s1', 's2', 's3', 's4']

const STYLE = `
text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#898781}
.ink{fill:#52514e}
.grid{stroke:#898781;stroke-opacity:.25;stroke-width:1}
.zero{fill:#898781;fill-opacity:.12}
.s0{fill:#898781}.s1{fill:#2a78d6}.s2{fill:#eb6834}.s3{fill:#1baf7a}.s4{fill:#eda100}
.mark:hover{stroke:#898781;stroke-width:1.5}
@media (prefers-color-scheme: dark){
.ink{fill:#c3c2b7}.s1{fill:#3987e5}.s2{fill:#d95926}.s3{fill:#199e70}.s4{fill:#c98500}
}`

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const shorten = (name, max) => (name.length > max ? `${name.slice(0, max - 1)}…` : name)
const open = (height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}"><style>${STYLE}</style>`
const colourOf = (name, i) => (name === 'Other' || i >= SERIES.length ? 's0' : SERIES[i])

// A drawing that is too large is not drawn at all by the pane, and the pane with it.
function close(parts) {
  parts.push('</svg>')
  const svg = parts.join('')
  if (svg.length <= SVG_LIMIT) return svg
  return `${open(20)}<text x="0" y="13">Too much to draw here.</text></svg>`
}

// The top of the axis: the next round number, from a ladder fine enough that the
// tallest column fills most of the plot. The middle gridline is labelled with half
// of it, so every rung has a half that is itself round, and below ten only even
// tops are used (half of five prompts is no number of prompts).
const LADDER = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]
const SMALL_LADDER = [2, 4, 6, 8, 10]
function niceMax(value) {
  if (value <= 0) return 2
  const power = 10 ** Math.floor(Math.log10(value))
  const ladder = power < 10 ? SMALL_LADDER : LADDER
  return Math.round(ladder.find((step) => value / power <= step) * power)
}

// A column is at most this wide, however few there are, and sits in the middle of its slot.
const MAX_BAR = 24
function slot(i, step, gap, left) {
  const width = Math.min(MAX_BAR, Math.max(1, step - gap))
  return { x: left + i * step + (step - width) / 2, width }
}

// The frame every column chart shares: three gridlines with their values, and
// the first, middle and last column named along the bottom.
function columnFrame(parts, columns, max, format, { left, top, plot }) {
  for (const share of [0, 0.5, 1]) {
    const y = top + plot - share * plot
    parts.push(`<line class="grid" x1="${left}" x2="${WIDTH}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text x="${left - 5}" y="${y + 4}" text-anchor="end">${share === 0 ? '0' : esc(format(max * share))}</text>`)
  }
  if (columns.length === 0) return
  const step = (WIDTH - left) / columns.length
  const last = columns.length - 1
  const seen = new Set()
  for (const [i, anchor] of [[0, 'start'], [Math.floor(last / 2), 'middle'], [last, 'end']]) {
    if (seen.has(i)) continue
    seen.add(i)
    const x = anchor === 'start' ? left : anchor === 'end' ? WIDTH : left + (i + 0.5) * step
    parts.push(`<text x="${x.toFixed(1)}" y="${top + plot + 16}" text-anchor="${anchor}">${esc(columns[i].label)}</text>`)
  }
}

// A legend in two columns: a swatch, the name in ink, and the value after it.
function legend(parts, items, y, valueOf) {
  items.forEach((each, i) => {
    const x = (i % 2) * (WIDTH / 2)
    const row = y + Math.floor(i / 2) * 17
    parts.push(`<rect class="${colourOf(each.name, i)}" x="${x}" y="${row}" width="9" height="9" rx="2"/>`)
    parts.push(
      `<text class="ink" x="${x + 14}" y="${row + 9}">${esc(shorten(each.name, 14))} ` +
        `<tspan fill-opacity=".7">${esc(valueOf(each))}</tspan></text>`,
    )
  })
  return Math.ceil(items.length / 2) * 17
}

/**
 * One series as columns.
 * @param {{ label: string, title: string, value: number }[]} columns
 * @param {(n: number) => string} format how a value reads, on the axis and in the tooltip
 * @param {string} unit what the value counts, for the tooltip ("output tokens")
 */
export function columnChart(columns, format, unit) {
  const frame = { left: 34, top: 8, plot: 96 }
  const max = niceMax(Math.max(0, ...columns.map((each) => each.value)))
  const step = (WIDTH - frame.left) / Math.max(1, columns.length)
  const gap = step > 6 ? 2 : step > 3 ? 1 : 0
  const parts = [open(frame.top + frame.plot + 22)]
  columnFrame(parts, columns, max, format, frame)

  columns.forEach((each, i) => {
    if (each.value <= 0) return
    const { x, width } = slot(i, step, gap, frame.left)
    const height = Math.max(1.5, (each.value / max) * frame.plot)
    parts.push(
      `<rect class="s1 mark" x="${x.toFixed(1)}" y="${(frame.top + frame.plot - height).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="${Math.min(2, width / 2).toFixed(1)}">` +
        `<title>${esc(each.title)}: ${esc(format(each.value))} ${esc(unit)}</title></rect>`,
    )
  })
  return close(parts)
}

/**
 * Several series stacked into columns, with a legend.
 * @param {{ label: string, title: string, values: Record<string, number> }[]} columns
 * @param {string[]} names the series, in the order their colours are given; "Other" is neutral
 * @param {(name: string) => string} [nameOf] how a series is called in the legend and tooltips
 */
export function stackedColumnChart(columns, names, format, nameOf = (name) => name) {
  const frame = { left: 34, top: 8, plot: 96 }
  const totalOf = (each) => names.reduce((sum, name) => sum + (each.values[name] ?? 0), 0)
  const max = niceMax(Math.max(0, ...columns.map(totalOf)))
  const step = (WIDTH - frame.left) / Math.max(1, columns.length)
  const gap = step > 6 ? 2 : step > 3 ? 1 : 0
  const legendTop = frame.top + frame.plot + 30
  const parts = [open(legendTop + Math.ceil(names.length / 2) * 17)]
  columnFrame(parts, columns, max, format, frame)

  columns.forEach((each, i) => {
    const { x, width } = slot(i, step, gap, frame.left)
    let y = frame.top + frame.plot
    names.forEach((name, series) => {
      const value = each.values[name] ?? 0
      if (value <= 0) return
      const height = (value / max) * frame.plot
      y -= height
      parts.push(
        `<rect class="${colourOf(name, series)} mark" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
          `width="${width.toFixed(1)}" height="${Math.max(0.5, height - 0.5).toFixed(1)}">` +
          `<title>${esc(each.title)}, ${esc(nameOf(name))}: ${esc(format(value))}</title></rect>`,
      )
    })
  })
  const totals = names.map((name) => ({ name: nameOf(name), value: columns.reduce((sum, each) => sum + (each.values[name] ?? 0), 0) }))
  legend(parts, totals, legendTop, (each) => format(each.value))
  return close(parts)
}

/** Prompts by weekday and hour. @param {number[][]} hours 7 rows from Monday, 24 columns */
export function hourGrid(hours) {
  const left = 30
  const top = 2
  const cell = (WIDTH - left) / 24
  const row = 15
  const max = Math.max(1, ...hours.flat())
  const parts = [open(top + 7 * row + 16)]

  hours.forEach((counts, r) => {
    parts.push(`<text x="0" y="${top + r * row + 10}">${WEEKDAYS[r]}</text>`)
    counts.forEach((n, hour) => {
      const shape = `x="${(left + hour * cell).toFixed(1)}" y="${top + r * row}" width="${(cell - 1.5).toFixed(1)}" height="${row - 2}" rx="2"`
      const label = `<title>${WEEKDAYS[r]} ${String(hour).padStart(2, '0')}:00: ${n} prompts</title>`
      parts.push(
        n > 0
          ? `<rect class="s1 mark" fill-opacity="${(0.18 + (0.82 * n) / max).toFixed(2)}" ${shape}>${label}</rect>`
          : `<rect class="zero" ${shape}>${label}</rect>`,
      )
    })
  })
  for (const hour of [0, 6, 12, 18]) {
    parts.push(`<text x="${(left + hour * cell).toFixed(1)}" y="${top + 7 * row + 11}">${String(hour).padStart(2, '0')}:00</text>`)
  }
  return close(parts)
}

/**
 * A calendar: one column per week, one cell per day, darker for more.
 * @param {{ weeks: ({ day: string, value: number } | null)[][], months: { column: number, label: string }[] }} calendar
 * @param {string} unit what a day's value counts, for the tooltip ("prompts")
 */
export function calendarChart({ weeks, months }, unit) {
  const left = 26
  const top = 14
  const cell = Math.min(13, (WIDTH - left) / Math.max(1, weeks.length))
  const max = Math.max(1, ...weeks.flat().map((each) => each?.value ?? 0))
  const parts = [open(top + 7 * cell + 4)]

  for (const { column, label } of months) {
    parts.push(`<text x="${(left + column * cell).toFixed(1)}" y="10">${esc(label)}</text>`)
  }
  for (const r of [0, 2, 4, 6]) {
    parts.push(`<text x="0" y="${(top + r * cell + cell * 0.75).toFixed(1)}">${WEEKDAYS[r]}</text>`)
  }
  weeks.forEach((week, column) => {
    week.forEach((each, r) => {
      if (each === null) return
      const shape =
        `x="${(left + column * cell).toFixed(1)}" y="${(top + r * cell).toFixed(1)}" ` +
        `width="${(cell - 1.5).toFixed(1)}" height="${(cell - 1.5).toFixed(1)}" rx="2"`
      const label = `<title>${dayLabel(each.day)}: ${each.value} ${esc(unit)}</title>`
      parts.push(
        each.value > 0
          ? `<rect class="s1 mark" fill-opacity="${(0.18 + (0.82 * each.value) / max).toFixed(2)}" ${shape}>${label}</rect>`
          : `<rect class="zero" ${shape}>${label}</rect>`,
      )
    })
  })
  return close(parts)
}

/**
 * Ranked horizontal bars.
 * @param {{ name: string, value: number, label?: string }[]} rows `label` is drawn in place of
 *   a long `name`, which stays in the tooltip
 */
export function rankBars(rows, format) {
  const rowHeight = 20
  const labelWidth = 124
  const valueWidth = 52
  const barWidth = WIDTH - labelWidth - valueWidth - 6
  const max = Math.max(1, ...rows.map((each) => each.value))
  const parts = [open(Math.max(1, rows.length) * rowHeight)]

  if (rows.length === 0) parts.push('<text x="0" y="13">Nothing in this range.</text>')
  rows.forEach((each, i) => {
    const y = i * rowHeight
    const width = Math.max(1.5, (each.value / max) * barWidth)
    parts.push(`<text class="ink" x="0" y="${y + 13}">${esc(shorten(each.label ?? each.name, 18))}<title>${esc(each.name)}</title></text>`)
    parts.push(
      `<rect class="s1 mark" x="${labelWidth}" y="${y + 4}" width="${width.toFixed(1)}" height="10" rx="2">` +
        `<title>${esc(each.name)}: ${esc(format(each.value))}</title></rect>`,
    )
    parts.push(`<text class="ink" x="${WIDTH}" y="${y + 13}" text-anchor="end">${esc(format(each.value))}</text>`)
  })
  return close(parts)
}

/** One stacked bar of shares with its legend. At most four named parts and an "Other". */
export function shareBar(parts, format) {
  const total = parts.reduce((sum, each) => sum + each.value, 0) || 1
  const out = [open(12 + 10 + Math.ceil(parts.length / 2) * 17)]

  let x = 0
  parts.forEach((each, i) => {
    const width = Math.max(2, (each.value / total) * (WIDTH - 2 * (parts.length - 1)))
    out.push(
      `<rect class="${colourOf(each.name, i)} mark" x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="12" rx="2">` +
        `<title>${esc(each.name)}: ${esc(format(each.value))} (${esc(percent(each.value / total))})</title></rect>`,
    )
    x += width + 2
  })
  legend(out, parts, 22, (each) => `${format(each.value)} · ${percent(each.value / total)}`)
  return close(out)
}
