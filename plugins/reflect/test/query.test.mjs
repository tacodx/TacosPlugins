import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyMergedDay } from '../indexer/agg.mjs'
import { buildView } from '../indexer/query.mjs'
import { utc } from './helpers.mjs'

const TODAY = '2026-03-10' // a Tuesday
const ms = (iso) => Date.parse(iso)
const hoursAt = (hour, n) => {
  const hours = new Array(24).fill(0)
  hours[hour] = n
  return hours
}
const day = (fields) => ({ ...emptyMergedDay(), ...fields })
const usage = (out) => ({ msgs: 1, out, inp: 0, cacheR: 0, cacheW: 0 })
const typed = (n, hour = 12) => ({ prompts: n, hours: hoursAt(hour, n) })
const activeOn = (list) => Object.fromEntries(list.map((each) => [each, typed(1)]))
const session = (id, start, fields = {}) => ({
  id,
  project: 'demo',
  title: null,
  entrypoint: 'cli',
  start: ms(start),
  end: ms(start) + 1000,
  activeMs: 0,
  prompts: 0,
  out: 0,
  ...fields,
})
const view = (over) =>
  buildView({
    days: {},
    sessions: [],
    history: {},
    work: null,
    rangeId: '7d',
    today: TODAY,
    clock: utc,
    generatedAt: '2026-03-10T12:00:00.000Z',
    ...over,
  })

test('a range of seven days is today and the six days before it, and nothing after today', () => {
  const v = view({
    days: {
      '2026-03-03': day(typed(5)),
      '2026-03-04': day(typed(1)),
      '2026-03-11': day(typed(9)), // a clock that ran ahead
    },
  })

  assert.deepEqual(v.range, { id: '7d', from: '2026-03-04', to: TODAY, days: 7 })
  assert.equal(v.totals.prompts, 1)
  assert.deepEqual(
    v.days.map((each) => each.day),
    ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
  )
  assert.deepEqual(v.days[0], { day: '2026-03-04', prompts: 1, out: 0, sessions: 0, models: {} })
})

test('a day takes its prompts, and their hours, from whichever source has more', () => {
  const v = view({
    days: {
      '2026-03-08': day(typed(2, 8)), // Sunday: a tie goes to the transcripts
      '2026-03-09': day(typed(3, 9)), // Monday: history has more
      '2026-03-10': day(typed(4, 10)), // Tuesday: the transcripts have more
    },
    history: {
      '2026-03-07': typed(1, 7), // Saturday: history only
      '2026-03-08': typed(2, 22),
      '2026-03-09': typed(5, 20),
      '2026-03-10': typed(2, 21),
    },
  })

  assert.equal(v.totals.prompts, 1 + 2 + 5 + 4)
  assert.equal(v.totals.activeDays, 4)
  assert.equal(v.hours[5][7], 1)
  assert.equal(v.hours[6][8], 2)
  assert.equal(v.hours[6][22], 0)
  assert.equal(v.hours[0][20], 5)
  assert.equal(v.hours[0][9], 0)
  assert.equal(v.hours[1][10], 4)
  assert.equal(v.hours[1][21], 0)
})

test('streaks count consecutive active days over all history, whatever the range', () => {
  const untilYesterday = view({
    history: activeOn(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05', '2026-03-08', '2026-03-09']),
  })
  assert.equal(untilYesterday.totals.currentStreak, 2) // no prompt yet today, so it ends yesterday
  assert.equal(untilYesterday.totals.bestStreak, 3) // 1 to 3 March, outside the seven-day range

  const throughToday = view({ history: activeOn(['2026-03-08', '2026-03-09', '2026-03-10']) })
  assert.equal(throughToday.totals.currentStreak, 3)

  const broken = view({ history: activeOn(['2026-03-07', '2026-03-08']) })
  assert.equal(broken.totals.currentStreak, 0)
  assert.equal(broken.totals.bestStreak, 2)
})

test('sessions belong to the range their start falls in, and a project counts them', () => {
  const v = view({
    days: { '2026-03-09': day({ projects: { demo: { prompts: 3, out: 10, sessions: 1 } } }) },
    sessions: [
      session('a', '2026-03-09T10:00:00Z', { title: 'A', entrypoint: 'claude-desktop', activeMs: 5000, prompts: 3 }),
      session('b', '2026-03-10T08:00:00Z', { title: 'B', activeMs: 9000, prompts: 1 }),
      session('c', '2026-03-01T08:00:00Z', { title: 'C', activeMs: 99_000, prompts: 50 }), // before the range
    ],
  })

  assert.equal(v.totals.sessions, 2)
  assert.equal(v.totals.desktopSessions, 1)
  assert.equal(v.totals.cliSessions, 1)
  assert.deepEqual(v.sessions.longest.map((each) => each.title), ['B', 'A'])
  assert.deepEqual(v.sessions.mostPrompts.map((each) => each.title), ['A', 'B'])
  assert.deepEqual(v.sessions.longest[0], {
    title: 'B',
    project: 'demo',
    start: ms('2026-03-10T08:00:00Z'),
    activeMs: 9000,
    prompts: 1,
  })
  assert.deepEqual(v.projects, [{ name: 'demo', prompts: 3, out: 10, sessions: 2 }])
  assert.equal(v.totals.projects, 1)
})

test('token totals add up over the range, and the cache hit rate is read tokens over all input', () => {
  const v = view({
    days: {
      '2026-03-09': day({ out: 10, inp: 1, cacheR: 40, cacheW: 4, msgs: 2, subMsgs: 3, activeMs: 1000 }),
      '2026-03-10': day({ out: 5, cacheR: 50, cacheW: 5, msgs: 1, activeMs: 500, sessions: 2 }),
    },
  })

  assert.equal(v.totals.out, 15)
  assert.equal(v.totals.inp, 1)
  assert.equal(v.totals.cacheR, 90)
  assert.equal(v.totals.cacheW, 9)
  assert.equal(v.totals.msgs, 3)
  assert.equal(v.totals.subMsgs, 3)
  assert.equal(v.totals.activeMs, 1500)
  assert.equal(v.totals.cacheHitRate, 0.9)
  assert.deepEqual(v.days.at(-1), { day: TODAY, prompts: 0, out: 5, sessions: 2, models: {} })
  assert.equal(view({}).totals.cacheHitRate, null)
})

test('lists are ranked, ties broken by name, and capped', () => {
  // t01 … t16 with counts 16 … 1, and one more that ties with the top.
  const tools = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`t${String(i + 1).padStart(2, '0')}`, 16 - i]))
  tools.aaa = 16
  const v = view({ days: { [TODAY]: day({ tools, skills: { b: 1, a: 1 }, efforts: { high: 2, max: 5 } }) } })

  assert.equal(v.tools.length, 15)
  assert.deepEqual(v.tools.slice(0, 3), [
    { name: 'aaa', n: 16 },
    { name: 't01', n: 16 },
    { name: 't02', n: 15 },
  ])
  assert.equal(v.tools.at(-1).name, 't14')
  assert.equal(v.totals.toolCalls, 152) // every call, not only the fifteen listed
  assert.deepEqual(v.skills, [
    { name: 'a', n: 1 },
    { name: 'b', n: 1 },
  ])
  assert.deepEqual(v.efforts, [
    { name: 'max', n: 5 },
    { name: 'high', n: 2 },
  ])
})

test('models are ranked by output; a day names the top six and folds the rest into other', () => {
  // m1 … m8 with output 8 … 1.
  const models = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i + 1}`, usage(8 - i)]))
  const v = view({ days: { [TODAY]: day({ models, out: 36 }) } })

  assert.deepEqual(v.models.map((each) => each.name), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'])
  assert.deepEqual(v.models[0], { name: 'm1', msgs: 1, out: 8, inp: 0, cacheR: 0, cacheW: 0 })
  assert.deepEqual(v.days.at(-1).models, { m1: 8, m2: 7, m3: 6, m4: 5, m5: 4, m6: 3, other: 3 })
})

test('the previous window is the same length, immediately before, and absent for all time', () => {
  const v = view({
    days: {
      '2026-02-24': day({ out: 1000 }), // one day too early
      '2026-02-25': day({ out: 1 }),
      '2026-03-03': day({ out: 50, activeMs: 700 }),
    },
    history: { '2026-03-03': typed(5) },
    sessions: [
      session('p', '2026-03-02T09:00:00Z'),
      session('q', '2026-03-09T09:00:00Z'), // in the current range, so not in the previous one
    ],
  })

  assert.deepEqual(v.previous, { prompts: 5, sessions: 1, out: 51, activeMs: 700 })
  assert.equal(v.totals.sessions, 1)
  assert.equal(view({ rangeId: 'all' }).previous, null)
})

test('the work mix covers the range, by type, by month and by project', () => {
  const v = view({
    work: [
      { day: '2026-02-01', project: 'old', type: 'feature', n: 9 }, // before the range
      { day: '2026-03-09', project: 'demo', type: 'bugfix', n: 1 },
      { day: '2026-03-09', project: 'demo', type: 'feature', n: 2 },
      { day: '2026-03-10', project: 'other', type: 'feature', n: 4 },
    ],
  })

  assert.deepEqual(v.work, {
    types: [
      { name: 'feature', n: 6 },
      { name: 'bugfix', n: 1 },
    ],
    byMonth: [{ month: '2026-03', types: { bugfix: 1, feature: 6 } }],
    byProject: [
      { name: 'other', n: 4, types: { feature: 4 } },
      { name: 'demo', n: 3, types: { bugfix: 1, feature: 2 } },
    ],
  })
  assert.equal(view({ work: null }).work, null)
  assert.deepEqual(view({ work: [] }).work, { types: [], byMonth: [], byProject: [] })
})

test("all time starts at the earliest day any source has, and coverage names each source's first day", () => {
  const v = view({
    rangeId: 'all',
    days: { '2026-03-09': day({ out: 1 }) },
    history: { '2025-12-31': typed(1) },
    work: [{ day: '2026-01-15', project: 'demo', type: 'feature', n: 1 }],
  })

  assert.deepEqual(v.range, { id: 'all', from: '2025-12-31', to: TODAY, days: 70 })
  assert.deepEqual(v.coverage, { transcriptsFrom: '2026-03-09', historyFrom: '2025-12-31', workFrom: '2026-01-15' })

  const empty = view({ rangeId: 'all' })
  assert.deepEqual(empty.range, { id: 'all', from: TODAY, to: TODAY, days: 1 })

  // A clock that ran ahead: the only known day is after today.
  const ahead = view({ rangeId: 'all', days: { '2026-03-12': day({ out: 1 }) } })
  assert.deepEqual(ahead.range, { id: 'all', from: TODAY, to: TODAY, days: 1 })
  assert.deepEqual(empty.coverage, { transcriptsFrom: null, historyFrom: null, workFrom: null })
})

test('an unknown range is refused', () => {
  assert.throws(() => view({ rangeId: '1y' }), /unknown range/)
})

test('the view carries its version, its time and the notes it was given', () => {
  const v = view({ notes: ['a moment behind'] })

  assert.equal(v.version, 1)
  assert.equal(v.generatedAt, '2026-03-10T12:00:00.000Z')
  assert.deepEqual(v.notes, ['a moment behind'])
})
