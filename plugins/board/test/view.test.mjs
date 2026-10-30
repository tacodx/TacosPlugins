import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { createClock, hourStart } from '../reader/clock.mjs'
import { assignColours, buildView } from '../reader/view.mjs'

const ms = (iso) => Date.parse(iso)
const at = (iso, project = 'alpha', a = 1) => ({ h: `${project}-${iso}`, t: ms(iso), a, project })
const NO_SESSIONS = { source: 'registry', working: [], idle: 0 }

function view(commits, { now, zone = 'Europe/Berlin', colours = {} }) {
  return buildView({ commits, now: ms(now), zone, sessions: NO_SESSIONS, plan: null, colours, refreshMinutes: 3, repos: { count: 2, unreadable: [] }, notes: [] })
}

test('the hour starts on the local hour, half-hour zones included', () => {
  assert.equal(hourStart(ms('2026-03-10T11:40:30.250Z'), 'Europe/Berlin'), ms('2026-03-10T11:00:00Z'))
  assert.equal(hourStart(ms('2026-03-10T11:40:00Z'), 'Asia/Kolkata'), ms('2026-03-10T11:30:00Z'))
  assert.equal(hourStart(ms('2026-03-10T11:20:00Z'), 'Asia/Kolkata'), ms('2026-03-10T10:30:00Z'))
  assert.equal(hourStart(ms('2026-03-10T11:50:00Z'), 'Asia/Kathmandu'), ms('2026-03-10T11:15:00Z'))
})

test('thirty hours, oldest first, the last one the hour we are in', () => {
  const { view: v } = view(
    [
      at('2026-03-10T11:39:59Z'),
      at('2026-03-10T10:59:00Z'),
      at('2026-03-10T10:01:00Z', 'beta'),
      at('2026-03-09T06:00:00Z'),
      at('2026-03-09T05:59:59Z'), // thirty hours and a second ago: gone
      at('2026-03-10T12:00:00Z'), // a clock ahead of this one: not yet
    ],
    { now: '2026-03-10T11:40:00Z' },
  )

  assert.equal(v.hours.length, 30)
  assert.deepEqual(v.hours[0], { start: ms('2026-03-09T06:00:00Z'), day: '2026-03-09', hour: 7, commits: 1 })
  assert.deepEqual(v.hours[29], { start: ms('2026-03-10T11:00:00Z'), day: '2026-03-10', hour: 12, commits: 1 })
  assert.equal(v.hours[28].commits, 2)
  assert.equal(v.hours.reduce((sum, each) => sum + each.commits, 0), 4)
})

test('in a half-hour zone the hours are its own', () => {
  const { view: v } = view([at('2026-03-10T11:20:00Z')], { now: '2026-03-10T11:40:00Z', zone: 'Asia/Kolkata' })

  assert.deepEqual(v.hours[29], { start: ms('2026-03-10T11:30:00Z'), day: '2026-03-10', hour: 17, commits: 0 })
  assert.deepEqual(v.hours[28], { start: ms('2026-03-10T10:30:00Z'), day: '2026-03-10', hour: 16, commits: 1 })
})

test('seven local days per project, a commit after local midnight in the new day', () => {
  const { view: v } = view(
    [
      at('2026-03-09T23:30:00Z', 'alpha'), // 00:30 on the 10th in Berlin
      at('2026-03-10T08:00:00Z', 'beta', 40),
      at('2026-03-10T09:00:00Z', 'beta', 2),
      at('2026-03-03T23:00:00Z', 'gamma'), // 00:00 on the 4th: the first day
      at('2026-03-03T22:59:59Z', 'gamma'), // the 3rd: before the week
    ],
    { now: '2026-03-10T11:40:00Z' },
  )

  assert.deepEqual(
    v.days.map((each) => each.day),
    ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
  )
  assert.deepEqual(v.days[0], { day: '2026-03-04', total: 1, projects: { gamma: 1 } })
  assert.deepEqual(v.days[6], { day: '2026-03-10', total: 3, projects: { alpha: 1, beta: 2 } })
  assert.deepEqual(v.totals, { commitsToday: 3, linesToday: 43, commits7d: 4, projectsToday: 2, projects7d: 3 })
  assert.equal(v.today, '2026-03-10')
  assert.deepEqual(
    v.projects.map(({ name, commits }) => ({ name, commits })),
    [{ name: 'beta', commits: 2 }, { name: 'alpha', commits: 1 }, { name: 'gamma', commits: 1 }],
  )
})

test('the view says when it was made, in local time, and passes the rest through', () => {
  const sessions = { source: 'transcripts', working: [{ name: 'alpha', project: 'alpha', since: 1 }], idle: null }
  const plan = { file: '/p/plan.md', rows: [], done: 0, total: 0 }

  const { view: v } = buildView({
    commits: [], now: ms('2026-03-10T11:40:00Z'), zone: 'Europe/Berlin', sessions, plan, colours: {}, refreshMinutes: 5, repos: { count: 4, unreadable: ['broken'] }, notes: ['a note'],
  })

  assert.equal(v.version, 1)
  assert.equal(v.generatedAt, '2026-03-10T11:40:00.000Z')
  assert.equal(v.now, ms('2026-03-10T11:40:00Z'))
  assert.equal(v.updated, '12:40')
  assert.equal(v.refreshMinutes, 5)
  assert.deepEqual(v.sessions, sessions)
  assert.deepEqual(v.plan, plan)
  assert.deepEqual(v.repos, { count: 4, unreadable: ['broken'] })
  assert.deepEqual(v.notes, ['a note'])
  assert.deepEqual(v.totals, { commitsToday: 0, linesToday: 0, commits7d: 0, projectsToday: 0, projects7d: 0 })
})

test('a project keeps its colour; a new one takes the lowest free; two never share one', () => {
  const book = { beta: 0, gamma: 0, dormant: 5 }
  const active = [{ name: 'alpha', commits: 3 }, { name: 'beta', commits: 2 }, { name: 'gamma', commits: 1 }]

  assert.deepEqual(assignColours(active, book), { beta: 0, gamma: 2, dormant: 5, alpha: 1 })
  // The same week again changes nothing.
  assert.deepEqual(assignColours(active, { beta: 0, gamma: 2, dormant: 5, alpha: 1 }), { beta: 0, gamma: 2, dormant: 5, alpha: 1 })
})

test('past eight projects at once, the quietest ones go uncoloured', () => {
  const active = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, commits: 20 - i }))

  const book = assignColours(active, {})

  assert.deepEqual(Object.keys(book).sort(), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  assert.deepEqual(new Set(Object.values(book)).size, 8)
})

test('a busy newcomer is coloured though every slot is held: the quietest active project gives its slot up', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const book = Object.fromEntries(names.map((name, i) => [name, i]))
  const active = [{ name: 'zbusy', commits: 100 }, ...names.map((name) => ({ name, commits: 1 }))]

  const next = assignColours(active, book)

  assert.equal(next.zbusy, 7)
  assert.equal(next.h, undefined)
  assert.deepEqual(names.slice(0, 7).map((name) => next[name]), [0, 1, 2, 3, 4, 5, 6])
})

test('in the view, only the eight busiest projects are coloured, whatever the book says', () => {
  const commits = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].flatMap((name, i) =>
    Array.from({ length: 9 - i }, (_, k) => at(`2026-03-10T0${k}:00:00Z`, name)),
  )
  const { view: v } = view(commits, { now: '2026-03-10T11:40:00Z', colours: { i: 3, x: 3 } })

  assert.equal(v.projects.find((each) => each.name === 'i').slot, null)
  assert.equal(new Set(v.projects.map((each) => each.slot).filter((slot) => slot !== null)).size, 8)
})

test('the colours in the view come from the book, and the book comes back with any new ones', () => {
  const { view: v, colours } = view([at('2026-03-10T08:00:00Z', 'alpha'), at('2026-03-10T09:00:00Z', 'beta')], {
    now: '2026-03-10T11:40:00Z',
    colours: { beta: 4 },
  })

  assert.deepEqual(v.projects, [{ name: 'alpha', commits: 1, slot: 0 }, { name: 'beta', commits: 1, slot: 4 }])
  assert.deepEqual(colours, { beta: 4, alpha: 0 })
})

test('the clock gives the local day and hour', () => {
  const clock = createClock('Europe/Berlin')

  assert.deepEqual(clock(ms('2026-03-09T23:30:00Z')), { day: '2026-03-10', hour: 0 })
})

test('with TZ set but empty, the reader falls back to UTC instead of failing', () => {
  const clock = new URL('../reader/clock.mjs', import.meta.url).href
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', `import { systemTimeZone } from '${clock}'; console.log(systemTimeZone())`], {
    encoding: 'utf8',
    env: { ...process.env, TZ: '' },
  })

  const zone = ran.stdout.trim()
  assert.equal(ran.status, 0, ran.stderr)
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }))
  assert.notEqual(zone, '')
})
