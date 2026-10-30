import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { nightFiles, nightPaths } from '../engine/config.mjs'
import {
  addPlan, claim, counts, emptyQueue, heldBy, heldByOthers, nextToPlan, pickItem, progressOf, readQueue,
  releaseSlot, renderQueueMd, settle, withQueue,
} from '../engine/queue.mjs'
import { tempDir } from './helpers.mjs'

const NOW = Date.parse('2026-03-10T22:30:00Z')
const alpha = { name: 'alpha', repo: '/r/alpha', base: 'feature', rank: 0, order: 0 }
const beta = { name: 'beta', repo: '/r/beta', base: 'main', rank: 1, order: 1 }

const PLAN = {
  map: { basis: 'the plan file', tasks: [{ id: 't1', title: 'Pages', done: true }, { id: 't2', title: 'Tests', done: false }, { id: 't3', title: 'SEO', done: false }, { id: 't4', title: 'Docs', done: false }] },
  items: [
    { task: 't2', title: 'Write the page tests', why: 'Plan step 2', doneWhen: 'tests pass' },
    { task: 't3', title: 'Add the sitemap', why: 'Plan step 3', doneWhen: 'sitemap.xml exists' },
  ],
}

function planned() {
  let q = emptyQueue('2026-03-10')
  q = addPlan(q, alpha, PLAN, NOW).queue
  q = addPlan(q, beta, { items: [{ title: 'Fix the empty state', why: 'Note says so' }] }, NOW).queue
  return q
}

test('a plan adds its items and freezes the first task map as the dusk map', () => {
  const q = planned()
  assert.deepEqual(q.items.map((i) => i.id), ['alpha-1', 'alpha-2', 'beta-1'])
  assert.equal(q.maps.alpha.dusk.length, 4)
  assert.equal(q.planned.alpha, NOW)
})

test('a later plan repeats no title and keeps the dusk map frozen', () => {
  let q = planned()
  const again = addPlan(q, alpha, {
    map: { tasks: [...PLAN.map.tasks, { id: 't5', title: 'New idea', done: false }] },
    items: [{ title: 'write the page TESTS', why: 'dupe' }, { title: 'Write the docs', why: 'Plan step 4', task: 't4' }],
  }, NOW + 1)
  q = again.queue
  assert.deepEqual(again.added.map((i) => i.title), ['Write the docs'])
  assert.equal(q.maps.alpha.dusk.length, 4)
  assert.equal(q.maps.alpha.now.length, 5)
  assert.equal(progressOf(q, 'alpha').addedTasks, 1)
})

test('a worker takes its own project first, then by rank', () => {
  const q = planned()
  assert.equal(pickItem(q, { slot: 1 }).id, 'alpha-1')
  assert.equal(pickItem(q, { slot: 1, prefer: 'beta' }).id, 'beta-1')
})

test('a project held by another worker or a desktop session is skipped', () => {
  let q = planned()
  q = claim(q, 'alpha-1', { slot: 1, now: NOW })
  assert.deepEqual([...heldByOthers(q, 2)], ['alpha'])
  assert.equal(pickItem(q, { slot: 2, busy: heldByOthers(q, 2) }).id, 'beta-1')
  assert.equal(pickItem(q, { slot: 2, busy: new Set(['alpha', 'beta']) }), null)
  assert.equal(heldBy(q, 1).id, 'alpha-1')
})

test('a finished item ticks its task, and % won is the move on the frozen dusk map', () => {
  let q = planned()
  q = claim(q, 'alpha-1', { slot: 1, now: NOW })
  q = settle(q, 'alpha-1', { outcome: 'done', line: 'Tests written', now: NOW + 60_000 })
  const p = progressOf(q, 'alpha')
  assert.equal(p.duskPct, 25)
  assert.equal(p.nowPct, 50)
  assert.equal(p.won, 25)
  assert.deepEqual(p.left, ['SEO', 'Docs'])
  assert.equal(p.itemsDone, 1)
})

test('partial goes back open, needs-owner is parked, three failures end in failed', () => {
  let q = planned()
  q = settle(q, 'alpha-1', { outcome: 'partial', now: NOW })
  assert.equal(q.items[0].status, 'open')
  assert.equal(q.items[0].attempts, 0)
  q = settle(q, 'alpha-2', { outcome: 'needs-owner', line: 'Which domain?', now: NOW })
  assert.equal(q.items[1].status, 'parked')
  for (let i = 0; i < 3; i++) q = settle(q, 'beta-1', { outcome: 'crash', now: NOW })
  assert.equal(q.items[2].status, 'failed')
  assert.deepEqual(counts(q), { open: 1, taken: 0, done: 0, parked: 1, failed: 1 })
})

test('releasing a slot puts its items back without counting an attempt', () => {
  let q = claim(planned(), 'beta-1', { slot: 3, now: NOW })
  q = releaseSlot(q, 3, NOW)
  assert.equal(q.items[2].status, 'open')
  assert.equal(q.items[2].attempts, 0)
})

test('planning starts when fewer than two open items per session are left, in the owner\'s order', () => {
  const q = planned()
  assert.equal(nextToPlan(q, [alpha, beta], { sessions: 1, now: NOW + 3600_000 }), null)
  assert.equal(nextToPlan(q, [alpha], { sessions: 4, now: NOW + 3600_000 }), null) // alpha has two open
  const gamma = { name: 'gamma', repo: '/r/g', rank: 2 }
  assert.equal(nextToPlan(q, [alpha, beta, gamma], { sessions: 4, now: NOW + 3600_000 }).name, 'beta')
  assert.equal(nextToPlan(q, [alpha, beta, gamma], { sessions: 4, now: NOW + 60_000 }).name, 'gamma')
})

test('a project found empty twice is not planned again tonight', () => {
  let q = emptyQueue('2026-03-10')
  q = addPlan(q, alpha, { items: [] }, NOW).queue
  q = addPlan(q, alpha, { items: [] }, NOW).queue
  assert.equal(nextToPlan(q, [alpha], { sessions: 2, now: NOW + 3600_000 }), null)
})

test('queue.md shows every item with its mark and the project\'s progress', () => {
  let q = planned()
  q = settle(q, 'alpha-1', { outcome: 'done', line: 'Tests written', now: NOW })
  const md = renderQueueMd(q)
  assert.match(md, /## alpha, 25 % at dusk, 50 % now/)
  assert.match(md, /- \[x\] \*\*Write the page tests\*\*/)
  assert.match(md, /- \[ \] \*\*Fix the empty state\*\*/)
})

test('two workers claiming at once never get the same item', async (t) => {
  const paths = nightPaths({ env: { HOME: tempDir(t) } })
  const date = '2026-03-10'
  await withQueue(paths, date, (q) => ({ queue: addPlan(addPlan(q, alpha, PLAN, NOW).queue, beta, { items: [{ title: 'b1' }, { title: 'b2' }] }, NOW).queue }))
  const take = (slot) => withQueue(paths, date, (q) => {
    const item = pickItem(q, { slot, busy: heldByOthers(q, slot) })
    return item ? { queue: claim(q, item.id, { slot, now: NOW }), result: item.id } : { queue: q, result: null }
  })
  const got = await Promise.all([take(1), take(2), take(3)])
  const ids = got.filter(Boolean)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 2) // one item per project: alpha and beta
  assert.equal(readQueue(paths, date).items.filter((i) => i.status === 'taken').length, 2)
  assert.match(readFileSync(nightFiles(paths, date).queueMd, 'utf8'), /worker/)
})
