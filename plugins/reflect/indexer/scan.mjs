// One transcript file, line by line, into a FileSummary. Pure: no file access.
// The record shapes this relies on are the measured ones in section 4.2 of
// docs/superpowers/specs/2026-10-07-reflect-design.md.
import { bump, emptyDay, emptyModel, own } from './agg.mjs'

const ACTIVE_GAP_MS = 5 * 60 * 1000
const NESTED_MARKERS = ['/.claude/worktrees/', '/.superpowers/']

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

// Most lines are tool results, some of them megabytes long. Only three kinds of
// line matter, and each can be recognised without parsing. This is a pre-filter
// only: what a line is gets decided from the parsed record.
function mayMatter(line) {
  return (
    line.includes('"type":"assistant"') ||
    (line.includes('"type":"user"') && line.includes('"kind":"human"')) ||
    line.includes('"type":"custom-title"')
  )
}

export function createScanner({ kind, fileId, home, clock }) {
  const isMain = kind === 'main'
  const summary = { kind, sessionId: fileId, project: null, days: {}, bad: 0 }
  const session = { start: null, end: null, activeMs: 0, prompts: 0, out: 0 }
  const seenMessages = new Set()
  const seenTools = new Set()
  let lastAt = null

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

    // Every line of one reply repeats the same usage: count it on the first only.
    if (typeof message.id !== 'string' || seenMessages.has(message.id)) return
    seenMessages.add(message.id)

    const usage = message.usage ?? {}
    const out = count(usage.output_tokens)
    const inp = count(usage.input_tokens)
    const cacheR = count(usage.cache_read_input_tokens)
    const cacheW = count(usage.cache_creation_input_tokens)

    if (isMain) {
      agg.msgs += 1
      session.out += out
    } else {
      agg.subMsgs += 1
    }
    agg.out += out
    agg.inp += inp
    agg.cacheR += cacheR
    agg.cacheW += cacheW

    const model = own(agg.models, typeof message.model === 'string' ? message.model : '(unknown)', emptyModel)
    model.msgs += 1
    model.out += out
    model.inp += inp
    model.cacheR += cacheR
    model.cacheW += cacheW

    if (typeof record.effort === 'string') bump(agg.efforts, record.effort)
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
      if (record === null || typeof record !== 'object') return
      // A resumed session copies earlier records in under their old session id.
      if (isMain && record.sessionId !== fileId) return

      if (record.type === 'custom-title') {
        if (isMain && typeof record.customTitle === 'string') summary.title = record.customTitle
        return
      }

      const ms = Date.parse(record.timestamp)
      if (Number.isNaN(ms)) return
      if (summary.project === null && typeof record.cwd === 'string') summary.project = projectOf(record.cwd, home)
      if (isMain && summary.entrypoint === undefined && typeof record.entrypoint === 'string') {
        summary.entrypoint = record.entrypoint
      }

      if (record.type === 'user') prompt(record, ms)
      else if (record.type === 'assistant') reply(record, ms)
    },

    finish() {
      if (summary.project === null) summary.project = '(unknown)'
      if (isMain && session.start !== null) summary.session = session
      return summary
    },
  }
}

export function scanLines(lines, options) {
  const scanner = createScanner(options)
  for (const line of lines) scanner.push(line)
  return scanner.finish()
}
