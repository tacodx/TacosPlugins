// The Tonight tab as one drawing. Pure: a summary (words.mjs) in, one <svg> out.
//
// Drawn as reflect draws its cards: a dark panel that brings its own surface
// and type, so it looks the same in a light app and a dark one. Colour marks
// state alone: each worker's dot, a late watcher, the one line for the owner.
// A working worker's dot breathes slowly; nothing else moves.

export const WIDTH = 360
/** A mod's Svg element takes at most this many characters. */
export const SVG_LIMIT = 131072

const PAD = 16
const INNER = WIDTH - 2 * PAD
const LABEL = 76
const SURFACE = '#161615'
const EDGE = '#2b2b28'
const RULE = '#262623'
const INK = '#f1eee6'
const INK_2 = '#b9b5a8'
const INK_3 = '#8a877c'
const AMBER = '#d99a2b'
const TONES = { working: '#2bb383', waiting: '#6b685f', limited: AMBER, paused: AMBER, off: '#3a3935' }

const MONO = '"JetBrains Mono","JetBrainsMono Nerd Font","Cascadia Mono","SF Mono","Noto Sans Mono","DejaVu Sans Mono",monospace'
const SERIF = '"Noto Serif","Source Serif 4","New York",Georgia,"DejaVu Serif",serif'
// A monospace glyph is six tenths of its size wide, near enough to cut and wrap by.
const GLYPH = 0.6

const STYLE = `
text{font-family:${MONO};font-size:10px;fill:${INK_2}}
.eyebrow{fill:${INK_3};letter-spacing:.09em}
.dim{fill:${INK_3}}
.ink{fill:${INK}}
.late{fill:${AMBER}}
.phase{font-family:${SERIF};font-size:22px;fill:${INK}}
.headline{font-family:${SERIF};font-size:14px;fill:${INK}}
.rule{stroke:${RULE};stroke-width:1}
.breathe{animation:breathe 2.8s ease-in-out infinite}
@keyframes breathe{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.breathe{animation:none}}`

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** How many characters of `size` fit in `width`. */
const room = (width, size = 10) => Math.max(1, Math.floor(width / (size * GLYPH)))

/** `text` cut to `max` characters, with an ellipsis when cut. */
export function cut(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
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

const rule = (y) => `<line class="rule" x1="${PAD}" x2="${WIDTH - PAD}" y1="${y + 0.5}" y2="${y + 0.5}"/>`

function workerRow(worker, y) {
  const state = cut(worker.state, 22)
  const stateX = WIDTH - PAD
  const nameX = PAD + 30
  const project = cut(worker.project, 16)
  const itemX = nameX + (project.length + 1) * 10 * GLYPH
  const itemRoom = room(stateX - state.length * 10 * GLYPH - 12 - itemX)
  const parts = [
    `<g><title>${esc(worker.line)}</title>`,
    `<circle class="${worker.tone === 'working' ? 'breathe' : ''}" cx="${PAD + 4}" cy="${y - 3.5}" r="3.5" fill="${TONES[worker.tone] ?? TONES.off}"/>`,
    `<text class="dim" x="${PAD + 15}" y="${y}">${esc(worker.slot)}</text>`,
  ]
  if (project !== '') parts.push(`<text class="ink" x="${nameX}" y="${y}">${esc(project)}</text>`)
  if (worker.item !== '' && itemRoom > 3) parts.push(`<text class="dim" x="${itemX.toFixed(1)}" y="${y}">${esc(cut(worker.item, itemRoom))}</text>`)
  parts.push(`<text x="${stateX}" y="${y}" text-anchor="end">${esc(state)}</text></g>`)
  return parts.join('')
}

/** What the drawing says, for whoever cannot see it. */
export function tonightAlt(said) {
  const parts = [`${said.phase}.`]
  if (said.workers.length > 0) parts.push(`${said.workers.map((each) => each.line).join('; ')}.`)
  for (const row of said.rows) parts.push(`${row.label}: ${row.value}.`)
  if (said.recap !== null) parts.push(`Last recap: ${said.recap.headline}`)
  return parts.join(' ')
}

/** The Tonight card, from what `summary` in words.mjs says. */
export function tonightCard(said) {
  const body = []
  let y = 58
  body.push(`<text class="phase" x="${PAD}" y="${y}">${esc(cut(said.phase, room(INNER, 22 * 0.85)))}</text>`)

  if (said.workers.length > 0 || said.noWorkers) {
    y += 16
    body.push(rule(y))
    y += 6
    if (said.noWorkers) {
      y += 16
      body.push(`<text class="dim" x="${PAD}" y="${y}">No workers yet</text>`)
    }
    for (const worker of said.workers) {
      y += 20
      body.push(workerRow(worker, y))
    }
  }

  y += 16
  body.push(rule(y))
  y += 4
  for (const row of said.rows) {
    const lines = wrap(row.value, room(INNER - LABEL))
    y += 18
    body.push(`<text class="eyebrow" x="${PAD}" y="${y}">${esc(row.label.toUpperCase())}</text>`)
    lines.forEach((line, i) => {
      body.push(`<text class="${row.isLate ? 'late' : 'ink'}" x="${PAD + LABEL}" y="${y + i * 14}">${esc(line)}</text>`)
    })
    y += (lines.length - 1) * 14
  }

  if (said.recap !== null) {
    y += 16
    body.push(rule(y))
    y += 22
    body.push(`<text class="eyebrow" x="${PAD}" y="${y}">LAST RECAP</text>`)
    for (const line of wrap(said.recap.headline, room(INNER, 14 * 0.85))) {
      y += 20
      body.push(`<text class="headline" x="${PAD}" y="${y}">${esc(line)}</text>`)
    }
    if (said.recap.lines.length > 0) y += 4
    for (const line of said.recap.lines) {
      y += 16
      body.push(`<text x="${PAD}" y="${y}">${esc(cut(line, room(INNER)))}</text>`)
    }
  }

  if (said.attention !== null) {
    y += 16
    body.push(rule(y))
    y += 4
    for (const line of wrap(said.attention, room(INNER)).slice(0, 2)) {
      y += 16
      body.push(`<text class="late" x="${PAD}" y="${y}">${esc(line)}</text>`)
    }
  }

  const height = y + 20
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}"><style>${STYLE}</style>`,
    `<rect x=".5" y=".5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${SURFACE}" stroke="${EDGE}"/>`,
    `<text class="eyebrow" x="${PAD}" y="25">TONIGHT</text>`,
    `<text class="eyebrow" x="${WIDTH - PAD}" y="25" text-anchor="end">${esc(said.window.toUpperCase())}</text>`,
    ...body,
    '</svg>',
  ].join('')
  if (svg.length <= SVG_LIMIT) return svg
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} 64" width="${WIDTH}" height="64"><style>${STYLE}</style>`,
    `<rect x=".5" y=".5" width="${WIDTH - 1}" height="63" rx="10" fill="${SURFACE}" stroke="${EDGE}"/>`,
    `<text class="ink" x="${PAD}" y="38">${esc(cut(said.phase, room(INNER)))}</text>`,
    '</svg>',
  ].join('')
}
