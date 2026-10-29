// The night's work queue and the task maps that % done is counted on.
//
// queue.json holds every item of the night, each project's task map (frozen at
// its first planning, then ticked as items finish), and when each project was
// last planned. The functions that change a queue are pure: they take a queue and
// return a new one. `withQueue` is the only way the file is changed, always under
// one lock, so a claim and a refill can never lose each other's update.
import { nightFiles } from './config.mjs'
import { readJson, withLock, writeJson, writeText } from './fsx.mjs'

export const MAX_ATTEMPTS = 3

export function emptyQueue(date) {
  return { version: 1, date, items: [], maps: {}, planned: {}, exhausted: {} }
}

/** Reads, changes and saves the queue under its lock; returns what `fn` returned as `result`. */
export async function withQueue(paths, date, fn) {
  const files = nightFiles(paths, date)
  return withLock(files.queueLock, async () => {
    const before = readJson(files.queue, null) ?? emptyQueue(date)
    const { queue, result } = await fn(before)
    if (queue && queue !== before) {
      writeJson(files.queue, queue)
      writeText(files.queueMd, renderQueueMd(queue))
    }
    return result
  }, { timeoutMs: 60_000 })
}

export const readQueue = (paths, date) => readJson(nightFiles(paths, date).queue, null) ?? emptyQueue(date)

const normal = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Adds a planner's answer for one project: its task map (kept as the dusk map the
 * first time, laid over the current one later) and its items, without repeating a
 * title the project already has tonight.
 */
export function addPlan(queue, project, plan, now) {
  const items = [...queue.items]
  const seen = new Set(items.filter((i) => i.project === project.name).map((i) => normal(i.title)))
  let next = items.filter((i) => i.project === project.name).length
  const added = []
  for (const item of plan.items ?? []) {
    if (!item?.title || seen.has(normal(item.title))) continue
    seen.add(normal(item.title))
    next++
    const fresh = {
      id: `${project.name}-${next}`,
      project: project.name,
      repo: project.repo,
      base: project.base,
      rank: project.rank ?? 9,
      order: project.order ?? 0,
      task: item.task ?? null,
      title: String(item.title).slice(0, 160),
      why: String(item.why ?? '').slice(0, 400),
      doneWhen: String(item.doneWhen ?? '').slice(0, 400),
      source: String(item.source ?? '').slice(0, 200),
      status: 'open',
      attempts: 0,
      createdAt: now,
    }
    items.push(fresh)
    added.push(fresh)
  }
  const maps = { ...queue.maps }
  if (plan.map?.tasks?.length) {
    const current = maps[project.name]
    if (!current) {
      maps[project.name] = { basis: plan.map.basis ?? '', at: now, dusk: plan.map.tasks, now: plan.map.tasks }
    } else {
      maps[project.name] = { ...current, now: mergeTasks(current.now, plan.map.tasks) }
    }
  }
  const exhausted = { ...queue.exhausted }
  exhausted[project.name] = added.length === 0 ? (exhausted[project.name] ?? 0) + 1 : 0
  return {
    queue: { ...queue, items, maps, planned: { ...queue.planned, [project.name]: now }, exhausted },
    added,
  }
}

/** Later maps keep every task the dusk map had (by id) and its done flag once set. */
function mergeTasks(current, incoming) {
  const byId = new Map(current.map((t) => [t.id, t]))
  for (const task of incoming) {
    const old = byId.get(task.id)
    byId.set(task.id, old ? { ...old, done: old.done || task.done } : { ...task, added: true })
  }
  return [...byId.values()]
}

/**
 * The next item for a worker: an open item of a project nobody else holds, the
 * worker's own project first (its Claude session knows it), then by rank and order.
 */
export function pickItem(queue, { slot, busy = new Set(), prefer = null }) {
  const open = queue.items.filter((i) => i.status === 'open' && i.attempts < MAX_ATTEMPTS && !busy.has(i.project))
  if (!open.length) return null
  const mine = open.filter((i) => i.project === prefer)
  const pool = mine.length ? mine : open
  return [...pool].sort((a, b) => a.rank - b.rank || a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
}

/** The projects held right now by workers other than `slot`. */
export function heldByOthers(queue, slot) {
  return new Set(queue.items.filter((i) => i.status === 'taken' && i.slot !== slot).map((i) => i.project))
}

/** The item this slot holds, if a crash or restart left one. */
export const heldBy = (queue, slot) => queue.items.find((i) => i.status === 'taken' && i.slot === slot) ?? null

function replace(queue, id, change) {
  return { ...queue, items: queue.items.map((i) => (i.id === id ? { ...i, ...change } : i)) }
}

export function claim(queue, id, { slot, now }) {
  return replace(queue, id, { status: 'taken', slot, takenAt: now })
}

/**
 * Closes or returns an item after a run. `done` ticks its task on the map;
 * `partial` puts it back for the same project; `needs-owner` parks it; anything
 * else counts an attempt, and the third failed attempt parks it as failed.
 */
export function settle(queue, id, { outcome, line = '', sessionId = null, now, countAttempt = true }) {
  const item = queue.items.find((i) => i.id === id)
  if (!item) return queue
  const base = { slot: null, sessionId: sessionId ?? item.sessionId ?? null, endedAt: now, result: line || item.result || '' }
  if (outcome === 'done') {
    let next = replace(queue, id, { ...base, status: 'done' })
    if (item.task && next.maps[item.project]) {
      const map = next.maps[item.project]
      next = { ...next, maps: { ...next.maps, [item.project]: { ...map, now: map.now.map((t) => (t.id === item.task ? { ...t, done: true } : t)) } } }
    }
    return next
  }
  if (outcome === 'needs-owner') return replace(queue, id, { ...base, status: 'parked' })
  if (outcome === 'partial') return replace(queue, id, { ...base, status: 'open', partial: true })
  const attempts = item.attempts + (countAttempt ? 1 : 0)
  return replace(queue, id, { ...base, attempts, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'open' })
}

/** Puts back every item a slot holds, without counting an attempt (Stop, pause). */
export function releaseSlot(queue, slot, now) {
  return {
    ...queue,
    items: queue.items.map((i) => (i.status === 'taken' && i.slot === slot ? { ...i, status: 'open', slot: null, releasedAt: now } : i)),
  }
}

export function counts(queue) {
  const c = { open: 0, taken: 0, done: 0, parked: 0, failed: 0 }
  for (const item of queue.items) c[item.status] = (c[item.status] ?? 0) + 1
  return c
}

/**
 * The project to plan next, or null: when fewer than two open items per session
 * are left, the first project (in the owner's order) with fewer than two open
 * items of its own, not planned in the last 5 minutes, and not twice found empty.
 */
export function nextToPlan(queue, projects, { sessions, now, busy = new Set(), coolMs = 5 * 60_000 }) {
  const open = queue.items.filter((i) => i.status === 'open')
  if (open.length >= 2 * sessions) return null
  for (const project of projects) {
    if (busy.has(project.name)) continue
    if ((queue.exhausted[project.name] ?? 0) >= 2) continue
    if (now - (queue.planned[project.name] ?? 0) < coolMs) continue
    if (open.filter((i) => i.project === project.name).length >= 2) continue
    return project
  }
  return null
}

/** One project's % done at dusk and now, from its task map; tasks added tonight are counted apart. */
export function progressOf(queue, project) {
  const map = queue.maps[project]
  const items = queue.items.filter((i) => i.project === project)
  const itemsDone = items.filter((i) => i.status === 'done').length
  const itemsParked = items.filter((i) => i.status === 'parked').length
  if (!map?.dusk?.length) return { duskPct: null, nowPct: null, won: null, doneTasks: 0, totalTasks: 0, addedTasks: 0, itemsDone, itemsParked, left: [] }
  const ids = new Set(map.dusk.map((t) => t.id))
  const duskDone = map.dusk.filter((t) => t.done).length
  const nowTasks = map.now.filter((t) => ids.has(t.id))
  const nowDone = nowTasks.filter((t) => t.done).length
  const total = map.dusk.length
  const duskPct = Math.round((duskDone / total) * 100)
  const nowPct = Math.round((nowDone / total) * 100)
  return {
    duskPct,
    nowPct,
    won: nowPct - duskPct,
    doneTasks: nowDone,
    totalTasks: total,
    addedTasks: map.now.filter((t) => !ids.has(t.id)).length,
    itemsDone,
    itemsParked,
    left: nowTasks.filter((t) => !t.done).slice(0, 5).map((t) => t.title),
  }
}

const MARK = { open: ' ', taken: '~', done: 'x', parked: '?', failed: '!' }

/** queue.md: the queue as people (and desktop sessions) read it. */
export function renderQueueMd(queue) {
  const lines = [`# Night queue, ${queue.date}`, '', 'Written by night mode; queue.json is the truth. `[~]` taken, `[x]` done, `[?]` needs the owner, `[!]` failed three times.', '']
  const projects = [...new Set(queue.items.map((i) => i.project))]
  for (const project of projects) {
    const p = progressOf(queue, project)
    const pct = p.duskPct === null ? '' : `, ${p.duskPct} % at dusk, ${p.nowPct} % now`
    lines.push(`## ${project}${pct}`, '')
    for (const item of queue.items.filter((i) => i.project === project)) {
      const who = item.status === 'taken' ? ` (worker ${item.slot})` : ''
      lines.push(`- [${MARK[item.status] ?? ' '}] **${item.title}**${who}. ${item.why}`)
      if (item.result) lines.push(`  ${item.result}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
