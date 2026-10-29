import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTIVITY, colourOf, hoursCard, kpiCard, listCard, NEUTRAL, planCard, PROJECT_COLOURS, stackedCard, SVG_LIMIT, textCard } from '../hooks/charts.mjs'

const NASTY = '<img src=x onerror=alert(1)> & "quoted"'
const count = (svg, pattern) => (svg.match(pattern) ?? []).length
/** The fill of every column or segment drawn, in order. */
const fills = (svg) => [...svg.matchAll(/<path class="bar[^"]*" d="[^"]*" fill="(#[0-9a-f]{6})"/g)].map((match) => match[1])

/** What every card must be, whatever went into it. */
function assertCard(svg) {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 360 [\d.]+" width="360" height="[\d.]+">/)
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.length <= SVG_LIMIT)
  // Checked on the tags alone: text is escaped, and may well say "onerror=".
  assert.doesNotMatch(svg.replace(/>[^<]*</g, '><'), /<script|\son\w+=|javascript:/i)
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/)
  for (const tag of ['rect', 'text', 'title', 'line', 'path']) {
    const opened = count(svg, new RegExp(`<${tag}[ >]`, 'g'))
    const closed = count(svg, new RegExp(`</${tag}>`, 'g')) + count(svg, new RegExp(`<${tag} [^>]*/>`, 'g'))
    assert.equal(opened, closed, `unbalanced <${tag}>`)
  }
  // The card's own surface: it must not depend on the theme of whatever is around it.
  assert.match(svg, /<rect x="\.5" y="\.5" width="359" height="[\d.]+" rx="10" fill="#161615"/)
}

test('the palette: eight fixed project colours, neutral past them', () => {
  assert.equal(PROJECT_COLOURS.length, 8)
  assert.equal(new Set(PROJECT_COLOURS).size, 8)
  assert.equal(colourOf(0), PROJECT_COLOURS[0])
  assert.equal(colourOf(7), PROJECT_COLOURS[7])
  assert.equal(colourOf(null), NEUTRAL)
  assert.equal(colourOf(8), NEUTRAL)
  assert.ok(!PROJECT_COLOURS.includes(ACTIVITY) && ACTIVITY !== NEUTRAL)
})

test('the KPI row: three figures, each with what it counts', () => {
  const svg = kpiCard([
    { label: 'Commits today', figure: '145', note: 'in 7 projects' },
    { label: 'Lines added', figure: '28,028', note: 'today' },
    { label: 'Commits 7 days', figure: '382', note: 'in 11 projects' },
  ])

  assertCard(svg)
  for (const text of ['>COMMITS TODAY<', '>145</text>', '>in 7 projects<', '>LINES ADDED<', '>28,028</text>', '>COMMITS 7 DAYS<', '>382</text>']) {
    assert.ok(svg.includes(text), text)
  }
  assert.equal(count(svg, /class="figure stat"/g), 3)
})

test('the hours: one hue for every column, nothing drawn for a quiet hour, the tallest captioned', () => {
  const columns = Array.from({ length: 30 }, (_, i) => ({ label: i % 6 === 0 ? `${i}h` : '', title: `Hour ${i}`, value: i >= 8 && i < 14 ? 0 : (i % 7) + 1 }))
  columns[20].value = 40

  const svg = hoursCard({ eyebrow: 'Commits per hour', aside: 'last 30 hours', columns, unit: 'commit' })

  assertCard(svg)
  assert.deepEqual(new Set(fills(svg)), new Set([ACTIVITY]))
  assert.equal(fills(svg).length, 24) // six quiet hours, no column
  assert.ok(svg.includes('<title>Hour 20: 40 commits</title>'))
  assert.ok(svg.includes('>Hour 20 · 40</text>'))
  for (const label of ['0h', '6h', '12h', '18h', '24h']) assert.ok(svg.includes(`>${label}</text>`), label)
})

test('the hours with no commit at all still draw an axis and say so', () => {
  const svg = hoursCard({ eyebrow: 'Commits per hour', aside: '', columns: Array.from({ length: 30 }, (_, i) => ({ label: '', title: `${i}`, value: 0 })), unit: 'commit' })

  assertCard(svg)
  assert.equal(fills(svg).length, 0)
  assert.ok(svg.includes('>No commits in these thirty hours.</text>'))
})

test('per project per day: each project in its own colour, stacked with gaps, totals on the caps and in the legend', () => {
  const series = [
    { name: 'gamma', colour: colourOf(5) },
    { name: 'alpha', colour: colourOf(0) },
    { name: 'Other', colour: NEUTRAL },
  ]
  const columns = [
    { label: 'Mon', title: 'Mon 2 Mar', values: { alpha: 3, gamma: 1 } },
    { label: 'Tue', title: 'Tue 3 Mar', values: {} },
    { label: 'Today', title: 'Wed 4 Mar', values: { alpha: 2, Other: 4 } },
  ]

  const svg = stackedCard({ eyebrow: 'Commits per project', aside: '7 days', columns, series, unit: 'commit' })

  assertCard(svg)
  assert.deepEqual(fills(svg), [colourOf(5), colourOf(0), colourOf(0), NEUTRAL])
  assert.ok(svg.includes('<title>Mon 2 Mar, alpha: 3 commits</title>'))
  assert.ok(svg.includes('<title>Mon 2 Mar, gamma: 1 commit</title>'))
  assert.ok(svg.includes('<title>Wed 4 Mar, Other: 4 commits</title>'))
  assert.ok(svg.includes('>4</text>') && svg.includes('>6</text>'))
  // The legend, most commits first, a swatch in each project's colour beside its name.
  const legend = [...svg.matchAll(/<rect class="swatch" [^>]*fill="(#[0-9a-f]{6})"\/><text [^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])
  assert.deepEqual(legend, [['alpha', colourOf(0)], ['Other', NEUTRAL], ['gamma', colourOf(5)]])
  // Segments of one column do not touch: a two-unit surface gap between them.
  const [lower, upper] = [...svg.matchAll(/<path class="bar[^"]*" d="M[\d.]+,([\d.]+) V([\d.]+)/g)].map((match) => ({ bottom: Number(match[1]), top: Number(match[2]) }))
  assert.equal(Math.round((lower.top - upper.bottom) * 10) / 10, 2)
})

test('names are escaped wherever they are written', () => {
  const svgs = [
    stackedCard({ eyebrow: NASTY, aside: NASTY, columns: [{ label: NASTY, title: NASTY, values: { [NASTY]: 2 } }], series: [{ name: NASTY, colour: colourOf(1) }], unit: NASTY }),
    listCard({ eyebrow: NASTY, aside: NASTY, rows: [{ name: NASTY, detail: NASTY, colour: colourOf(2) }], empty: NASTY }),
    planCard({ eyebrow: NASTY, aside: NASTY, rows: [{ id: NASTY, name: NASTY, note: NASTY, done: false }] }),
    textCard({ eyebrow: NASTY, aside: NASTY, lines: [NASTY] }),
    kpiCard([{ label: NASTY, figure: NASTY, note: NASTY }]),
    hoursCard({ eyebrow: NASTY, aside: NASTY, columns: [{ label: NASTY, title: NASTY, value: 1 }], unit: NASTY }),
  ]
  for (const svg of svgs) {
    assertCard(svg)
    assert.ok(!svg.includes('<img'))
  }
})

test('the sessions: a swatch in the project\'s colour, the name, and a line on what it is doing', () => {
  const svg = listCard({
    eyebrow: 'Working now',
    aside: '2 of 5 open',
    rows: [
      { name: 'Alpha · Build the thing', detail: 'alpha · for 12 min', colour: colourOf(3) },
      { name: 'A session with a name far too long to fit on one line of this card at all', detail: 'beta · for 2 h', colour: NEUTRAL },
    ],
    empty: 'Nothing is working right now.',
  })

  assertCard(svg)
  assert.ok(svg.includes(`fill="${colourOf(3)}"`))
  assert.ok(svg.includes('>Alpha · Build the thing<'))
  assert.ok(svg.includes('>alpha · for 12 min<'))
  assert.match(svg, />A session with a name far too long[^<]*…<title>A session with a name far too long to fit on one line of this card at all<\/title>/)
})

test('no session at work is said, not left blank', () => {
  const svg = listCard({ eyebrow: 'Working now', aside: '', rows: [], empty: 'Nothing is working right now.' })

  assertCard(svg)
  assert.ok(svg.includes('>Nothing is working right now.</text>'))
})

test('the plan: number and name per row, done rows struck and dimmed, a status beside open ones', () => {
  const svg = planCard({
    eyebrow: 'The plan',
    aside: '1 of 3 done',
    rows: [
      { id: '1', name: 'Sketch', note: 'Done 2026-03-01', done: true },
      { id: '2', name: 'Prototype', note: 'Reopened 2026-03-04', done: false },
      { id: 'W', name: 'Write docs', note: '', done: false },
    ],
  })

  assertCard(svg)
  assert.match(svg, /<text class="done"[^>]*>Sketch<\/text>/)
  assert.ok(!svg.includes('Done 2026-03-01'))
  assert.match(svg, /<text class="ink"[^>]*>Prototype<\/text>/)
  assert.ok(svg.includes('>Reopened 2026-03-04</text>'))
  assert.ok(svg.includes('>W</text>') && svg.includes('>Write docs</text>'))
  assert.match(svg, /\.done\{[^}]*text-decoration:line-through/)
})

test('a card that would be too large to draw is replaced by one that says so', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), name: `Row number ${i}`, note: 'Some status of the row', done: i % 2 === 0 }))

  const svg = planCard({ eyebrow: 'The plan', aside: '', rows })

  assertCard(svg)
  assert.ok(svg.includes('Too much to draw'.toUpperCase()))
})
