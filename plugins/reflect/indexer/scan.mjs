// One transcript file, line by line, into a FileSummary. Pure: no file access.
// The record shapes this relies on are the measured ones in section 4.2 of
// docs/superpowers/specs/2026-10-07-reflect-design.md.
import { bump, emptyDay, emptyModel, own } from './agg.mjs'
import { isPlausible } from './clock.mjs'

/**
 * Raise this whenever a change here would give a different summary for the same
 * file. The store remembers which version made its summaries and rescans every
 * transcript still on disk when it differs.
 */
export const SCAN_VERSION = 1

const ACTIVE_GAP_MS = 5 * 60 * 1000
const NESTED_MARKERS = ['/.claude/worktrees/', '/.superpowers/']
// The usage fields of a reply, and the aggregate field each one adds to.
const USAGE = [
  ['output_tokens', 'out'],
  ['input_tokens', 'inp'],
  ['cache_read_input_tokens', 'cacheR'],
  ['cache_creation_input_tokens', 'cacheW'],
]

const count = (value) => (Number.isFinite(value) ? value : 0)

/** A project's name from a working directory: relative to home, a worktree counted as its parent. */
export function projectOf(cwd, home) {
  if (typeof cwd !== 'string' || cwd === '') return '(unknown)'
  let path = cwd
  for (const marker of NESTED_MARKERS) {
    const at = path.indexOf(marker)
    if (at !== -1) path = path.slice(0, at)
  }
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) path = path.slice(home.length + 1)
  if (path.startsWith('Projects/')) path = path.slice('Projects/'.length)
  return path
}

// Most lines are tool results, some of them megabytes long. Only a few kinds of
// line matter, and each can be recognised without parsing. This is a pre-filter
// only: what a line is gets decided from the parsed record.
function mayMatter(line) {
  return (
    line.includes('"type":"assistant"') ||
    (line.includes('"type":"user"') && line.includes('"kind":"human"')) ||
    line.includes('"type":"custom-title"') ||
    line.includes('"type":"ai-title"')
  )
}

export function createScanner({ kind, fileId, home, clock }) {
  const isMain = kind === 'main'
  const summary = { kind, sessionId: fileId, project: null, days: {}, bad: 0 }
  const session = { start: null, end: null, activeMs: 0, prompts: 0, out: 0 }
  const replies = new Map() // message.id -> where the reply was counted, and how much of it so far
  const seenTools = new Set()
  let lastAt = null
  let ownTitle = null // the title the person gave
  let autoTitle = null // the one Claude Code made up

  // Main files only: the session's span, and time counted as active.
  function touch(ms, agg) {
    if (session.start === null || ms < session.start) session.start = ms
    if (session.end === null || ms > session.end) session.end = ms
    if (lastAt !== null) {
      const gap = ms - lastAt
      if (gap > 0 && gap < ACTIVE_GAP_MS) {
        session.activeMs += gap
        agg.activeMs += gap
      }
    }
    lastAt = ms
  }

  function prompt(record, ms) {
    if (!isMain || record.origin?.kind !== 'human' || record.isMeta === true) return
    const { day, hour } = clock(ms)
    const agg = own(summary.days, day, emptyDay)
    touch(ms, agg)
    agg.prompts += 1
    agg.hours[hour] += 1
    session.prompts += 1
  }

  function reply(record, ms) {
    const message = record.message
    if (message === null || typeof message !== 'object' || message.model === '<synthetic>') return
    const agg = own(summary.days, clock(ms).day, emptyDay)
    if (isMain) touch(ms, agg)

    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || seenTools.has(block.id)) continue
      seenTools.add(block.id)
      const name = String(block.name)
      bump(agg.tools, name)
      if (name === 'Skill' && typeof block.input?.skill === 'string') bump(agg.skills, block.input.skill)
      if (name.startsWith('mcp__')) bump(agg.mcp, name.split('__')[1] ?? '')
    }

    if (typeof message.id !== 'string') return
    let counted = replies.get(message.id)
    if (counted === undefined) {
      // The first line of a reply: this is where, and on which day, it counts.
      const model = own(agg.models, typeof message.model === 'string' ? message.model : '(unknown)', emptyModel)
      counted = { agg, model, seen: USAGE.map(() => 0) }
      replies.set(message.id, counted)
      if (isMain) agg.msgs += 1
      else agg.subMsgs += 1
      model.msgs += 1
      if (typeof record.effort === 'string') bump(agg.efforts, record.effort)
    }

    // A reply is written once per content block. In a subagent file the early
    // lines carry the usage as it stood mid-stream, and only the last has the
    // final figures, so each field counts as the largest value any line shows.
    const usage = message.usage ?? {}
    USAGE.forEach(([field, total], i) => {
      const more = count(usage[field]) - counted.seen[i]
      if (more <= 0) return
      counted.seen[i] += more
      counted.agg[total] += more
      counted.model[total] += more
      if (isMain && total === 'out') session.out += more
    })
  }

  return {
    push(line) {
      if (!mayMatter(line)) return
      let record
      try {
        record = JSON.parse(line)
      } catch {
        summary.bad += 1
        return
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        summary.bad += 1
        return
      }
      // A resumed session copies earlier records in under their old session id.
      if (isMain && record.sessionId !== fileId) return

      if (record.type === 'custom-title' || record.type === 'ai-title') {
        if (!isMain) return
        if (typeof record.customTitle === 'string') ownTitle = record.customTitle
        if (typeof record.aiTitle === 'string') autoTitle = record.aiTitle
        return
      }
      if (record.type !== 'user' && record.type !== 'assistant') return

      const ms = Date.parse(record.timestamp)
      if (!isPlausible(ms)) {
        summary.bad += 1
        return
      }
      if (summary.project === null && typeof record.cwd === 'string') summary.project = projectOf(record.cwd, home)
      if (isMain && summary.entrypoint === undefined && typeof record.entrypoint === 'string') {
        summary.entrypoint = record.entrypoint
      }

      if (record.type === 'user') prompt(record, ms)
      else reply(record, ms)
    },

    finish() {
      if (summary.project === null) summary.project = '(unknown)'
      if (isMain && session.start !== null) summary.session = session
      const title = ownTitle ?? autoTitle
      if (title !== null) summary.title = title
      return summary
    },
  }
}

export function scanLines(lines, options) {
  const scanner = createScanner(options)
  for (const line of lines) scanner.push(line)
  return scanner.finish()
}
