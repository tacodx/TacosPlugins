// The pane's pure helpers: its words, its reading of a run, its drawing.
// The engine tests of the pane itself are in mod.test.ts. Every name is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRun } from '../hooks/answer.mjs'
import { SVG_LIMIT, cut, tonightAlt, tonightCard, wrap } from '../hooks/card.mjs'
import {
  attention,
  clock,
  controls,
  fansLines,
  list,
  phaseLine,
  recapLine,
  stateWords,
  summary,
  timeOfDay,
  usageWords,
  watchersWords,
  workerLine,
} from '../hooks/words.mjs'

const ZONE = 'Europe/Berlin'
// 29 October 2026 is after the clocks went back: Berlin is UTC+1.
const START = Date.parse('2026-10-29T22:30:00Z') // 23:30 in Berlin
const END = Date.parse('2026-10-30T05:30:00Z') // 06:30

function view(over = {}) {
  return {
    version: 1,
    now: START,
    phase: 'idle',
    date: '2026-10-29',
    window: { from: '23:30', to: '06:30' },
    armed: null,
    sessions: 2,
    workers: [],
    watchers: [],
    queue: { open: 0, taken: 0, done: 0, parked: 0, failed: 0 },
    usage: null,
    health: { line: 'All fine', blockers: 0 },
    projects: [],
    fans: { token: true, dayMode: true, nightMode: true, tokenPath: '/home/someone/.config/night/token' },
    recap: null,
    problems: [],
    ...over,
  }
}

const worker = (over = {}) => ({ slot: 1, state: 'working', project: 'alpha-site', item: 'Add the login form', since: START, limitedUntil: null, ...over })

test('clock writes an instant as HH:MM in the zone, and nothing for what is no time', () => {
  assert.equal(clock(START, ZONE), '23:30')
  assert.equal(clock(END, ZONE), '06:30')
  assert.equal(clock(START, 'UTC'), '22:30')
  assert.equal(clock('2026-10-30T01:10:00Z', ZONE), '02:10')
  assert.equal(clock(null, ZONE), '')
  assert.equal(clock(undefined, ZONE), '')
  assert.equal(clock('soon', ZONE), '')
  assert.equal(clock(Number.NaN, ZONE), '')
})

test('timeOfDay takes what a person types and gives HH:MM, or null', () => {
  assert.equal(timeOfDay('23:30'), '23:30')
  assert.equal(timeOfDay(' 7:05 '), '07:05')
  assert.equal(timeOfDay('00:00'), '00:00')
  for (const bad of ['24:00', '23:60', '2330', '23.30', '', 'late']) assert.equal(timeOfDay(bad), null, bad)
})

test('list joins names as a sentence does', () => {
  assert.equal(list([]), '')
  assert.equal(list(['medic']), 'medic')
  assert.equal(list(['medic', 'logs']), 'medic and logs')
  assert.equal(list(['a', 'b', 'c'], 'or'), 'a, b or c')
})

test('the phase in plain words', () => {
  const armed = { start: START, end: END }
  assert.equal(phaseLine(view(), ZONE), 'Not armed')
  assert.equal(phaseLine(view({ phase: 'armed', armed }), ZONE), 'Armed for 23:30 to 06:30')
  assert.equal(phaseLine(view({ phase: 'armed', window: { from: '22:00', to: '07:00' } }), ZONE), 'Armed for 22:00 to 07:00')
  assert.equal(phaseLine(view({ phase: 'dusk', armed }), ZONE), 'Night starting')
  assert.equal(phaseLine(view({ phase: 'night', armed: { start: START + 60_000, end: END } }), ZONE), 'Night running since 23:31')
  assert.equal(phaseLine(view({ phase: 'night' }), ZONE), 'Night running')
  assert.equal(phaseLine(view({ phase: 'day', workers: [worker(), worker({ slot: 2, state: 'off' })] }), ZONE), 'Morning: workers still going')
  assert.equal(phaseLine(view({ phase: 'day', workers: [worker({ state: 'off' })] }), ZONE), 'Morning: workers done')
  assert.equal(phaseLine(view({ phase: 'stopped' }), ZONE), 'Stopped')
})

test('the buttons each phase offers', () => {
  assert.deepEqual(controls('idle'), { arm: 'arm', start: true, stop: false })
  assert.deepEqual(controls('armed'), { arm: 'disarm', start: true, stop: false })
  assert.deepEqual(controls('stopped'), { arm: 'arm', start: true, stop: false })
  for (const phase of ['dusk', 'night', 'day']) assert.deepEqual(controls(phase), { arm: null, start: false, stop: true }, phase)
})

test('a worker in one line, in each state', () => {
  assert.equal(workerLine(worker(), ZONE), '1. alpha-site: Add the login form, working')
  assert.equal(workerLine(worker({ state: 'waiting', item: null }), ZONE), '1. alpha-site, waiting for work')
  assert.equal(workerLine(worker({ state: 'waiting', project: null, item: null }), ZONE), '1. waiting for work')
  assert.equal(workerLine(worker({ state: 'limited', limitedUntil: Date.parse('2026-10-30T01:10:00Z') }), ZONE), '1. alpha-site: Add the login form, limited until 02:10')
  assert.equal(stateWords(worker({ state: 'limited' }), ZONE), 'limited')
  assert.equal(stateWords(worker({ state: 'paused' }), ZONE), 'paused for memory')
  assert.equal(stateWords(worker({ state: 'off' }), ZONE), 'off')
  assert.equal(stateWords(worker({ state: 'something new' }), ZONE), 'off')
})

test('watchers, usage, and the one line for the owner', () => {
  assert.equal(watchersWords([{ name: 'health', ok: true }]), 'all fine')
  assert.equal(watchersWords([{ name: 'health', ok: true }, { name: 'medic', ok: false }]), 'medic is late')
  assert.equal(watchersWords([{ name: 'logs', ok: false }, { name: 'medic', ok: false }]), 'logs and medic are late')

  assert.equal(usageWords(null, ZONE), 'not read yet')
  assert.equal(usageWords({ fiveHour: 41.6, sevenDay: 18, resetsAt: Date.parse('2026-10-30T01:00:00Z') }, ZONE), '42 % of five hours, 18 % of the week, resets 02:00')
  assert.equal(usageWords({ fiveHour: null, sevenDay: 18, resetsAt: null }, ZONE), '18 % of the week')

  assert.equal(attention(view()), null)
  assert.equal(attention(view({ problems: ['No CoolerControl token'] })), 'No CoolerControl token')
  assert.equal(attention(view({ problems: ['a', 'b', 'c'] })), 'a (and 2 more)')
  assert.equal(attention(view({ health: { line: 'Swap is full', blockers: 1 }, problems: ['a'] })), 'Swap is full')
})

test('a recap line names its project once', () => {
  assert.equal(recapLine({ name: 'slait', line: '40 % to 58 %, +18' }), 'slait, 40 % to 58 %, +18')
  assert.equal(recapLine({ name: 'slait', line: 'slait, 40 % to 58 %, +18' }), 'slait, 40 % to 58 %, +18')
})

test('the summary shows watchers and the queue only while a night runs or has work', () => {
  const idle = summary(view({ usage: { fiveHour: 5, sevenDay: 9, resetsAt: null } }), ZONE)
  assert.deepEqual(idle.rows.map((row) => row.label), ['Usage'])
  assert.equal(idle.noWorkers, false)
  assert.equal(idle.window, '23:30 to 06:30')

  const night = summary(
    view({
      phase: 'night',
      armed: { start: START, end: END },
      workers: [worker()],
      watchers: [{ name: 'medic', ok: false, lastBeat: START }],
      queue: { open: 4, taken: 1, done: 2, parked: 1, failed: 0 },
    }),
    ZONE,
  )
  assert.deepEqual(night.rows, [
    { label: 'Watchers', value: 'medic is late', isLate: true },
    { label: 'Queue', value: '4 open, 2 done, 1 parked', isLate: false },
    { label: 'Usage', value: 'not read yet', isLate: false },
  ])
  assert.equal(night.workers[0].tone, 'working')
  assert.equal(summary(view({ phase: 'dusk' }), ZONE).noWorkers, true)
})

test('the fans line, and a guide to only what is missing', () => {
  assert.deepEqual(fansLines({ token: true, dayMode: true, nightMode: true, tokenPath: '/t' }), ['Fans: the CoolerControl token and the Day and Night modes are there.'])
  assert.deepEqual(fansLines({ token: false, dayMode: false, nightMode: false, tokenPath: '/t' }), [
    'Fans: no CoolerControl token, Day mode or Night mode found yet.',
    'In CoolerControl, make a mode called Day from your current fans and one called Night with the quiet curves you want overnight,',
    'then save an access token to /t.',
  ])
  assert.deepEqual(fansLines({ token: true, dayMode: true, nightMode: false, tokenPath: '/t' }), [
    'Fans: no Night mode found yet.',
    'In CoolerControl, make a mode called Night with the quiet curves you want overnight.',
  ])
  assert.deepEqual(fansLines({ token: false, dayMode: true, nightMode: true, tokenPath: '/t' }), [
    'Fans: no CoolerControl token found yet.',
    'In CoolerControl, make an access token and save it to /t.',
  ])
})

const ran = (stdout, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false })

test('readRun takes a view, an action that worked, and the reasons there is none', () => {
  assert.equal(readRun(ran(JSON.stringify(view()))).view.phase, 'idle')
  assert.equal(readRun(ran(JSON.stringify({ ok: true, view: view({ phase: 'armed' }) }))).view.phase, 'armed')
  assert.deepEqual(readRun(ran(JSON.stringify({ ok: false, error: 'no systemd' }), 1)), { reason: 'no systemd' })
  assert.deepEqual(readRun(ran('', 1, 'night: boom\n')), { reason: 'boom' })
  assert.deepEqual(readRun(ran('', 2)), { reason: 'night stopped with exit code 2' })
  assert.deepEqual(readRun(ran('Segmentation fault')), { reason: 'night did not print a view' })
  assert.deepEqual(readRun(ran(JSON.stringify({ version: 2 }))), { reason: 'night printed a view this pane does not understand' })
  assert.deepEqual(readRun({ ...ran('{'), isStdoutTruncated: true }), { reason: 'night printed more than this pane can read' })
})

test('cut and wrap keep text inside the card', () => {
  assert.equal(cut('short', 10), 'short')
  assert.equal(cut('a long item title', 8), 'a long …')
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four'])
})

test('the card draws every part, escapes names, and stays within what an Svg may hold', () => {
  const said = summary(
    view({
      phase: 'day',
      armed: { start: START, end: END },
      workers: [worker({ item: 'Fix <script> & "quotes"' }), worker({ slot: 2, state: 'limited', limitedUntil: Date.parse('2026-10-30T01:10:00Z') })],
      watchers: [{ name: 'health', ok: true, lastBeat: START }],
      queue: { open: 1, taken: 0, done: 9, parked: 0, failed: 0 },
      recap: { headline: 'Two projects moved', projects: [{ name: 'alpha-site', line: '40 % to 58 %, +18' }], artifactUrl: null },
      problems: ['One item waits for you'],
    }),
    ZONE,
  )
  const svg = tonightCard(said)
  assert.ok(svg.startsWith('<svg '))
  assert.ok(svg.length <= SVG_LIMIT)
  assert.match(svg, />Morning: workers still going</)
  assert.match(svg, />23:30 TO 06:30</)
  assert.match(svg, />limited until 02:10</)
  assert.match(svg, /Fix &lt;script&gt; &amp; &quot;quotes&quot;/)
  assert.doesNotMatch(svg, /<script>/)
  assert.match(svg, />all fine</)
  assert.match(svg, />Two projects moved</)
  assert.match(svg, />alpha-site, 40 % to 58 %, \+18</)
  assert.match(svg, /class="late"[^>]*>One item waits for you</)
  assert.match(tonightAlt(said), /^Morning: workers still going\. 1\. alpha-site/)
})

test('a card with too much to draw falls back to the phase alone', () => {
  const said = summary(view({ phase: 'night', workers: Array.from({ length: 3000 }, (_, i) => worker({ slot: i + 1 })) }), ZONE)
  const svg = tonightCard(said)
  assert.ok(svg.length <= SVG_LIMIT)
  assert.match(svg, />Night running</)
})

test('no dashes the owner does not write: no em or en dash in the pane', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = [
    ...readdirSync(join(root, 'hooks')).filter((name) => /\.(mjs|tsx|json)$/.test(name)).map((name) => join(root, 'hooks', name)),
    ...readdirSync(join(root, 'hooks', 'tabs')).map((name) => join(root, 'hooks', 'tabs', name)),
    join(root, 'types', 'index.d.ts'),
    join(root, 'test', 'mod.test.ts'),
    join(root, 'test', 'pane.test.mjs'),
  ]
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /[\u2013\u2014]/, file)
})
