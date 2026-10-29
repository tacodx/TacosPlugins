import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evidence, parsePlannerOutput, plannerArgs, plannerPrompt, readClaudeJson } from '../engine/planner.mjs'

const project = {
  name: 'alpha',
  repo: '/r/alpha',
  notes: [{ name: 'Session 5 Build the site', status: 'Doing', next: 'Build the pages', body: 'Long body. '.repeat(300) }],
}
const plan = {
  ref: 'feature',
  rows: [{ key: '5', name: 'Build the site', text: 'Pages in the repo', done: false }],
  checklists: [{ file: 'docs/plans/one.md', done: 1, total: 80, open: Array.from({ length: 79 }, (_, i) => ({ text: `step ${i}`, heading: 'Task' })) }],
}

test('the evidence names the branch, notes, rows, open boxes and queued items within bounds', () => {
  const text = evidence(project, plan, [{ at: Date.parse('2026-03-09T10:00:00Z'), subject: 'add pages' }], [{ status: 'done', title: 'Old item' }])
  assert.match(text, /Branch the night builds on: feature/)
  assert.match(text, /Roadmap row 5, Build the site: Pages in the repo/)
  assert.match(text, /2026-03-09 add pages/)
  assert.match(text, /\[done\] Old item/)
  assert.equal((text.match(/- \[ \] step/g) ?? []).length, 60)
  assert.ok(text.length < 12_000)
})

test('the prompt asks for a map only the first time', () => {
  assert.match(plannerPrompt('E', { wantMap: true }), /map the project's whole current plan/)
  assert.doesNotMatch(plannerPrompt('E', { wantMap: false }), /map the project's whole current plan/)
  assert.match(plannerPrompt('E', { wantMap: true }), /need no decision from the owner/)
})

test('the planner runs with no tools, no MCP, no user settings and a schema', () => {
  const args = plannerArgs({ prompt: 'P', model: 'sonnet' })
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'local')
  assert.ok(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.items)
  assert.equal(args.at(-1), 'sonnet')
})

test('only decision-free items survive, tasks keep known ids, at most six', () => {
  const out = parsePlannerOutput({
    map: { basis: 'b', tasks: [{ id: 't1', title: 'A', done: true }, { id: 't1', title: 'dupe', done: false }, { id: 't2', title: 'B', done: false }] },
    items: [
      { title: 'Ask the owner about colours', why: 'w', doneWhen: 'd', task: 't2', decisionFree: false },
      ...Array.from({ length: 8 }, (_, i) => ({ title: `Item ${i}`, why: 'w', doneWhen: 'd', task: i === 0 ? 't2' : 't9', decisionFree: true })),
    ],
  })
  assert.equal(out.map.tasks.length, 2)
  assert.equal(out.items.length, 6)
  assert.equal(out.items[0].title, 'Item 0')
  assert.equal(out.items[0].task, 't2')
  assert.equal(out.items[1].task, null)
})

test('an answer in a fenced string is read too; nonsense throws', () => {
  const out = parsePlannerOutput('```json\n{"map":{"basis":"x","tasks":[]},"items":[]}\n```')
  assert.deepEqual(out.items, [])
  assert.throws(() => parsePlannerOutput('{"nope":1}'))
})

test('the structured answer is taken from Claude\'s JSON output, an error result throws', () => {
  const ok = readClaudeJson(JSON.stringify({ is_error: false, structured_output: { items: [] }, total_cost_usd: 0.02 }))
  assert.deepEqual(ok.answer, { items: [] })
  assert.throws(() => readClaudeJson(JSON.stringify({ is_error: true, result: 'limit' })), /planner call failed/)
})
