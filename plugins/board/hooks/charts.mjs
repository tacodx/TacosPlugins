// The pane's drawings: numbers in, one <svg> card out. Pure: no Node, no engine.
//
// The cards are reflect's: a mod cannot know whether the app around it is light
// or dark, so every card brings its own dark surface and type, serif figures
// over monospace labels, and looks the same wherever it lands.
//
// Colour does two jobs. Each project has one colour of eight, fixed from view
// to view (the reader keeps the book), so a project is found by its colour in
// every card; the eight are the dark steps of a categorical palette validated
// for colour-blind separation on this surface, in their validated order, and a
// project past them is neutral. The commits per hour are a single series in a
// single hue, so the shape of the day reads at once and a quiet night is a gap.
// Text stays in ink.
//
// A mod's SVG cannot run scripts, so the hover layer is a <title> on every mark.

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

/** One colour per project slot, in the palette's validated order. */
export const PROJECT_COLOURS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
/** A project without a slot, and "Other". */
export const NEUTRAL = '#6b685f'
/** The one hue of the commits per hour. */
export const ACTIVITY = '#e3855e'

export const colourOf = (slot) => (Number.isInteger(slot) && slot >= 0 && slot < PROJECT_COLOURS.length ? PROJECT_COLOURS[slot] : NEUTRAL)

const MONO = '"JetBrains Mono","JetBrainsMono Nerd Font","Cascadia Mono","SF Mono","Noto Sans Mono","DejaVu Sans Mono",monospace'
const SERIF = '"Noto Serif","Source Serif 4","New York",Georgia,"DejaVu Serif",serif'
// A monospace glyph is six tenths of its size wide, near enough to cut and wrap text by.
const GLYPH = 0.6

const STYLE = `
text{font-family:${MONO};font-size:10px;fill:${INK_2}}
.eyebrow{fill:${INK_3};letter-spacing:.09em}
.dim{fill:${INK_3}}
.ink{fill:${INK}}
.done{fill:${INK_3};text-decoration:line-through}
.figure{font-family:${SERIF};fill:${INK}}
.stat{font-size:24px}
.rule{stroke:${RULE};stroke-width:1}
.hot:hover{fill:${INK}}
.rise{transform-box:fill-box;transform-origin:50% 100%;animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{transform:scaleY(0)}}
@media (prefers-reduced-motion: reduce){.rise{animation:none}}`

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (n) => n.toFixed(1)
/** `text` cut to what fits in `width` units at `size`, with an ellipsis when cut. */
function fit(text, width, size = 10) {
  const max = Math.max(1, Math.floor(width / (size * GLYPH)))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
/** `text` broken into lines of at most `max` characters, at spaces where it can. */
function wrap(text, max) {
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

// Every card: the surface, a hairline edge, and a small caption top left with
// an optional remark top right. What the card holds starts at y = 40.
function open(height, eyebrow = '', aside = '') {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}"><style>${STYLE}</style>`,
    `<rect x=".5" y=".5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${SURFACE}" stroke="${EDGE}"/>`,
  ]
  const asideText = fit(aside.toUpperCase(), INNER / 2 / 1.09)
  const room = asideText === '' ? INNER : INNER - (asideText.length + 2) * 10 * GLYPH * 1.09
  if (eyebrow !== '') parts.push(`<text class="eyebrow" x="${PAD}" y="25">${esc(fit(eyebrow.toUpperCase(), room / 1.09))}</text>`)
  if (asideText !== '') parts.push(`<text class="eyebrow" x="${WIDTH - PAD}" y="25" text-anchor="end">${esc(asideText)}</text>`)
  return parts
}

// A drawing that is too large is not drawn at all by the pane, and the pane with it.
function close(parts) {
  parts.push('</svg>')
  const svg = parts.join('')
  if (svg.length <= SVG_LIMIT) return svg
  return [...open(56, 'Too much to draw'), `<text x="${PAD}" y="42">There is more here than fits in one drawing.</text>`, '</svg>'].join('')
}

// The top of the axis: the next round number, from a ladder fine enough that the
// tallest column fills most of the plot. The middle gridline is labelled with half
// of it, so every rung has a half that is itself round, and below ten only even
// tops are used (half of five commits is no number of commits).
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
function slot(i, step, left) {
  const gap = step > 6 ? 2 : step > 3 ? 1 : 0
  const width = Math.min(MAX_BAR, Math.max(1, step - gap))
  return { x: left + i * step + (step - width) / 2, width }
}

/** A column from `bottom` up to `top`: square at its base, and its data end rounded where `rounded`. */
function bar(x, width, bottom, top, rounded) {
  const r = rounded ? Math.min(4, width / 3, bottom - top) : 0
  if (r < 0.5) return `M${f(x)},${f(bottom)} V${f(top)} H${f(x + width)} V${f(bottom)} Z`
  return (
    `M${f(x)},${f(bottom)} V${f(top + r)} Q${f(x)},${f(top)} ${f(x + r)},${f(top)} ` +
    `H${f(x + width - r)} Q${f(x + width)},${f(top)} ${f(x + width)},${f(top + r)} V${f(bottom)} Z`
  )
}

/** Gridlines at nothing, half and all of `max`, each labelled at the left. */
function grid(parts, left, top, plot, max) {
  for (const share of [0, 0.5, 1]) {
    const y = top + plot - share * plot + 0.5
    parts.push(`<line class="rule" x1="${left}" x2="${WIDTH - PAD}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="dim" x="${left - 6}" y="${y + 3}" text-anchor="end">${share === 0 ? '0' : esc(String(max * share))}</text>`)
  }
}

/** "1 commit", "40 commits": `unit` is the word for one. */
const many = (n, unit) => `${n} ${n === 1 ? unit : `${unit}s`}`

/** A label under a column, kept inside the card's edges. */
function underLabel(parts, text, centre, y, left) {
  const half = (text.length * 10 * GLYPH) / 2
  const at = Math.min(WIDTH - PAD - half, Math.max(left + half, centre))
  parts.push(`<text class="dim" x="${f(at)}" y="${y}" text-anchor="middle">${esc(text)}</text>`)
}

/**
 * Headline figures in one row: what each counts above it, a few words below.
 * @param {{ label: string, figure: string, note: string }[]} items
 */
export function kpiCard(items) {
  const third = INNER / Math.max(1, items.length)
  const parts = open(76)
  items.forEach((each, i) => {
    const x = PAD + i * third
    const room = third - 10
    if (i > 0) parts.push(`<line class="rule" x1="${f(x - 6)}" x2="${f(x - 6)}" y1="16" y2="62"/>`)
    parts.push(`<text class="eyebrow" x="${f(x)}" y="25">${esc(fit(each.label.toUpperCase(), room / 1.09))}</text>`)
    parts.push(`<text class="figure stat" x="${f(x)}" y="51">${esc(fit(each.figure, room, 24 * 0.95))}</text>`)
    parts.push(`<text class="dim" x="${f(x)}" y="65">${esc(fit(each.note, room))}</text>`)
  })
  return close(parts)
}

/**
 * One series of columns in one hue: a quiet column draws nothing, so a quiet stretch is a gap.
 * @param {{ eyebrow: string, aside?: string, unit: string, empty?: string,
 *           columns: { label: string, title: string, value: number }[] }} card
 *   a column's `label` is written under it when it is not empty
 */
export function hoursCard({ eyebrow, aside = '', columns, unit, empty = 'No commits in these thirty hours.' }) {
  const left = PAD + 24
  const top = 48
  const plot = 72
  const values = columns.map((each) => each.value)
  const highest = Math.max(0, ...values)
  const max = niceMax(highest)
  const peak = values.indexOf(highest)
  const step = (WIDTH - PAD - left) / Math.max(1, columns.length)
  const parts = open(top + plot + 30, eyebrow, aside)

  grid(parts, left, top, plot, max)
  columns.forEach((each, i) => {
    if (each.value <= 0) return
    const { x, width } = slot(i, step, left)
    const height = Math.max(1.5, (each.value / max) * plot)
    parts.push(
      `<path class="bar hot rise" d="${bar(x, width, top + plot, top + plot - height, true)}" fill="${ACTIVITY}">` +
        `<title>${esc(each.title)}: ${esc(many(each.value, unit))}</title></path>`,
    )
  })
  if (highest > 0) {
    const { x, width } = slot(peak, step, left)
    const text = `${columns[peak].title} · ${highest}`
    const half = (text.length * 10 * GLYPH) / 2
    const at = Math.min(WIDTH - PAD - half, Math.max(left + half, x + width / 2))
    parts.push(`<text class="ink" x="${f(at)}" y="${f(top + plot - (highest / max) * plot - 5)}" text-anchor="middle">${esc(text)}</text>`)
  } else {
    parts.push(`<text class="dim" x="${f(left + (WIDTH - PAD - left) / 2)}" y="${top + plot / 2 + 3}" text-anchor="middle">${esc(empty)}</text>`)
  }
  columns.forEach((each, i) => {
    if (each.label !== '') underLabel(parts, each.label, left + (i + 0.5) * step, top + plot + 16, left)
  })
  return close(parts)
}

/**
 * Columns stacked from several series, each in its own colour, its total on the cap and the series listed beneath.
 * @param {{ eyebrow: string, aside?: string, unit: string,
 *           columns: { label: string, title: string, values: Record<string, number> }[],
 *           series: { name: string, colour: string }[] }} card
 *   `series` bottom of the stack first
 */
export function stackedCard({ eyebrow, aside = '', columns, series, unit }) {
  const left = PAD + 24
  const top = 54
  const plot = 96
  const totalOf = (each) => series.reduce((sum, { name }) => sum + (each.values[name] ?? 0), 0)
  const totals = columns.map(totalOf)
  const max = niceMax(Math.max(0, ...totals))
  const step = (WIDTH - PAD - left) / Math.max(1, columns.length)
  const legend = series
    .map((each, i) => ({ ...each, i, total: columns.reduce((sum, column) => sum + (column.values[each.name] ?? 0), 0) }))
    .filter((each) => each.total > 0)
    .sort((a, b) => b.total - a.total || a.i - b.i)
  const listTop = top + plot + 42
  const parts = open(listTop + Math.max(1, legend.length) * 18 - 4, eyebrow, aside)

  grid(parts, left, top, plot, max)
  columns.forEach((each, i) => {
    const { x, width } = slot(i, step, left)
    const drawn = series.filter(({ name }) => (each.values[name] ?? 0) > 0)
    let reached = 0
    drawn.forEach(({ name, colour }, k) => {
      const value = each.values[name]
      // The gap above a lower segment is taken from the segment above it, so the stack keeps its height.
      const bottom = top + plot - (reached / max) * plot - (k > 0 ? 2 : 0)
      reached += value
      const upTo = top + plot - (reached / max) * plot
      const segmentTop = Math.min(upTo, bottom - 1)
      parts.push(
        `<path class="bar hot" d="${bar(x, width, bottom, segmentTop, k === drawn.length - 1)}" fill="${colour}">` +
          `<title>${esc(each.title)}, ${esc(name)}: ${esc(many(value, unit))}</title></path>`,
      )
    })
    if (totals[i] > 0) {
      parts.push(`<text class="ink" x="${f(x + width / 2)}" y="${f(top + plot - (totals[i] / max) * plot - 5)}" text-anchor="middle">${totals[i]}</text>`)
    }
    underLabel(parts, each.label, x + width / 2, top + plot + 16, left)
  })

  if (legend.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${listTop}">No commits in these days.</text>`)
  legend.forEach((each, i) => {
    const y = listTop + i * 18
    parts.push(`<rect class="swatch" x="${PAD}" y="${y - 8}" width="8" height="8" rx="2" fill="${each.colour}"/><text x="${PAD + 14}" y="${y}">${esc(fit(each.name, 240))}<title>${esc(each.name)}</title></text>`)
    parts.push(`<text class="ink" x="${WIDTH - PAD}" y="${y}" text-anchor="end">${each.total}</text>`)
  })
  return close(parts)
}

/**
 * A list of things, two lines each: a swatch in their colour and their name, then a dim line about them.
 * @param {{ eyebrow: string, aside?: string, empty: string, rows: { name: string, detail: string, colour: string }[] }} card
 */
export function listCard({ eyebrow, aside = '', rows, empty }) {
  const top = 48
  const row = 34
  const parts = open(top + Math.max(1, rows.length) * row - 10, eyebrow, aside)

  if (rows.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${top}">${esc(empty)}</text>`)
  rows.forEach((each, i) => {
    const y = top + i * row
    parts.push(`<rect x="${PAD}" y="${y - 8}" width="8" height="8" rx="2" fill="${each.colour}"/>`)
    parts.push(`<text class="ink" x="${PAD + 14}" y="${y}">${esc(fit(each.name, INNER - 14))}<title>${esc(each.name)}</title></text>`)
    parts.push(`<text class="dim" x="${PAD + 14}" y="${y + 14}">${esc(fit(each.detail, INNER - 14))}</text>`)
  })
  return close(parts)
}

/**
 * The rows of a plan: number, name, and the status of the open ones; a done row struck through.
 * @param {{ eyebrow: string, aside?: string, rows: { id: string, name: string, note: string, done: boolean }[] }} card
 */
export function planCard({ eyebrow, aside = '', rows }) {
  const top = 46
  const row = 18
  const idWidth = rows.some((each) => each.id.length > 2) ? 40 : 24
  const parts = open(top + Math.max(1, rows.length) * row - 4, eyebrow, aside)

  if (rows.length === 0) parts.push(`<text class="dim" x="${PAD}" y="${top}">The table has no rows.</text>`)
  rows.forEach((each, i) => {
    const y = top + i * row
    const note = each.done ? '' : fit(each.note, INNER * 0.42)
    const noteWidth = note === '' ? 0 : note.length * 10 * GLYPH + 10
    parts.push(`<text class="dim" x="${PAD}" y="${y}">${esc(fit(each.id, idWidth - 6))}</text>`)
    parts.push(
      `<text class="${each.done ? 'done' : 'ink'}" x="${PAD + idWidth}" y="${y}">${esc(fit(each.name, INNER - idWidth - noteWidth))}</text>`,
    )
    if (note !== '') {
      const whole = note === each.note ? '' : `<title>${esc(each.note)}</title>`
      parts.push(`<text class="dim" x="${WIDTH - PAD}" y="${y}" text-anchor="end">${esc(note)}${whole}</text>`)
    }
  })
  return close(parts)
}

/**
 * Sentences in a card, wrapped to its width.
 * @param {{ eyebrow: string, aside?: string, lines: string[] }} card
 */
export function textCard({ eyebrow, aside = '', lines }) {
  const top = 46
  const lineHeight = 15
  const max = Math.floor(INNER / (10 * GLYPH))
  const wrapped = lines.map((line) => wrap(line, max))
  const height = wrapped.reduce((sum, block) => sum + block.length * lineHeight + 6, 0)
  const parts = open(top + Math.max(height, lineHeight) - 2, eyebrow, aside)

  let y = top
  for (const block of wrapped) {
    block.forEach((line, i) => {
      parts.push(`<text x="${PAD}" y="${y + i * lineHeight}">${esc(line)}</text>`)
    })
    y += block.length * lineHeight + 6
  }
  return close(parts)
}
