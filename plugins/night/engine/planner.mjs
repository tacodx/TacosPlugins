// Plans one project's night: what its plan says, what is done, and up to six
// items a worker can do with nobody awake to ask.
//
// The evidence is gathered without a model (notes, roadmap rows, checklists,
// commits); one headless Claude call with no tools at all judges it and answers in
// a JSON schema. Building the prompt and checking the answer are pure.
import { commitsSince } from './git.mjs'
import { projectPlan } from './sources.mjs'

export const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['map', 'items'],
  properties: {
    map: {
      type: 'object',
      additionalProperties: false,
      required: ['basis', 'tasks'],
      properties: {
        basis: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'done'],
            properties: { id: { type: 'string' }, title: { type: 'string' }, done: { type: 'boolean' } },
          },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'doneWhen', 'task', 'decisionFree'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          doneWhen: { type: 'string' },
          task: { type: ['string', 'null'] },
          decisionFree: { type: 'boolean' },
        },
      },
    },
  },
}

const cut = (text, n) => {
  const s = String(text ?? '')
  return s.length > n ? `${s.slice(0, n)} [...]` : s
}

/** What the planner is shown about one project, as plain text, within a fixed size. */
export function evidence(project, plan, commits, existing) {
  const parts = [`Project: ${project.name}`, `Repository: ${project.repo}`, `Branch the night builds on: ${plan.ref}`, '']
  for (const note of project.notes) {
    parts.push(`Note "${note.name}" (status ${note.status}). Next action: ${note.next || 'none given'}`)
    if (note.body) parts.push(cut(note.body, 1200))
    parts.push('')
  }
  for (const row of plan.rows) parts.push(`Roadmap row ${row.key}, ${row.name}${row.done ? ' (done)' : ''}: ${cut(row.text, 1500)}`, '')
  let boxes = 0
  for (const list of plan.checklists) {
    parts.push(`Checklist ${list.file}: ${list.done} of ${list.total} ticked. Open boxes:`)
    for (const box of list.open) {
      if (boxes++ >= 60) break
      parts.push(`- [ ] ${cut(box.text, 160)}${box.heading ? ` (under "${cut(box.heading, 80)}")` : ''}`)
    }
    parts.push('')
  }
  if (commits.length) {
    parts.push('Recent commits, newest first:')
    for (const c of commits.slice(0, 30)) parts.push(`- ${new Date(c.at).toISOString().slice(0, 10)} ${cut(c.subject, 140)}`)
    parts.push('')
  }
  if (existing.length) {
    parts.push('Items already queued for this project tonight (do not repeat them):')
    for (const item of existing) parts.push(`- [${item.status}] ${item.title}`)
    parts.push('')
  }
  return parts.join('\n')
}

/** The instruction the planner gets with the evidence. */
export function plannerPrompt(text, { wantMap }) {
  return `You plan overnight work on one software project for an unattended Claude Code worker. The project's owner is asleep and answers nothing until morning. The worker works in its own git worktree on a night branch, commits after each unit, and can never push, deploy, send or buy anything.

Below is everything known about the project: its notes, roadmap rows, plan checklists and recent commits.

${wantMap ? `First, map the project's whole current plan as 5 to 40 tasks (map.tasks), each with a short id ("t1", "t2", ...), a title under 80 characters, and done true or false. Judge done from ticked boxes, rows marked done, and commit subjects that show the work landed. map.basis is one sentence on what you counted.` : 'The task map already exists; return map with basis "unchanged" and the same task ids you can infer, or an empty tasks list.'}

Then list up to 6 items for tonight (items), in the order they should be done. Each item:
- title: an imperative under 80 characters.
- why: one sentence naming the plan line, roadmap row or note it serves.
- doneWhen: one checkable sentence.
- task: the id of the map task it advances, or null.
- decisionFree: true only if the worker can finish it with no decision from the owner.

Only include items that need no decision from the owner. Leave out anything that needs their approval or taste (design choices, copy they approve, prices, names), sending or publishing anything, accounts, money, legal questions, contacting people, deploying, or work outside the repository. Prefer the next open steps of the plan; when the plan is done or blocked on the owner, choose work that always helps: tests for untested code, accessibility, empty and error states, documentation of how to run the project, performance, and clean-ups the plan or notes ask for. Never invent new features the notes do not ask for. If nothing qualifies, return an empty items list.

${text}`
}

/** The planner's answer, checked and trimmed; throws when it is not usable. */
export function parsePlannerOutput(value) {
  let data = value
  if (typeof data === 'string') {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(data)
    data = JSON.parse(fenced ? fenced[1] : data)
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('planner answer has no items list')
  const tasks = Array.isArray(data.map?.tasks) ? data.map.tasks : []
  const ids = new Set()
  const cleanTasks = []
  for (const task of tasks.slice(0, 60)) {
    if (!task?.id || !task?.title || ids.has(String(task.id))) continue
    ids.add(String(task.id))
    cleanTasks.push({ id: String(task.id), title: cut(task.title, 120), done: task.done === true })
  }
  const items = data.items
    .filter((item) => item?.title && item.decisionFree === true)
    .slice(0, 6)
    .map((item) => ({
      title: cut(item.title, 160),
      why: cut(item.why, 400),
      doneWhen: cut(item.doneWhen, 400),
      task: item.task && ids.has(String(item.task)) ? String(item.task) : null,
    }))
  return { map: { basis: cut(data.map?.basis ?? '', 300), tasks: cleanTasks }, items }
}

/** argv for the planner's Claude call: no tools, no MCP, no user settings, a JSON schema. */
export function plannerArgs({ prompt, model }) {
  const args = ['-p', prompt, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', 'local',
    '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--json-schema', JSON.stringify(PLANNER_SCHEMA)]
  if (model) args.push('--model', model)
  return args
}

/** The structured answer out of `claude -p --output-format json` stdout. */
export function readClaudeJson(stdout) {
  const outer = JSON.parse(stdout)
  if (outer.is_error) throw new Error(`planner call failed: ${cut(outer.result, 300)}`)
  return { answer: outer.structured_output ?? outer.result, cost: outer.total_cost_usd ?? null }
}

/**
 * Plans one project: gathers the evidence, asks Claude, checks the answer. `call`
 * runs Claude with argv and returns stdout. One retry on a bad answer.
 */
export async function planProject(project, { queue, planGlobs, roadmapRows, model, call, run, now }) {
  const plan = projectPlan(project, { ref: project.base, planGlobs, roadmapRows, run })
  const commits = commitsSince(project.repo, now - 30 * 24 * 3600_000, { run }).sort((a, b) => b.at - a.at)
  const existing = queue.items.filter((i) => i.project === project.name)
  const prompt = plannerPrompt(evidence(project, plan, commits, existing), { wantMap: !queue.maps[project.name] })
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { answer, cost } = readClaudeJson(await call(plannerArgs({ prompt, model })))
      return { ...parsePlannerOutput(answer), cost }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}
