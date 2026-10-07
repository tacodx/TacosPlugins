import { test } from 'node:test'
import assert from 'node:assert/strict'

import { calendarChart, columnChart, hourGrid, rankBars, shareBar, stackedColumnChart, SVG_LIMIT } from '../hooks/charts.mjs'
import { tokens } from '../hooks/format.mjs'

const NASTY = '<img src=x onerror=alert(1)> & "quoted"'
const marks = (svg) => (svg.match(/class="s\d mark"/g) ?? []).length
const column = (label, value) => ({ label, title: label, value })

/** What every drawing must be, whatever went into it. */
function assertDrawing(svg) {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 360 [\d.]+" width="360" height="[\d.]+">/)
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.length <= SVG_LIMIT)
  // Checked on the tags alone: text is escaped, and may well say "onerror=".
  assert.doesNotMatch(svg.replace(/>[^<]*</g, '><'), /<script|\son\w+=|javascript:/i)
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/)
  for (const tag of ['rect', 'text', 'title', 'tspan']) {
    const opened = (svg.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length
    const closed = (svg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length + (svg.match(new RegExp(`<${tag} [^>]*/>`, 'g')) ?? []).length
    assert.equal(opened, closed, `unbalanced <${tag}>`)
  }
}

test('a column chart draws one mark per column that has a value, each with its tooltip', () => {
  const svg = columnChart([column('1 Mar', 1500), column('2 Mar', 0), column('3 Mar', 4_900_000)], tokens, 'output tokens')

  assertDrawing(svg)
  assert.equal(marks(svg), 2)
  assert.ok(svg.includes('<title>3 Mar: 4.9M output tokens</title>'))
  assert.ok(svg.includes('>5.0M</text>')) // the axis ends on a round number above the largest column
  assert.ok(svg.includes('>1 Mar</text>') && svg.includes('>3 Mar</text>'))
})

test('a chart with nothing in it is still a drawing', () => {
  assertDrawing(columnChart([], tokens, 'output tokens'))
  assertDrawing(stackedColumnChart([], [], tokens))
  assertDrawing(hourGrid(Array.from({ length: 7 }, () => new Array(24).fill(0))))
  assertDrawing(calendarChart({ weeks: [], months: [] }, 'prompts'))
  assertDrawing(shareBar([], tokens))
  assert.ok(rankBars([], tokens).includes('Nothing in this range.'))
})

test('names from the data are escaped wherever they are drawn', () => {
  const drawings = [
    rankBars([{ name: NASTY, value: 3 }], String),
    shareBar([{ name: NASTY, value: 3 }], String),
    stackedColumnChart([{ label: NASTY, title: NASTY, values: { [NASTY]: 2 } }], [NASTY], String),
    columnChart([{ label: NASTY, title: NASTY, value: 2 }], String, NASTY),
  ]

  for (const svg of drawings) {
    assertDrawing(svg)
    assert.ok(!svg.includes('<img'))
    assert.ok(svg.includes('&lt;img'))
  }
})

test('a drawing that would be too large is replaced by a small one that says so', () => {
  const svg = columnChart(Array.from({ length: 5000 }, (_, i) => column(`day ${i}`, i + 1)), tokens, 'output tokens')

  assertDrawing(svg)
  assert.ok(svg.includes('Too much to draw here.'))
})

test('stacked columns give each series its colour in order, Other the neutral one, and a legend with totals', () => {
  const svg = stackedColumnChart(
    [
      { label: '1 Mar', title: '1 Mar', values: { opus: 10, sonnet: 5, Other: 1 } },
      { label: '2 Mar', title: '2 Mar', values: { opus: 30 } },
    ],
    ['opus', 'sonnet', 'Other'],
    String,
    (name) => name.toUpperCase(),
  )

  assertDrawing(svg)
  assert.equal(marks(svg), 4)
  assert.ok(svg.includes('<rect class="s1 mark"') && svg.includes('<rect class="s2 mark"') && svg.includes('<rect class="s0 mark"'))
  assert.ok(svg.includes('<title>1 Mar, SONNET: 5</title>'))
  assert.match(svg, /OPUS <tspan[^>]*>40<\/tspan>/)
})

test('the weekday grid has a cell for every hour of the week, the busiest fully coloured', () => {
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
  hours[0][16] = 40
  hours[6][3] = 4
  const svg = hourGrid(hours)

  assertDrawing(svg)
  assert.equal((svg.match(/<rect /g) ?? []).length, 168)
  assert.equal(marks(svg), 2)
  assert.ok(svg.includes('fill-opacity="1.00"'))
  assert.ok(svg.includes('<title>Mon 16:00: 40 prompts</title>'))
  assert.ok(svg.includes('<title>Sun 03:00: 4 prompts</title>'))
})

test('a calendar draws the days it is given and skips the cells before the first one', () => {
  const svg = calendarChart(
    {
      weeks: [
        [null, null, { day: '2026-03-04', value: 0 }, { day: '2026-03-05', value: 12 }, null, null, null],
      ],
      months: [{ column: 0, label: 'Mar' }],
    },
    'prompts',
  )

  assertDrawing(svg)
  assert.equal((svg.match(/<rect /g) ?? []).length, 2)
  assert.ok(svg.includes('<title>5 Mar: 12 prompts</title>'))
  assert.ok(svg.includes('>Mar</text>'))
})

test('ranked bars are as long as their share of the largest, and long names are cut with the whole name on hover', () => {
  const long = 'a-project-with-quite-a-long-name'
  const svg = rankBars([{ name: long, value: 200 }, { name: 'half', value: 100 }], String)
  const widths = [...svg.matchAll(/<rect class="s1 mark"[^>]* width="([\d.]+)"/g)].map((match) => Number(match[1]))

  assertDrawing(svg)
  assert.equal(widths.length, 2)
  assert.equal(widths[1] * 2, widths[0])
  assert.ok(svg.includes('a-project-with-quit…<title>a-project-with-quite-a-long-name</title>'))
})

test('a share bar says what part each piece is, and a sliver is not 0%', () => {
  const svg = shareBar([{ name: 'Opus 5.5', value: 998 }, { name: 'Other', value: 2 }], String)

  assertDrawing(svg)
  assert.ok(svg.includes('<rect class="s1 mark"') && svg.includes('<rect class="s0 mark"'))
  assert.ok(svg.includes('998 · 100%'))
  assert.ok(svg.includes('2 · &lt;1%'))
})
