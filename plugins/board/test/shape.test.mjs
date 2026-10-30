import { test } from 'node:test'
import assert from 'node:assert/strict'

import { colourOf, NEUTRAL } from '../hooks/charts.mjs'
import { dayColumns, hourColumns, kpiItems, OTHER, planInput, projectSeries, sessionsCard, summary } from '../hooks/shape.mjs'

const NOW = Date.parse('2026-03-10T11:40:00Z')

function view(over = {}) {
  return {
    now: NOW,
    totals: { commitsToday: 0, linesToday: 0, commits7d: 12, projectsToday: 0, projects7d: 3 },
    hours: [
      { start: 0, day: '2026-03-09', hour: 23, commits: 1 },
      { start: 1, day: '2026-03-10', hour: 0, commits: 0 },
      { start: 2, day: '2026-03-10', hour: 5, commits: 0 },
      { start: 3, day: '2026-03-10', hour: 6, commits: 2 },
    ],
    days: [
      { day: '2026-03-09', total: 5, projects: { alpha: 2, zeta: 3 } },
      { day: '2026-03-10', total: 7, projects: { beta: 4, alpha: 1, omega: 2 } },
    ],
    projects: [
      { name: 'beta', commits: 4, slot: 5 },
      { name: 'alpha', commits: 3, slot: 1 },
      { name: 'zeta', commits: 3, slot: null },
      { name: 'omega', commits: 2, slot: null },
    ],
    sessions: { source: 'registry', working: [], idle: 0 },
    plan: null,
    configFile: '~/.claude/tacos/board/config.json',
    ...over,
  }
}

test('the stack: projects in the order of their colours, the ones without one together as Other, last', () => {
  assert.deepEqual(projectSeries(view()), [
    { name: 'alpha', colour: colourOf(1) },
    { name: 'beta', colour: colourOf(5) },
    { name: OTHER, colour: NEUTRAL },
  ])
  assert.deepEqual(dayColumns(view()), [
    { label: 'Mon', title: 'Mon 9 Mar', values: { alpha: 2, Other: 3 } },
    { label: 'Today', title: 'Tue 10 Mar', values: { beta: 4, alpha: 1, Other: 2 } },
  ])
  assert.deepEqual(projectSeries(view({ projects: [{ name: 'alpha', commits: 1, slot: 0 }] })), [{ name: 'alpha', colour: colourOf(0) }])
})

test('the hours: midnight by its day, every sixth hour by its time, the rest unlabelled', () => {
  assert.deepEqual(hourColumns(view()), [
    { label: '', title: 'Mon 23:00', value: 1 },
    { label: 'Tue', title: 'Tue 00:00', value: 0 },
    { label: '', title: 'Tue 05:00', value: 0 },
    { label: '06:00', title: 'Tue 06:00', value: 2 },
  ])
})

test('the top row on a day with no commit yet', () => {
  assert.deepEqual(kpiItems(view()), [
    { label: 'Commits today', figure: '0', note: 'none yet' },
    { label: 'Lines added', figure: '0', note: 'today' },
    { label: 'Commits 7 days', figure: '12', note: 'in 3 projects' },
  ])
})

test('sessions: how long each has worked, or since its last write; a session without a known start says neither', () => {
  const listed = sessionsCard(view({
    sessions: { source: 'registry', working: [{ name: 'Beta · Fix', project: 'beta', since: NOW - 3 * 60_000 }, { name: 'Elsewhere', project: 'notes', since: null }], idle: 1 },
  }))
  assert.deepEqual(listed, {
    eyebrow: 'Working now',
    aside: '2 of 3 open',
    rows: [
      { name: 'Beta · Fix', detail: 'beta · working for 3 min', colour: colourOf(5) },
      { name: 'Elsewhere', detail: 'notes', colour: NEUTRAL },
    ],
    empty: 'No session is working right now.',
  })
  const recent = sessionsCard(view({ sessions: { source: 'transcripts', working: [], idle: null } }))
  assert.equal(recent.eyebrow, 'Active in the last 10 min')
  assert.equal(recent.aside, 'from transcripts')
  assert.match(recent.empty, /ten minutes/)
})

test('the plan card: its rows, why there are none, or where to set one', () => {
  const rows = [{ id: '1', name: 'One', done: true, note: '' }]
  assert.deepEqual(planInput(view({ plan: { file: '/p/plan.md', rows, done: 1, total: 1 } })), { kind: 'rows', aside: '1 of 1 done', rows })
  assert.deepEqual(planInput(view({ plan: { file: '/p/docs/plan.md', error: 'there is no section "Next"' } })), {
    kind: 'text',
    aside: 'plan.md',
    lines: ['The plan in /p/docs/plan.md could not be shown: there is no section "Next".'],
  })
  assert.match(planInput(view()).lines[0], /No plan is set\. .* in ~\/\.claude\/tacos\/board\/config\.json\./)
})

test('the board in words, for a terminal', () => {
  const lines = summary(view({
    sessions: { source: 'registry', working: [{ name: 'Beta · Fix', project: 'beta', since: null }], idle: 0 },
    plan: { file: '/p', done: 1, total: 5, rows: [{ id: '1', name: 'A', done: true, note: '' }, ...['B', 'C', 'D', 'E'].map((name, i) => ({ id: String(i + 2), name, done: false, note: '' }))] },
  }))

  assert.deepEqual(lines, [
    'Today: 0 commits, 0 lines added. Last 7 days: 12 commits in 3 projects.',
    'Working now: Beta · Fix (beta).',
    'Plan: 1 of 5 done. Open: 2 B, 3 C, 4 D.',
  ])
})
