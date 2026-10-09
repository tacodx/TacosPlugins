import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calendarCard,
  columnCard,
  heroCard,
  hourCard,
  rankCard,
  shareCard,
  stackedCard,
  statCard,
  SVG_LIMIT,
  textCard,
  wrap,
} from '../hooks/charts.mjs'
import { tokens } from '../hooks/format.mjs'

const NASTY = '<img src=x onerror=alert(1)> & "quoted"'
const column = (label, value) => ({ label, title: label, value })
const count = (svg, pattern) => (svg.match(pattern) ?? []).length
const rects = (svg, kind) => [...svg.matchAll(new RegExp(`<rect class="${kind}[^"]*"([^>]*)>`, 'g'))].map((match) => match[1])
const attribute = (text, name) => Number(new RegExp(` ${name}="([\\d.]+)"`).exec(text)[1])

/** What every card must be, whatever went into it. */
function assertCard(svg) {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 360 [\d.]+" width="360" height="[\d.]+">/)
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.length <= SVG_LIMIT)
  // Checked on the tags alone: text is escaped, and may well say "onerror=".
  assert.doesNotMatch(svg.replace(/>[^<]*</g, '><'), /<script|\son\w+=|javascript:/i)
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/)
  for (const tag of ['rect', 'text', 'title', 'line']) {
    const opened = count(svg, new RegExp(`<${tag}[ >]`, 'g'))
    const closed = count(svg, new RegExp(`</${tag}>`, 'g')) + count(svg, new RegExp(`<${tag} [^>]*/>`, 'g'))
    assert.equal(opened, closed, `unbalanced <${tag}>`)
  }
  // The card's own surface: it must not depend on the theme of whatever is around it.
  assert.match(svg, /<rect x="\.5" y="\.5" width="359" height="[\d.]+" rx="10" fill="#161615"/)
}

test('the hero card leads with its figure, lights the tallest column and says what it is', () => {
  const svg = heroCard({
    eyebrow: 'Output tokens',
    aside: '1 Mar – 3 Mar',
    figure: '6.4M',
    unit: 'output tokens',
    note: '+23% on the 3 days before',
    columns: [column('1 Mar', 1500), column('2 Mar', 0), column('3 Mar', 4_900_000)],
    format: tokens,
  })

  assertCard(svg)
  assert.ok(svg.includes('<text class="figure hero" x="16" y="76">6.4M</text>'))
  assert.ok(svg.includes('>OUTPUT TOKENS</text>') && svg.includes('>1 MAR – 3 MAR</text>'))
  assert.ok(svg.includes('>+23% on the 3 days before</text>'))
  assert.equal(rects(svg, 'peak').length, 1)
  assert.equal(rects(svg, 'mark').length, 1) // the column with nothing in it is not drawn
  assert.ok(svg.includes('<title>3 Mar: 4.9M output tokens</title>'))
  assert.ok(svg.includes('>3 Mar · 4.9M</text>'))
})

test('headline numbers go two to a row, and a note too long for its half is cut with the whole of it on hover', () => {
  const long = 'a note that is far too long to fit in half a card'
  const three = statCard([
    { label: 'Prompts', figure: '1,234', note: '15 active days' },
    { label: 'Sessions', figure: '30', note: long },
    { label: 'Busy time', figure: '10 h', note: 'at work' },
  ])
  const two = statCard([
    { label: 'Prompts', figure: '1,234', note: '15 active days' },
    { label: 'Sessions', figure: '30', note: 'x' },
  ])

  assertCard(three)
  assert.ok(three.includes('<text class="figure stat" x="16" y="49">1,234</text>'))
  assert.ok(three.includes('<text class="figure stat" x="196" y="49">30</text>'))
  assert.ok(three.includes('<text class="figure stat" x="16" y="111">10 h</text>'))
  assert.ok(three.includes('>PROMPTS</text>'))
  assert.ok(!three.includes(`>${long}<title>`) && three.includes(`<title>${long}</title>`))
  assert.equal(attribute(three, 'height') - attribute(two, 'height'), 62)
})

test('a column card draws a mark for each column with a value, the tallest lit and captioned', () => {
  const svg = columnCard({ eyebrow: 'Prompts over time', columns: [column('1 Mar', 40), column('2 Mar', 0), column('3 Mar', 95)], format: String, unit: 'prompts' })

  assertCard(svg)
  assert.equal(rects(svg, 'mark').length, 1)
  assert.equal(rects(svg, 'peak').length, 1)
  assert.ok(svg.includes('<title>3 Mar: 95 prompts</title>'))
  assert.ok(svg.includes('>3 Mar · 95</text>'))
  assert.ok(svg.includes('>1 Mar</text>') && svg.includes('>3 Mar</text>'))
})

test('the axis tops out just above the tallest column, and a small count never gets a top whose half is no count', () => {
  const topOf = (value) => {
    const svg = columnCard({ eyebrow: 'x', columns: [column('a', value)], format: String, unit: 'things' })
    return [...svg.matchAll(/<text class="dim"[^>]*text-anchor="end">([^<]+)<\/text>/g)].at(-1)[1]
  }

  assert.equal(topOf(11_400_000), '12000000')
  assert.equal(topOf(4_900_000), '5000000')
  assert.equal(topOf(95), '100')
  assert.equal(topOf(1), '2')
  assert.equal(topOf(5), '6')
  assert.equal(topOf(7), '8')
})

test('a column is never wider than a bar should be, and sits in the middle of its slot', () => {
  const svg = columnCard({ eyebrow: 'By month', columns: [column('Sep 2026', 9000), column('Oct 2026', 900)], format: String, unit: 'notes' })
  const bars = [...rects(svg, 'peak'), ...rects(svg, 'mark')].map((text) => ({ x: attribute(text, 'x'), width: attribute(text, 'width') }))

  assert.deepEqual(bars.map((bar) => bar.width), [22, 22])
  assert.equal(bars[0].x + 11, 46 + 149 / 2) // the middle of the first of two slots, 149 units each from x = 46
})

test('stacked columns give each series its colour in order, Other the neutral one, and list the totals', () => {
  const svg = stackedCard({
    eyebrow: 'Output over time',
    columns: [
      { label: '1 Mar', title: '1 Mar', values: { opus: 10, sonnet: 5, Other: 1 } },
      { label: '2 Mar', title: '2 Mar', values: { opus: 30 } },
    ],
    names: ['opus', 'sonnet', 'Other'],
    format: String,
    nameOf: (name) => name.toUpperCase(),
  })

  assertCard(svg)
  assert.equal(count(svg, /<rect class="s"/g), 4)
  assert.ok(svg.includes('fill="#3987e5"><title>1 Mar, OPUS: 10</title>'))
  assert.ok(svg.includes('fill="#d95926"><title>1 Mar, SONNET: 5</title>'))
  assert.ok(svg.includes('fill="#6b685f"><title>1 Mar, OTHER: 1</title>'))
  assert.match(svg, />OPUS<\/text><text class="ink"[^>]*>40<\/text>/)
  // In the list too, the neutral colour follows the series, not the name it is shown under.
  assert.match(svg, /fill="#6b685f"\/><text[^>]*>OTHER<\/text>/)
})

test('the weekday grid has a cell for every hour of the week, the busiest lit', () => {
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
  hours[0][16] = 40
  hours[6][3] = 4
  const svg = hourCard({ eyebrow: 'When you prompt', aside: 'peak Mon 16:00', hours })

  assertCard(svg)
  assert.equal(count(svg, /<rect class="(empty|mark hot|peak hot)"/g), 168)
  assert.equal(rects(svg, 'peak').length, 1)
  assert.ok(svg.includes('<title>Mon 16:00: 40 prompts</title>'))
  assert.match(svg, /<rect class="mark hot" fill-opacity="0\.30"[^>]*><title>Sun 03:00: 4 prompts<\/title>/)
  assert.ok(svg.includes('>PEAK MON 16:00</text>'))
})

test('a calendar draws the days it is given, skips the cells before the first, and lights the best day', () => {
  const svg = calendarCard({
    eyebrow: 'Prompts per day',
    unit: 'prompts',
    calendar: {
      weeks: [[null, null, { day: '2026-03-04', value: 0 }, { day: '2026-03-05', value: 12 }, { day: '2026-03-06', value: 3 }, null, null]],
      months: [{ column: 0, label: 'Mar' }],
    },
  })

  assertCard(svg)
  assert.equal(count(svg, /<rect class="(empty|mark hot|peak hot)"/g), 3)
  assert.match(svg, /<rect class="peak hot"[^>]*><title>5 Mar: 12 prompts<\/title>/)
  assert.match(svg, /<rect class="empty"[^>]*><title>4 Mar: 0 prompts<\/title>/)
  assert.ok(svg.includes('>Mar</text>'))
})

test('ranked bars are as long as their share of the largest, the first lit, long names cut with the whole name on hover', () => {
  const long = 'a-project-with-quite-a-long-name-indeed'
  const svg = rankCard({ eyebrow: 'Top projects', rows: [{ name: long, value: 200 }, { name: 'half', value: 100 }], format: String })
  const first = rects(svg, 'peak')
  const rest = rects(svg, 'mark')

  assertCard(svg)
  assert.equal(first.length, 1)
  assert.equal(rest.length, 1)
  assert.equal(attribute(rest[0], 'width') * 2, attribute(first[0], 'width'))
  assert.ok(svg.includes(`a-project-with-quit…<title>${long}</title>`))

  const labelled = rankCard({ eyebrow: 'Tools', rows: [{ name: 'mcp__github__create_issue', label: 'github: create_issue', value: 1 }], format: String })
  assert.ok(labelled.includes('github: create_issue<title>mcp__github__create_issue</title>'))
  assert.ok(labelled.includes('<title>mcp__github__create_issue: 1</title>'))
})

test('a share card colours its parts in order, lists each with its share, and a sliver is not 0%', () => {
  const svg = shareCard({ eyebrow: 'Models', parts: [{ name: 'Opus 5.5', value: 998 }, { name: 'Other', value: 2 }], format: String })

  assertCard(svg)
  assert.ok(svg.includes('fill="#3987e5"><title>Opus 5.5: 998 (100%)</title>'))
  assert.ok(svg.includes('fill="#6b685f"><title>Other: 2 (&lt;1%)</title>'))
  assert.match(svg, />Opus 5\.5<title>Opus 5\.5<\/title><\/text><text class="ink"[^>]*>998<\/text><text class="dim"[^>]*>100%<\/text>/)
  assert.match(svg, />2<\/text><text class="dim"[^>]*>&lt;1%<\/text>/)
})

test('a text card wraps each sentence to the width of the card and marks where each begins', () => {
  const sentence = 'Subagents wrote 78% of all replies: for each one in your own sessions, 3.5 came from agents working for it.'
  const svg = textCard({ eyebrow: 'What the numbers say', lines: [sentence, 'Short one.'] })
  const lines = [...svg.matchAll(/<text (?:class="ink" )?x="30" y="[\d.]+">([^<]*)<\/text>/g)].map((match) => match[1])

  assertCard(svg)
  assert.equal(rects(svg, 'peak').length, 2) // one mark per sentence
  assert.ok(lines.length >= 3)
  assert.ok(lines.every((line) => line.length <= 52))
  assert.equal(lines.join(' '), `${sentence} Short one.`)
})

test('wrap breaks at spaces, and cuts a word that is longer than a line', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three'])
  assert.deepEqual(wrap('abcdefghij kl', 4), ['abcd', 'efgh', 'ij', 'kl'])
  assert.deepEqual(wrap('  spaced   out  ', 20), ['spaced out'])
  assert.deepEqual(wrap('', 10), [])
})

test('a card with nothing in it is still a card, and says so where there is room to', () => {
  assertCard(heroCard({ eyebrow: 'Output tokens', figure: '0', unit: 'output tokens', columns: [], format: tokens }))
  assertCard(statCard([]))
  assertCard(columnCard({ eyebrow: 'x', columns: [], format: tokens, unit: 'things' }))
  assertCard(stackedCard({ eyebrow: 'x', columns: [], names: [], format: tokens }))
  assertCard(hourCard({ eyebrow: 'x', hours: Array.from({ length: 7 }, () => new Array(24).fill(0)) }))
  assertCard(calendarCard({ eyebrow: 'x', calendar: { weeks: [], months: [] }, unit: 'prompts' }))
  for (const svg of [rankCard({ eyebrow: 'x', rows: [], format: tokens }), shareCard({ eyebrow: 'x', parts: [], format: tokens }), textCard({ eyebrow: 'x', lines: [] })]) {
    assertCard(svg)
    assert.ok(svg.includes('Nothing in this range.'))
  }
})

test('names from the data are escaped wherever they are drawn', () => {
  const cards = [
    heroCard({ eyebrow: NASTY, aside: NASTY, figure: NASTY, unit: NASTY, note: NASTY, columns: [{ label: NASTY, title: NASTY, value: 2 }], format: String }),
    statCard([{ label: NASTY, figure: NASTY, note: NASTY }]),
    columnCard({ eyebrow: NASTY, columns: [{ label: NASTY, title: NASTY, value: 2 }], format: String, unit: NASTY }),
    stackedCard({ eyebrow: NASTY, columns: [{ label: NASTY, title: NASTY, values: { [NASTY]: 2 } }], names: [NASTY], format: String }),
    rankCard({ eyebrow: NASTY, rows: [{ name: NASTY, value: 3 }], format: String }),
    shareCard({ eyebrow: NASTY, parts: [{ name: NASTY, value: 3 }], format: String }),
    textCard({ eyebrow: NASTY, lines: [NASTY] }),
  ]

  for (const svg of cards) {
    assertCard(svg)
    assert.ok(!/<img/i.test(svg))
    assert.ok(/&lt;img/i.test(svg))
  }
})

test('a card that would be too large is replaced by a small one that says so', () => {
  const svg = columnCard({ eyebrow: 'Too many', columns: Array.from({ length: 5000 }, (_, i) => column(`day ${i}`, i + 1)), format: tokens, unit: 'output tokens' })

  assertCard(svg)
  assert.ok(svg.includes('This range has more than fits in one drawing.'))
})
