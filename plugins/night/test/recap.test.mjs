import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  QUIET, buildRecap, healthLine, hourBuckets, needsLine, pointsWon, usageLine,
} from '../engine/recap/data.mjs'
import { SERIES, hourChart, legend, progressChart, projectChart } from '../engine/recap/charts.mjs'
import { renderPage } from '../engine/recap/page.mjs'
import { at } from './helpers.mjs'

const input = () => JSON.parse(readFileSync(new URL('./fixtures/recap-busy.json', import.meta.url), 'utf8'))
const busy = () => buildRecap(input())
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)

// Nothing happened: no commits, no sessions, no events.
const EMPTY = {
  date: '2026-03-10',
  zone: 'Europe/Berlin',
  window: { start: at('2026-03-10T21:00:00Z'), end: at('2026-03-11T05:00:00Z') },
  now: at('2026-03-11T05:01:00Z'),
  phase: 'day',
}

test('a busy night adds up: the headline, the window and the four numbers', () => {
  const fixture = input()
  const r = busy()
  assert.equal(r.headline, 'Night of 29 October: 44 commits across 4 projects')
  assert.equal(r.windowLabel, '22:30 to 07:00')
  assert.equal(r.writtenAt, '07:02')
  assert.deepEqual(r.totals, {
    commits: 44,
    linesAdded: fixture.commits.reduce((sum, c) => sum + c.added, 0),
    linesRemoved: fixture.commits.reduce((sum, c) => sum + c.removed, 0),
    itemsDone: 12,
    sessions: 5,
    projectsMoved: 4,
  })
  assert.deepEqual(r.perProject.map((p) => [p.name, p.commits]), [
    ['harbor-site', 15], ['pixel-forge', 12], ['ledger-app', 11], ['tide-cli', 6],
  ])
  assert.equal(r.perHour.reduce((sum, h) => sum + Object.values(h.byProject).reduce((a, b) => a + b, 0), 0), 44)
})

test('projects sort by points won, then by % now, and each says what is done and left', () => {
  const r = busy()
  assert.deepEqual(r.projects.map((p) => p.name), ['pixel-forge', 'harbor-site', 'ledger-app', 'garden-notes', 'tide-cli'])
  const by = Object.fromEntries(r.projects.map((p) => [p.name, p]))
  assert.equal(by['harbor-site'].line, 'harbor-site, 40 % to 58 %, +18')
  assert.equal(by['ledger-app'].line, 'ledger-app, 63 % to 71 %, +8')
  assert.equal(by['garden-notes'].line, 'garden-notes, 80 % to 80 %, +0')
  assert.equal(by['tide-cli'].line, 'tide-cli, 2 items done')
  assert.equal(by['tide-cli'].won, null)
  assert.equal(
    by['harbor-site'].leftLine,
    '18 of 31 tasks done, 2 added tonight. Left: Dark mode for the pricing table; Cookie notice without a banner; Image sizes on the blog; and 10 more.',
  )
  assert.equal(by['tide-cli'].leftLine, null)
})

test('points won are the difference of the rounded percentages, so the line adds up', () => {
  assert.equal(pointsWon(40, 58), 18)
  assert.equal(pointsWon(62.5, 71.4), 8)
  assert.equal(pointsWon(40.4, 58.6), 19)
  assert.equal(pointsWon(50, 45), -5)
  assert.equal(pointsWon(null, 40), null)
  assert.equal(pointsWon(40, undefined), null)

  const r = buildRecap({
    ...EMPTY,
    projects: [
      { name: 'down', duskPct: 50, nowPct: 45 },
      { name: 'unmeasured', duskPct: null, nowPct: 30, itemsDone: 3 },
      { name: 'quiet', duskPct: null, nowPct: null },
    ],
  })
  const by = Object.fromEntries(r.projects.map((p) => [p.name, p]))
  assert.equal(by.down.line, 'down, 50 % to 45 %, -5')
  assert.equal(by.unmeasured.line, 'unmeasured, 3 items done')
  assert.equal(by.quiet.line, 'quiet, nothing moved')
})

test('colour follows the owner\'s order of projects, never the night\'s rank, and a ninth folds into Other', () => {
  const r = busy()
  assert.deepEqual(r.series, [
    { name: 'harbor-site', slot: 0 }, { name: 'ledger-app', slot: 1 }, { name: 'tide-cli', slot: 2 }, { name: 'pixel-forge', slot: 3 },
  ])
  assert.equal(r.projects.find((p) => p.name === 'garden-notes').slot, null)

  const names = Array.from({ length: 9 }, (_, i) => `p${i + 1}`)
  const many = buildRecap({
    ...EMPTY,
    projects: names.map((name) => ({ name })),
    commits: names.map((project, i) => ({ project, at: EMPTY.window.start + i * 60_000 })),
  })
  assert.deepEqual(many.series.map((s) => s.slot), [0, 1, 2, 3, 4, 5, 6, -1, -1])
  const svg = hourChart(many)
  assert.ok(svg.includes('class="mark ko"'))
  assert.ok(!svg.includes('k9'))
  assert.match(legend(many), /Other<\/span><\/p>$/)
})

test('every session gets two lines: what it did, and where it is', () => {
  const fixture = input()
  const r = busy()
  for (const s of r.sessions) {
    assert.equal(typeof s.did, 'string')
    assert.equal(typeof s.where, 'string')
    assert.ok(!/\n/.test(s.did + s.where))
  }
  const [one, , three, , desktop] = r.sessions
  assert.equal(
    one.did,
    'Finished 3 items: Contact form shows each error beside its field, with tests; Footer links point at the new legal pages; and 1 more. 1 partial, 1 parked.',
  )
  assert.equal(one.where, 'harbor-site on night/2026-10-29/harbor-site, 12 commits, still working')
  assert.equal(three.where, 'pixel-forge on night/2026-10-29/pixel-forge, 12 commits, waiting for the usage limit')
  const last = fixture.commits
    .filter((c) => c.branch === 'feature/pricing-page')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  assert.equal(desktop.did, `Made 3 commits, the last: ${last.subject}.`)
  assert.equal(desktop.where, 'desktop, harbor-site on feature/pricing-page, waiting on a dialog')

  const [idle, failing] = buildRecap({
    ...EMPTY,
    sessions: [
      { kind: 'worker', name: 'Worker 1' },
      { kind: 'worker', name: 'Worker 2', project: 'x', results: [{ status: 'failed', line: 'tests did not run' }], state: 'dead' },
    ],
  }).sessions
  assert.equal(idle.did, 'Nothing recorded.')
  assert.equal(failing.did, 'No item finished. 1 failed.')
  assert.equal(failing.where, 'x, ended')
})

test('hour buckets cross midnight in local time, and each commit lands in its own hour', () => {
  const r = buildRecap({
    zone: 'Europe/Berlin',
    window: { start: at('2026-10-29T21:30:00Z'), end: at('2026-10-30T01:10:00Z') },
    now: at('2026-10-30T01:10:00Z'),
    commits: [
      { project: 'a', at: at('2026-10-29T22:59:59Z') },
      { project: 'a', at: at('2026-10-29T23:00:00Z') },
      { project: 'b', at: at('2026-10-29T23:30:00Z') },
    ],
  })
  assert.deepEqual(r.perHour.map((h) => h.label), ['22', '23', '00', '01', '02'])
  assert.equal(r.perHour[0].hourStart, at('2026-10-29T21:00:00Z'))
  assert.deepEqual(r.perHour.map((h) => h.byProject), [{}, { a: 1 }, { a: 1, b: 1 }, {}, {}])
  assert.equal(r.date, '2026-10-29')
})

test('hour buckets follow a clock change and a half-hour zone', () => {
  // Berlin falls back at 03:00 CEST on 25 October 2026: the hour from 02:00 comes twice.
  const autumn = hourBuckets(at('2026-10-24T22:30:00Z'), at('2026-10-25T03:00:00Z'), 'Europe/Berlin')
  assert.deepEqual(autumn.map((h) => h.label), ['00', '01', '02', '02', '03'])
  // Kolkata is five and a half hours ahead: its hours start at half past in UTC.
  const india = hourBuckets(at('2026-03-10T17:00:00Z'), at('2026-03-10T19:30:00Z'), 'Asia/Kolkata')
  assert.deepEqual(india.map((h) => h.label), ['22', '23', '00'])
  assert.equal(india[0].hourStart, at('2026-03-10T16:30:00Z'))
  assert.deepEqual(hourBuckets(10, 10, 'UTC'), [])
})

test('commits after dawn count until now, and the columns stretch to the last of them', () => {
  const r = buildRecap({
    zone: 'UTC',
    window: { start: at('2026-03-10T22:00:00Z'), end: at('2026-03-11T05:00:00Z') },
    now: at('2026-03-11T07:00:00Z'),
    commits: [
      { project: 'a', at: at('2026-03-10T21:59:00Z') },
      { project: 'a', at: at('2026-03-10T22:10:00Z') },
      { project: 'a', at: '2026-03-11T06:10:00Z' },
      { project: 'a', at: at('2026-03-11T07:30:00Z') },
    ],
  })
  assert.equal(r.totals.commits, 2)
  assert.equal(r.perHour.at(-1).label, '06')
  assert.deepEqual(r.perHour.at(-1).byProject, { a: 1 })

  // A recap made mid-night draws the hours up to now, not the empty rest of the window.
  const early = buildRecap({ zone: 'UTC', window: { start: at('2026-03-10T22:00:00Z'), end: at('2026-03-11T05:00:00Z') }, now: at('2026-03-11T00:30:00Z') })
  assert.deepEqual(early.perHour.map((h) => h.label), ['22', '23', '00'])
})

test('health is one quiet sentence, or a short count of what happened', () => {
  assert.equal(healthLine([]), QUIET)
  assert.equal(healthLine([{ kind: 'guard.rewrite' }, { kind: 'dusk.step', ok: true }, { kind: 'session.waiting' }]), QUIET)
  assert.equal(busy().health, '1 restart, usage limit hit once, 2 commands blocked.')
  assert.equal(
    healthLine([
      { kind: 'watcher.restart' }, { kind: 'worker.restart' },
      { kind: 'health.thrash' }, { kind: 'health.blocker', code: 'swap-full' },
      { kind: 'health.blocker', code: 'disk-full' },
      { kind: 'health.hot' }, { kind: 'health.hot' }, { kind: 'health.hot' },
      { kind: 'pump.low' },
      { kind: 'dawn.step', ok: false },
      null, { kind: 7 },
    ]),
    '2 restarts, memory pressure twice, disk nearly full once, ran hot 3 times, pump below its floor once, 1 dusk or dawn step failed.',
  )
})

test('the needs line caps at three and says how many more', () => {
  assert.equal(needsLine(['a', 'b', 'c', 'd', 'e']), 'Needs you: a; b; c; and 2 more.')
  assert.equal(needsLine(['only one.']), 'Needs you: only one.')
  assert.equal(needsLine(['a', '  ', 'b']), 'Needs you: a; b.')
  assert.equal(needsLine([]), null)
  assert.equal(needsLine(undefined), null)
  assert.equal(busy().needsLine, 'Needs you: harbor-site: pick one of two hero headlines; pixel-forge: a licence key for the export test; Pricing page polish waits on a permission dialog; and 1 more.')
})

test('usage is one line, from numbers or gauges, or none when it was not read', () => {
  assert.equal(busy().usageLine, 'Usage now: 38 % of the five-hour limit, 61 % of the week.')
  assert.equal(usageLine({ fiveHour: 12.4, sevenDay: null }), 'Usage now: 12 % of the five-hour limit.')
  assert.equal(usageLine({ fiveHour: null, sevenDay: null }), null)
  assert.equal(usageLine(null), null)
})

test('an empty night still renders, and says so plainly', () => {
  const r = buildRecap(EMPTY)
  assert.equal(r.headline, 'Night of 10 March: nothing happened')
  assert.deepEqual(r.totals, { commits: 0, linesAdded: 0, linesRemoved: 0, itemsDone: 0, sessions: 0, projectsMoved: 0 })
  assert.equal(r.perHour.length, 8)
  assert.ok(r.perHour.every((h) => Object.keys(h.byProject).length === 0))
  assert.equal(r.health, QUIET)
  assert.equal(r.needsLine, null)
  assert.equal(r.usageLine, null)

  const html = renderPage(r)
  assert.ok(html.includes('Night of 10 March: nothing happened'))
  assert.ok(html.includes('No commits tonight, so there is nothing to chart.'))
  assert.ok(html.includes('No session ran tonight.'))
  assert.ok(html.includes(QUIET))
  assert.ok(!html.includes('<svg class="chart"'))
  assert.ok(!html.includes('Needs you'))

  // Nothing given at all, as from a broken file: still a page.
  assert.match(renderPage(buildRecap()), /<title>Night recap<\/title>/)
  assert.match(renderPage(), /<main class="page">/)
  assert.equal(buildRecap({ ...EMPTY, sessions: [{ kind: 'worker', name: 'Worker 1' }] }).headline, 'Night of 10 March: no commits from 1 session')
})

test('every string from the night is escaped, wherever it lands', () => {
  const evil = '<script>alert(1)</script>'
  const r = buildRecap({
    ...EMPTY,
    commits: [
      { project: evil, at: EMPTY.window.start + 60_000, subject: evil, branch: evil },
      { project: 'b"q\'', at: EMPTY.window.start + 120_000, subject: 'x' },
    ],
    projects: [{ name: evil, duskPct: 10, nowPct: 20, totalTasks: 4, doneTasks: 1, left: [evil] }],
    sessions: [
      { kind: 'desktop', name: evil, project: evil, branch: evil, commits: 1, state: evil },
      { kind: 'worker', name: 'Worker 1', project: evil, results: [{ status: 'done', line: evil }] },
    ],
    needsOwner: [evil],
    usage: { fiveHour: 5 },
  })
  const html = renderPage(r)
  assert.ok(!/<script/i.test(html))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('b&quot;q&#39;'))
  for (const svg of [hourChart(r), projectChart(r), progressChart(r), legend(r)]) assert.ok(!/<script/i.test(svg))
})

test('the page and the code carry no em or en dash', () => {
  assert.ok(!DASHES.test(renderPage(busy())))
  assert.ok(!DASHES.test(renderPage(buildRecap(EMPTY))))
  for (const path of [
    '../engine/recap/data.mjs', '../engine/recap/charts.mjs', '../engine/recap/page.mjs',
    './recap.test.mjs', './fixtures/recap-busy.json',
  ]) assert.ok(!DASHES.test(source(path)), path)
})

test('the page meets the artifact contract: a short title, theme tokens, inline only', () => {
  const html = renderPage(busy())
  const title = /^<title>([^<]+)<\/title>/.exec(html)
  assert.ok(title, 'the page starts with its title')
  const words = title[1].trim().split(/\s+/).length
  assert.ok(words >= 2 && words <= 4)

  const tokens = (block) => new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]))
  const root = /:root\{([^}]*)\}/.exec(html)
  const media = /@media \(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/.exec(html)
  const toggle = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(html)
  assert.ok(root && media && toggle)
  for (const block of [media[1], toggle[1]]) {
    assert.match(block, /color-scheme:dark/)
    for (const name of tokens(block)) assert.ok(tokens(root[1]).has(name), `${name} is first defined on :root`)
  }
  assert.deepEqual([...tokens(media[1])].sort(), [...tokens(toggle[1])].sort())
  assert.match(html, /body\{[^}]*background:var\(--bg\)/)
  assert.match(html, /padding-left:max\(16px, env\(safe-area-inset-left, 0px\)\)/)
  assert.match(html, /padding-right:max\(16px, env\(safe-area-inset-right, 0px\)\)/)
  assert.match(html, /<meta name="claude:viewport-fit-sides" content="cover">/)

  assert.ok(!/<script/i.test(html), 'no script at all')
  assert.ok(!/\b(src|href)=/i.test(html), 'nothing loaded from elsewhere')
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(html))
  assert.deepEqual([...new Set(html.match(/https?:\/\/[^\s"')]+/g))], ['http://www.w3.org/2000/svg'])
  assert.ok(!/<(table|ul|ol|li)\b/i.test(html), 'no lists or tables')
  assert.ok(!/<(!doctype|html|head|body)\b/i.test(html), 'the host brings the document')
  assert.ok(html.trim().endsWith('</main>'))
  // The needs line comes last.
  assert.match(html, /<p class="needs"><b>Needs you:<\/b>[^<]*<\/p><\/footer><\/main>\s*$/)
})

test('a very busy night stays under 300 KB', () => {
  const start = at('2026-03-10T20:00:00Z')
  const names = Array.from({ length: 12 }, (_, i) => `project-number-${i + 1}`)
  const long = 'A long result line that a model wrote about what it changed and why, '.repeat(4)
  const r = buildRecap({
    zone: 'UTC',
    date: '2026-03-10',
    window: { start, end: start + 14 * 3_600_000 },
    now: start + 14 * 3_600_000,
    commits: Array.from({ length: 1500 }, (_, i) => ({
      project: names[i % 12], at: start + i * 33_000, subject: long, added: 40, removed: 8, branch: `night/2026-03-10/${names[i % 12]}`,
    })),
    projects: names.map((name, i) => ({ name, duskPct: i * 5, nowPct: i * 5 + 7, totalTasks: 40, doneTasks: 20, left: [long, long, long, long, long] })),
    sessions: Array.from({ length: 16 }, (_, i) => ({
      kind: i < 4 ? 'worker' : 'desktop', name: `Session ${i}`, project: names[i % 12], branch: `night/x/${i}`, commits: 90, state: 'working',
      results: Array.from({ length: 20 }, () => ({ status: 'done', line: long })),
    })),
    events: Array.from({ length: 5000 }, (_, i) => ({ kind: i % 2 ? 'guard.rewrite' : 'guard.deny' })),
    needsOwner: Array.from({ length: 40 }, () => long),
  })
  const html = renderPage(r)
  assert.ok(Buffer.byteLength(html) < 300 * 1024, `${Buffer.byteLength(html)} bytes`)
})

test('the drawings carry a title, a description and their numbers, and draw nothing from nothing', () => {
  const r = busy()
  for (const svg of [hourChart(r), projectChart(r), progressChart(r)]) {
    assert.match(svg, /^<svg class="chart"[^>]* role="img" aria-labelledby="(\w+)-t \1-d"><title id="\1-t">[^<]+<\/title><desc id="\1-d">[^<]+<\/desc>/)
    assert.ok(svg.endsWith('</svg>'))
    assert.ok(!/fill="#/.test(svg), 'colours come from the page tokens')
  }
  const hours = hourChart(r)
  for (const cls of ['k1', 'k2', 'k3', 'k4']) assert.ok(hours.includes(`mark ${cls}`))
  assert.ok(!hours.includes('mark k5'))
  assert.match(hours, /The busiest hour was 00:00 with 8\./)
  assert.match(projectChart(r), /dx="7" y="30">15<\/text>/)
  assert.match(progressChart(r), /12 % to 31 %<\/tspan> <tspan class="ink strong">\+19</)
  assert.equal(legend(r).match(/<span>/g).length, 4)
  assert.equal(legend({ series: [{ name: 'solo', slot: 0 }], perHour: [] }), '')

  const empty = buildRecap(EMPTY)
  assert.match(hourChart(empty), /No commits in this window\./)
  assert.match(projectChart(empty), /No commits in this window\./)
  assert.match(progressChart(empty), /No project has a plan to measure yet\./)
  assert.equal(hourChart({}).includes('<svg'), true)
  assert.equal(SERIES.light.length, 8)
  assert.equal(SERIES.dark.length, 8)
})
