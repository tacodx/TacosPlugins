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

## Steps, in order

Intro text with a | pipe in it.

| # | Step | What it decides or builds | Needs |
| --- | --- | --- | --- |
| ~~1~~ | ~~**Sketch**~~ | **Done and agreed 2026-03-01.** The notes live in \`sketch.md\` | |
| 2 | **Prototype** | **Reopened 2026-03-04.** The rules are in [RULES.md](RULES.md) | nothing |
| 3 | **Build the tool** | The tool itself, in the repo. **Step one is the data** | 1, 2 |
|~~K~~|~~**Keys and the backups**~~|**Done 2026-03-05.** Keys \\| backups|  |
| L | **Launch** | Idea, 2026-03-06: one page and a post | nothing |
| W | Write *docs* | __Idea__, a guide beside the tool | nothing |

## Later

| # | Step |
| --- | --- |
| 9 | **Later** |
`

test('the rows of the named section\'s table: number, name, done, and a short status', () => {
  assert.deepEqual(parsePlan(DOC, 'Steps, in order'), {
    rows: [
      { id: '1', name: 'Sketch', done: true, note: 'Done and agreed 2026-03-01' },
      { id: '2', name: 'Prototype', done: false, note: 'Reopened 2026-03-04' },
      { id: '3', name: 'Build the tool', done: false, note: '' },
      { id: 'K', name: 'Keys and the backups', done: true, note: 'Done 2026-03-05' },
      { id: 'L', name: 'Launch', done: false, note: '' },
      { id: 'W', name: 'Write docs', done: false, note: 'Idea' },
    ],
  })
})

test('a section is found by its words, whatever the case, level or trailing colon', () => {
  const doc = '### STEPS, IN ORDER:\n\n| # | Name |\n|:-:|---|\n| 1 | One |\n'

  assert.deepEqual(parsePlan(doc, 'steps, in order').rows, [{ id: '1', name: 'One', done: false, note: '' }])
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

test('a file that starts with a byte-order mark still has its first heading', () => {
  assert.deepEqual(parsePlan('\uFEFF## Next\n\n| # | Step |\n| --- | --- |\n| 1 | One |\n', 'Next').rows, [{ id: '1', name: 'One', done: false, note: '' }])
})

test('headings and tables inside code fences are code, not the plan', () => {
  const doc = [
    '## Next',
    '',
    '```md',
    '# not a heading',
    '| # | Step |',
    '| --- | --- |',
    '| 0 | Example |',
    '```',
    '',
    '~~~',
    '## also not a heading',
    '~~~',
    '',
    '| # | Step |',
    '| --- | --- |',
    '| 1 | Real |',
  ].join('\n')

  assert.deepEqual(parsePlan(doc, 'Next').rows, [{ id: '1', name: 'Real', done: false, note: '' }])
})

test('a table may leave out the pipes at the ends of its rows', () => {
  const doc = '## Next\n\nNo. | Step | Status\n--- | --- | ---\n~~1~~ | ~~Sketch~~ | **Done**\n2 | Build | **Started**\n\nAfter the table.\n'

  assert.deepEqual(parsePlan(doc, 'Next').rows, [
    { id: '1', name: 'Sketch', done: true, note: 'Done' },
    { id: '2', name: 'Build', done: false, note: 'Started' },
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

  const plan = readPlan({ file: '~/docs/plan.md', section: 'Steps, in order' }, home)

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
