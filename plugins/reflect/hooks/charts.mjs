// The pane's drawings: numbers in, one <svg> card out. Pure: no Node, no engine.
//
// A mod cannot know whether the app around it is light or dark, and outside an
// Svg element it has only plain text to draw with. So every card brings its own
// surface and type and looks the same wherever it lands: a dark instrument
// panel, serif figures over monospace labels.
//
// Colour is used for two jobs only. Where a chart has one series, its marks are
// neutral and the peak alone is lit in the accent, with its value written beside
// it. Where the series are different things (models, kinds of work), they take
// a categorical palette validated for colour-blind separation on a dark surface,
// in fixed order, and "Other" is always neutral. Text stays in ink.
//
// A mod's SVG cannot run scripts, so the hover layer is a <title> on every mark.
import { dayLabel, percent } from './format.mjs'

export const WIDTH = 360
/** A mod's Svg element takes at most this many characters. */
export const SVG_LIMIT = 131072

const PAD = 16
const INNER = WIDTH - 2 * PAD
const SURFACE = '#161615'
const EDGE = '#2b2b28'
const RULE = '#262623'
const INK = '#f1eee6'
const INK_2 = '#b9b5a8'
const INK_3 = '#8a877c'
const MARK = '#8f8b80'
const PEAK = '#e3855e'
const EMPTY = '#21211f'
/** Up to four named series, in this order; anything past them, and "Other", is neutral. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500']
const NEUTRAL = '#6b685f'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONO = '"JetBrains Mono","JetBrainsMono Nerd Font","Cascadia Mono","SF Mono","Noto Sans Mono","DejaVu Sans Mono",monospace'
const SERIF = '"Noto Serif","Source Serif 4","New York",Georgia,"DejaVu Serif",serif'
// A monospace glyph is six tenths of its size wide, near enough to cut and wrap text by.
const GLYPH = 0.6

const STYLE = `
text{font-family:${MONO};font-size:10px;fill:${INK_2}}
.eyebrow{fill:${INK_3};letter-spacing:.09em}
.dim{fill:${INK_3}}
.ink{fill:${INK}}
.figure{font-family:${SERIF};fill:${INK}}
.hero{font-size:46px}
.stat{font-size:21px}
.rule{stroke:${RULE};stroke-width:1}
.mark{fill:${MARK}}
.peak{fill:${PEAK}}
.empty{fill:${EMPTY}}
.hot:hover{fill:${INK}}
.s:hover{stroke:${INK};stroke-width:1}
.rise{transform-box:fill-box;transform-origin:50% 100%;animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.run{transform-box:fill-box;transform-origin:0 50%;animation:run .5s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{transform:scaleY(0)}}
@keyframes run{from{transform:scaleX(0)}}
@media (prefers-reduced-motion: reduce){.rise,.run{animation:none}}`

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** `text` cut to what fits in `width` units at `size`, with an ellipsis when cut. */
function fit(text, width, size = 10) {
  const max = Math.max(1, Math.floor(width / (size * GLYPH)))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
/** `text` broken into lines of at most `max` characters, at spaces where it can. */
export function wrap(text, max) {
  const lines = []
  let line = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > max) {
      if (line !== '') lines.push(line)
      lines.push(rest.slice(0, max))
      rest = rest.slice(max)
      line = ''
    }
    if (line === '') line = rest
    else if (line.length + 1 + rest.length <= max) line += ` ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  if (line !== '') lines.push(line)
  return lines
}
const colourOf = (name, i) => (name === 'Other' || i >= SERIES.length ? NEUTRAL : SERIES[i])

// Every card: the surface, a hairline edge, and a small caption top left with
// an optional remark top right. What the card holds starts at y = 40.
function open(height, eyebrow = '', aside = '') {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}"><style>${STYLE}</style>`,
    `<rect x=".5" y=".5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${SURFACE}" stroke="${EDGE}"/>`,
  ]
  const room = aside === '' ? INNER : INNER - (aside.length + 2) * 10 * GLYPH * 1.09
  if (eyebrow !== '') parts.push(`<text class="eyebrow" x="${PAD}" y="25">${esc(fit(eyebrow.toUpperCase(), room / 1.09))}</text>`)
  if (aside !== '') parts.push(`<text class="eyebrow" x="${WIDTH - PAD}" y="25" text-anchor="end">${esc(aside.toUpperCase())}</text>`)
  return parts
}

// A drawing that is too large is not drawn at all by the pane, and the pane with it.
function close(parts) {
  parts.push('</svg>')
  const svg = parts.join('')
  if (svg.length <= SVG_LIMIT) return svg
  return [...open(56, 'Too much to draw'), `<text x="${PAD}" y="42">This range has more than fits in one drawing.</text>`, '</svg>'].join('')
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
const MAX_BAR = 22
function slot(i, step, gap, left) {
  const width = Math.min(MAX_BAR, Math.max(1, step - gap))
  return { x: left + i * step + (step - width) / 2, width }
}
const gapFor = (step) => (step > 6 ? 2 : step > 3 ? 1 : 0)
const peakOf = (values) => values.reduce((best, value, i) => (value > values[best] ? i : best), 0)

// The first and last column named along the bottom, and the middle one when there is room.
function columnLabels(parts, columns, left, right, y) {
  if (columns.length === 0) return
  const step = (right - left) / columns.length
  const last = columns.length - 1
  const seen = new Set()
  for (const [i, anchor] of [[0, 'start'], [Math.floor(last / 2), 'middle'], [last, 'end']]) {
    if (seen.has(i)) continue
    seen.add(i)
    const x = anchor === 'start' ? left : anchor === 'end' ? right : left + (i + 0.5) * step
    parts.push(`<text class="dim" x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}">${esc(columns[i].label)}</text>`)
  }
}

// The peak's own caption: what it is and how much, kept inside the card's edges.
function peakCaption(parts, text, x, y, left, right) {
  const half = (text.length * 10 * GLYPH) / 2
  const at = Math.min(right - half, Math.max(left + half, x))
  parts.push(`<text class="ink" x="${at.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(text)}</text>`)
}

/**
 * The lead card of a tab: one large figure, what moved, and its history as a strip of columns.
 * @param {{ eyebrow: string, aside?: string, figure: string, unit: string, note?: string,
 *           columns: { label: string, title: string, value: number }[], format: (n: number) => string }} card
 */
export function heroCard({ eyebrow, aside = '', figure, unit, note = '', columns, format }) {
  const top = 112
  const plot = 62
  const parts = open(top + plot + 34, eyebrow, aside)
  parts.push(`<text class="figure hero" x="${PAD}" y="76">${esc(figure)}</text>`)
  const after = PAD + figure.length * 46 * 0.56 + 10
  parts.push(`<text class="dim" x="${after.toFixed(1)}" y="62">${esc(fit(unit, WIDTH - PAD - after))}</text>`)
  if (note !== '') parts.push(`<text x="${after.toFixed(1)}" y="76">${esc(fit(note, WIDTH - PAD - after))}</text>`)

  const values = columns.map((each) => each.value)
  const max = Math.max(1, ...values)
  const peak = peakOf(values)
  const step = INNER / Math.max(1, columns.length)
  const gap = gapFor(step)
  parts.push(`<line class="rule" x1="${PAD}" x2="${WIDTH - PAD}" y1="${top + plot + 0.5}" y2="${top + plot + 0.5}"/>`)
  columns.forEach((each, i) => {
    if (each.value <= 0) return
    const { x, width } = slot(i, step, gap, PAD)
    const height = Math.max(1.5, (each.value / max) * plot)
    parts.push(
      `<rect class="${i === peak ? 'peak' : 'mark'} hot rise" x="${x.toFixed(1)}" y="${(top + plot - height).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="${Math.min(1.5, width / 2).toFixed(1)}">` +
        `<title>${esc(each.title)}: ${esc(format(each.value))} ${esc(unit)}</title></rect>`,
    )
  })
  if (columns.length > 0 && values[peak] > 0) {
    const { x, width } = slot(peak, step, gap, PAD)
    peakCaption(parts, `${columns[peak].title} · ${format(values[peak])}`, x + width / 2, top - 6, PAD, WIDTH - PAD)
  }
  columnLabels(parts, columns, PAD, WIDTH - PAD, top + plot + 18)
  return close(parts)
}

/**
 * Headline numbers, two to a row.
 * @param {{ label: string, figure: string, note: string }[]} items
 */
export function statCard(items) {
  const row = 62
  const rows = Math.ceil(items.length / 2)
  const half = WIDTH / 2
  const parts = open(rows * row + 12)
  for (let r = 1; r < rows; r += 1) {
    parts.push(`<line class="rule" x1="${PAD}" x2="${WIDTH - PAD}" y1="${r * row + 6.5}" y2="${r * row + 6.5}"/>`)
  }
  if (items.length > 1) parts.push(`<line class="rule" x1="${half + 0.5}" x2="${half + 0.5}" y1="14" y2="${rows * row - 2}"/>`)
  items.forEach((each, i) => {
    const x = (i % 2) * half + PAD
    const y = Math.floor(i / 2) * row + 6
    const room = half - 2 * PAD + 8
    parts.push(`<text class="eyebrow" x="${x}" y="${y + 20}">${esc(fit(each.label.toUpperCase(), room / 1.09))}</text>`)
    parts.push(`<text class="figure stat" x="${x}" y="${y + 43}">${esc(each.figure)}</text>`)
    parts.push(`<text class="dim" x="${x}" y="${y + 57}">${esc(fit(each.note, room))}<title>${esc(each.note)}</title></text>`)
  })
  return close(parts)
}

/**
 * One series as columns, the tallest lit and captioned.
 * @param {{ eyebrow: string, aside?: string, columns: { label: string, title: string, value: number }[],
 *           format: (n: number) => string, unit: string }} card
 */
export function columnCard({ eyebrow, aside = '', columns, format, unit }) {
  const left = PAD + 30
  const top = 54
  const plot = 84
  const values = columns.map((each) => each.value)
  const max = niceMax(Math.max(0, ...values))
  const peak = peakOf(values)
  const step = (WIDTH - PAD - left) / Math.max(1, columns.length)
  const gap = gapFor(step)
  const parts = open(top + plot + 34, eyebrow, aside)

  for (const share of [0, 0.5, 1]) {
    const y = top + plot - share * plot + 0.5
    parts.push(`<line class="rule" x1="${left}" x2="${WIDTH - PAD}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="dim" x="${left - 6}" y="${y + 3}" text-anchor="end">${share === 0 ? '0' : esc(format(max * share))}</text>`)
  }
  columns.forEach((each, i) => {
    if (each.value <= 0) return
    const { x, width } = slot(i, step, gap, left)
    const height = Math.max(1.5, (each.value / max) * plot)
    parts.push(
      `<rect class="${i === peak ? 'peak' : 'mark'} hot rise" x="${x.toFixed(1)}" y="${(top + plot - height).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="${Math.min(1.5, width / 2).toFixed(1)}">` +
        `<title>${esc(each.title)}: ${esc(format(each.value))} ${esc(unit)}</title></rect>`,
    )
  })
  if (columns.length > 0 && values[peak] > 0) {
    const { x, width } = slot(peak, step, gap, left)
    const height = (values[peak] / max) * plot
    peakCaption(parts, `${columns[peak].title} · ${format(values[peak])}`, x + width / 2, top + plot - height - 5, left, WIDTH - PAD)
  }
  columnLabels(parts, columns, left, WIDTH - PAD, top + plot + 18)
  return close(parts)
}

// A list of series under a chart: a swatch and a name on the left, the value and its share on the right.
function seriesRows(parts, items, top, format) {
  const total = items.reduce((sum, each) => sum + each.value, 0) || 1
  items.forEach((each, i) => {
    const y = top + i * 18
    parts.push(`<rect x="${PAD}" y="${y - 8}" width="8" height="8" rx="2" fill="${colourOf(each.name, i)}"/>`)
    parts.push(`<text x="${PAD + 14}" y="${y}">${esc(fit(each.name, 170))}<title>${esc(each.name)}</title></text>`)
    parts.push(`<text class="ink" x="${WIDTH - PAD - 44}" y="${y}" text-anchor="end">${esc(format(each.value))}</text>`)
    parts.push(`<text class="dim" x="${WIDTH - PAD}" y="${y}" text-anchor="end">${esc(percent(each.value / total))}</text>`)
  })
  return items.length * 18
}

/**
 * Several series stacked into columns, with the series listed beneath.
 * @param {{ eyebrow: string, aside?: string, columns: { label: string, title: string, values: Record<string, number> }[],
 *           names: string[], format: (n: number) => string, nameOf?: (name: string) => string }} card
 *   `names` in the order their colours are given; "Other" is neutral
 */
export function stackedCard({ eyebrow, aside = '', columns, names, format, nameOf = (name) => name }) {
  const left = PAD + 30
  const top = 44
  const plot = 84
  const totalOf = (each) => names.reduce((sum, name) => sum + (each.values[name] ?? 0), 0)
  const max = niceMax(Math.max(0, ...columns.map(totalOf)))
  const step = (WIDTH - PAD - left) / Math.max(1, columns.length)
  const gap = gapFor(step)
  const listTop = top + plot + 44
  const parts = open(listTop + names.length * 18, eyebrow, aside)

  for (const share of [0, 0.5, 1]) {
    const y = top + plot - share * plot + 0.5
    parts.push(`<line class="rule" x1="${left}" x2="${WIDTH - PAD}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="dim" x="${left - 6}" y="${y + 3}" text-anchor="end">${share === 0 ? '0' : esc(format(max * share))}</text>`)
  }
  columns.forEach((each, i) => {
    const { x, width } = slot(i, step, gap, left)
    let y = top + plot
    names.forEach((name, series) => {
      const value = each.values[name] ?? 0
      if (value <= 0) return
      const height = (value / max) * plot
      y -= height
      parts.push(
        `<rect class="s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" ` +
          `height="${Math.max(0.5, height - 0.5).toFixed(1)}" fill="${colourOf(name, series)}">` +
          `<title>${esc(each.title)}, ${esc(nameOf(name))}: ${esc(format(value))}</title></rect>`,
      )
    })
  })
  columnLabels(parts, columns, left, WIDTH - PAD, top + plot + 18)
  const totals = names.map((name) => ({ name: nameOf(name), value: columns.reduce((sum, each) => sum + (each.values[name] ?? 0), 0) }))
  // The legend keeps each series' own colour slot, so "Other" stays neutral under any display name.
  totals.forEach((each, i) => {
    const y = listTop + i * 18
    parts.push(`<rect x="${PAD}" y="${y - 8}" width="8" height="8" rx="2" fill="${colourOf(names[i], i)}"/>`)
    parts.push(`<text x="${PAD + 14}" y="${y}">${esc(fit(each.name, 200))}</text>`)
    parts.push(`<text class="ink" x="${WIDTH - PAD}" y="${y}" text-anchor="end">${esc(format(each.value))}</text>`)
  })
  return close(parts)
}

/** Prompts by weekday and hour, the busiest cell lit. @param {{ eyebrow: string, aside?: string, hours: number[][] }} card */
export function hourCard({ eyebrow, aside = '', hours }) {
  const left = PAD + 26
  const top = 40
  const cell = (WIDTH - PAD - left) / 24
  const row = 15
  const flat = hours.flat()
  const max = Math.max(1, ...flat)
  const peak = flat.indexOf(max)
  const parts = open(top + 7 * row + 26, eyebrow, aside)

  hours.forEach((counts, r) => {
    parts.push(`<text class="dim" x="${PAD}" y="${top + r * row + 10}">${WEEKDAYS[r]}</text>`)
    counts.forEach((n, hour) => {
      const shape = `x="${(left + hour * cell).toFixed(1)}" y="${top + r * row}" width="${(cell - 1.5).toFixed(1)}" height="${row - 2}" rx="2"`
      const label = `<title>${WEEKDAYS[r]} ${String(hour).padStart(2, '0')}:00: ${n} prompts</title>`
      if (n <= 0) parts.push(`<rect class="empty" ${shape}>${label}</rect>`)
      else if (r * 24 + hour === peak) parts.push(`<rect class="peak hot" ${shape}>${label}</rect>`)
      else parts.push(`<rect class="mark hot" fill-opacity="${(0.22 + (0.78 * n) / max).toFixed(2)}" ${shape}>${label}</rect>`)
    })
  })
  for (const hour of [0, 6, 12, 18]) {
    parts.push(`<text class="dim" x="${(left + hour * cell).toFixed(1)}" y="${top + 7 * row + 12}">${String(hour).padStart(2, '0')}:00</text>`)
  }
  return close(parts)
}

/**
 * A calendar: one column per week, one cell per day, brighter for more, the best day lit.
 * @param {{ eyebrow: string, aside?: string, unit: string,
 *           calendar: { weeks: ({ day: string, value: number } | null)[][], months: { column: number, label: string }[] } }} card
 */
export function calendarCard({ eyebrow, aside = '', calendar: { weeks, months }, unit }) {
  const left = PAD + 26
  const top = 54
  const cell = Math.min(13, (WIDTH - PAD - left) / Math.max(1, weeks.length))
  const days = weeks.flat().filter((each) => each !== null)
  const max = Math.max(1, ...days.map((each) => each.value))
  const best = days.find((each) => each.value === max && max > 0)?.day
  const parts = open(top + 7 * cell + 14, eyebrow, aside)

  for (const { column, label } of months) {
    parts.push(`<text class="dim" x="${(left + column * cell).toFixed(1)}" y="${top - 6}">${esc(label)}</text>`)
  }
  for (const r of [0, 2, 4, 6]) {
    parts.push(`<text class="dim" x="${PAD}" y="${(top + r * cell + cell * 0.75).toFixed(1)}">${WEEKDAYS[r]}</text>`)
  }
  weeks.forEach((week, column) => {
    week.forEach((each, r) => {
      if (each === null) return
      const shape =
        `x="${(left + column * cell).toFixed(1)}" y="${(top + r * cell).toFixed(1)}" ` +
        `width="${(cell - 1.5).toFixed(1)}" height="${(cell - 1.5).toFixed(1)}" rx="2"`
      const label = `<title>${dayLabel(each.day)}: ${each.value} ${esc(unit)}</title>`
      if (each.value <= 0) parts.push(`<rect class="empty" ${shape}>${label}</rect>`)
      else if (each.day === best) parts.push(`<rect class="peak hot" ${shape}>${label}</rect>`)
      else parts.push(`<rect class="mark hot" fill-opacity="${(0.22 + (0.78 * each.value) / max).toFixed(2)}" ${shape}>${label}</rect>`)
    })
  })
  return close(parts)
}

/**
 * Ranked horizontal bars, the first lit.
 * @param {{ eyebrow: string, aside?: string, format: (n: number) => string,
 *           rows: { name: string, value: number, label?: string }[] }} card
 *   a row's `label` is drawn in place of a long `name`, which stays in the tooltip
 */
export function rankCard({ eyebrow, aside = '', rows, format }) {
  const top = 40
  const rowHeight = 22
  const labelWidth = 128
  const valueWidth = 52
  const barLeft = PAD + labelWidth
  const barWidth = INNER - labelWidth - valueWidth
  const max = Math.max(1, ...rows.map((each) => each.value))
  const parts = open(top + Math.max(1, rows.length) * rowHeight + 6, eyebrow, aside)

  if (rows.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${top + 12}">Nothing in this range.</text>`)
  rows.forEach((each, i) => {
    const y = top + i * rowHeight
    const width = Math.max(1.5, (each.value / max) * barWidth)
    parts.push(`<text x="${PAD}" y="${y + 13}">${esc(fit(each.label ?? each.name, labelWidth - 8))}<title>${esc(each.name)}</title></text>`)
    parts.push(`<rect class="empty" x="${barLeft}" y="${y + 5}" width="${barWidth}" height="9" rx="2"/>`)
    parts.push(
      `<rect class="${i === 0 ? 'peak' : 'mark'} hot run" x="${barLeft}" y="${y + 5}" width="${width.toFixed(1)}" height="9" rx="2">` +
        `<title>${esc(each.name)}: ${esc(format(each.value))}</title></rect>`,
    )
    parts.push(`<text class="ink" x="${WIDTH - PAD}" y="${y + 13}" text-anchor="end">${esc(format(each.value))}</text>`)
  })
  return close(parts)
}

/**
 * One bar cut into shares, with each share listed beneath. At most four named parts and an "Other".
 * @param {{ eyebrow: string, aside?: string, parts: { name: string, value: number }[], format: (n: number) => string }} card
 */
export function shareCard({ eyebrow, aside = '', parts: shares, format }) {
  const top = 40
  const total = shares.reduce((sum, each) => sum + each.value, 0) || 1
  const parts = open(top + 30 + Math.max(1, shares.length) * 18, eyebrow, aside)

  if (shares.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${top + 12}">Nothing in this range.</text>`)
  let x = PAD
  shares.forEach((each, i) => {
    const width = Math.max(2, (each.value / total) * (INNER - 2 * (shares.length - 1)))
    parts.push(
      `<rect class="s run" x="${x.toFixed(1)}" y="${top}" width="${width.toFixed(1)}" height="10" rx="2" fill="${colourOf(each.name, i)}">` +
        `<title>${esc(each.name)}: ${esc(format(each.value))} (${esc(percent(each.value / total))})</title></rect>`,
    )
    x += width + 2
  })
  seriesRows(parts, shares, top + 34, format)
  return close(parts)
}

/**
 * Sentences in a card, each with a small mark in front and wrapped to the card's width.
 * @param {{ eyebrow: string, aside?: string, lines: string[] }} card
 */
export function textCard({ eyebrow, aside = '', lines }) {
  const top = 48
  const lineHeight = 15
  const max = Math.floor((INNER - 14) / (10 * GLYPH))
  const wrapped = lines.map((line) => wrap(line, max))
  const height = wrapped.reduce((sum, block) => sum + block.length * lineHeight + 7, 0)
  const parts = open(top + Math.max(height, lineHeight) - 2, eyebrow, aside)

  let y = top
  for (const block of wrapped) {
    parts.push(`<rect class="peak" x="${PAD}" y="${y - 7}" width="5" height="5" rx="1"/>`)
    block.forEach((line, i) => {
      parts.push(`<text ${i === 0 ? 'class="ink" ' : ''}x="${PAD + 14}" y="${y + i * lineHeight}">${esc(line)}</text>`)
    })
    y += block.length * lineHeight + 7
  }
  if (lines.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${top}">Nothing in this range.</text>`)
  return close(parts)
}
