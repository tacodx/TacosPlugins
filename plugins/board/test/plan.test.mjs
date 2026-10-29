import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePlan, readPlan } from '../reader/plan.mjs'
import { tempDir } from './helpers.mjs'

const DOC = `# A plan

Some words first.

| Kind | Count |
| --- | --- |
| not | this one |

## Sessions, in order

Intro text with a | pipe in it.

| # | Session | What it decides or builds | Needs |
| --- | --- | --- | --- |
| ~~1~~ | ~~**Offer**~~ | **Done and signed off 2026-10-27.** Prices live in \`offer.json\` | |
| 2 | **Design** | **Reopened 2026-10-28.** The system is in [DESIGN.md](DESIGN.md) | nothing |
| 3 | **Build the site** | The rebuilt site, in the repo. **Step one is the copy** | 1, 2 |
|~~G~~|~~**Mail and the paper trail**~~|**Done 2026-10-28.** Labels \\| filters|  |
| N | **Night mode** | Idea, 2026-10-29: one command before sleep | nothing |
| B | Live *board* | __Idea__, a pane beside the chat | nothing |

## Decided direction

| # | Session |
| --- | --- |
| 9 | **Later** |
`

test('the rows of the named section\'s table: number, name, done, and a short status', () => {
  assert.deepEqual(parsePlan(DOC, 'Sessions, in order'), {
    rows: [
      { id: '1', name: 'Offer', done: true, note: 'Done and signed off 2026-10-27' },
      { id: '2', name: 'Design', done: false, note: 'Reopened 2026-10-28' },
      { id: '3', name: 'Build the site', done: false, note: '' },
      { id: 'G', name: 'Mail and the paper trail', done: true, note: 'Done 2026-10-28' },
      { id: 'N', name: 'Night mode', done: false, note: '' },
      { id: 'B', name: 'Live board', done: false, note: 'Idea' },
    ],
  })
})

test('a section is found by its words, whatever the case, level or trailing colon', () => {
  const doc = '### SESSIONS, IN ORDER:\n\n| # | Name |\n|:-:|---|\n| 1 | One |\n'

  assert.deepEqual(parsePlan(doc, 'sessions, in order').rows, [{ id: '1', name: 'One', done: false, note: '' }])
})

test('with no section named, the first table is the plan', () => {
  assert.deepEqual(parsePlan(DOC, null).rows, [{ id: 'not', name: 'this one', done: false, note: '' }])
})

test('a table with one column has names and no numbers', () => {
  assert.deepEqual(parsePlan('| Step |\n| --- |\n| ~~Plan it~~ |\n| Build it |\n', null).rows, [
    { id: '', name: 'Plan it', done: true, note: '' },
    { id: '', name: 'Build it', done: false, note: '' },
  ])
})

test('a missing section or a section with no table says which', () => {
  assert.deepEqual(parsePlan(DOC, 'Nowhere'), { error: 'there is no section "Nowhere"' })
  assert.deepEqual(parsePlan('## Empty\n\nNothing here.\n\n## Next\n\n| a |\n|---|\n| b |\n', 'Empty'), { error: 'the section "Empty" has no table' })
  assert.deepEqual(parsePlan('No tables at all.\n', null), { error: 'there is no table' })
})

test('readPlan reads the file the config names, with ~ for home', (t) => {
  const home = tempDir(t)
  mkdirSync(join(home, 'docs'))
  writeFileSync(join(home, 'docs', 'plan.md'), DOC)

  const plan = readPlan({ file: '~/docs/plan.md', section: 'Sessions, in order' }, home)

  assert.equal(plan.file, join(home, 'docs', 'plan.md'))
  assert.equal(plan.rows.length, 6)
  assert.equal(plan.done, 2)
})

test('readPlan says why there is no plan rather than failing', (t) => {
  const home = tempDir(t)

  assert.equal(readPlan(null, home), null)
  assert.deepEqual(readPlan({ file: '~/missing.md' }, home), { file: join(home, 'missing.md'), error: 'the file could not be read' })
  writeFileSync(join(home, 'plan.md'), '# Nothing\n')
  assert.deepEqual(readPlan({ file: '~/plan.md', section: 'Next' }, home), { file: join(home, 'plan.md'), error: 'there is no section "Next"' })
})
