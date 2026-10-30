// Every live Claude Code session on this machine, and what state each is in.
//
// Claude Code writes one file per live session to ~/.claude/sessions/<pid>.json
// and appends every turn to ~/.claude/projects/<slug>/<sessionId>.jsonl. Night
// only reads both. The classifiers are pure; the readers take their effects as
// arguments.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The transcript folder name Claude Code uses for a working directory. */
export const projectSlug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. */
export function procStartOf(pid, readFile = readFileSync) {
  try {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8')
    // The command name (field 2) is in parentheses and may contain spaces.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return rest[19]
  } catch {
    return null
  }
}

/** The live session files, each marked alive when its pid still runs the same process. */
export function readRegistry(dir, { readdir = readdirSync, readFile = readFileSync, procStart = procStartOf } = {}) {
  let names = []
  try { names = readdir(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let entry
    try { entry = JSON.parse(readFile(join(dir, name), 'utf8')) } catch { continue }
    if (!entry?.sessionId || !entry?.pid) continue
    const start = procStart(entry.pid)
    out.push({
      pid: entry.pid,
      sessionId: entry.sessionId,
      cwd: entry.cwd ?? '',
      name: entry.name ?? '',
      status: entry.status ?? 'unknown',
      waitingFor: entry.waitingFor ?? null,
      statusUpdatedAt: entry.statusUpdatedAt ?? entry.updatedAt ?? null,
      entrypoint: entry.entrypoint ?? '',
      hostSessionId: entry.hostSessionId ?? null,
      alive: start !== null && (entry.procStart === undefined || String(entry.procStart) === start),
    })
  }
  return out
}

/** The last `bytes` of a file as parsed JSON lines; the first, partial line is dropped. */
export function tailJsonl(path, bytes = 256 * 1024) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const out = []
    for (const line of lines) {
      if (!line) continue
      try { out.push(JSON.parse(line)) } catch { /* cut line */ }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Where a session's transcript is, and when it was last written; null when not found. */
export function findTranscript(transcriptsDir, cwd, sessionId, { stat = statSync } = {}) {
  const path = join(transcriptsDir, projectSlug(cwd), `${sessionId}.jsonl`)
  try {
    return { path, mtimeMs: stat(path).mtimeMs }
  } catch {
    return null
  }
}

const recordAt = (record) => {
  const t = Date.parse(record?.timestamp ?? '')
  return Number.isFinite(t) ? t : null
}

/** Whether a transcript record is the synthetic reply Claude Code writes when a usage limit stops a turn. */
export function limitOf(record) {
  if (record?.type !== 'assistant') return null
  const info = record.apiErrorParams?.rate_limit_info
  if (record.error !== 'rate_limit' && record.apiError !== 'usage_limit_reached' && !info) return null
  const resetsAt = Number(info?.resetsAt)
  return { resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null, type: info?.rateLimitType ?? null }
}

/**
 * What the end of a transcript says: `ended` (the turn finished), `limit` (a usage
 * limit stopped it, with `resetsAt` in ms when known), `tool` (a tool call has no
 * result yet: running, or waiting on approval), `working` (anything else).
 */
export function transcriptState(records) {
  const meaningful = records.filter((r) => ['assistant', 'user', 'system'].includes(r?.type))
  const last = meaningful.at(-1)
  const lastAt = meaningful.reduce((most, r) => Math.max(most, recordAt(r) ?? 0), 0) || null
  if (!last) return { state: 'empty', lastAt }
  for (let i = meaningful.length - 1; i >= 0 && i >= meaningful.length - 4; i--) {
    const limit = limitOf(meaningful[i])
    if (limit) return { state: 'limit', lastAt, resetsAt: limit.resetsAt, limitType: limit.type }
    if (meaningful[i].type === 'user' && meaningful[i].message?.role === 'user' && !isToolResult(meaningful[i])) break
  }
  if (last.type === 'system' && last.subtype === 'stop_hook_summary') return { state: 'ended', lastAt }
  if (last.type === 'assistant') {
    const reason = last.message?.stop_reason
    if (reason === 'end_turn' || reason === 'stop_sequence') return { state: 'ended', lastAt }
    if (reason === 'tool_use') return { state: 'tool', lastAt }
  }
  return { state: 'working', lastAt }
}

function isToolResult(record) {
  const content = record?.message?.content
  return Array.isArray(content) && content.some((block) => block?.type === 'tool_result')
}

/**
 * One label for a live session, from its registry entry and the end of its
 * transcript: working, idle, limited, waiting, hung or dead. `hasChildren` says
 * whether the session's process has children (a background task or tool running).
 */
export function classify(entry, transcript, { now, hungMs = 20 * 60_000, hasChildren = false } = {}) {
  if (!entry.alive) return { label: 'dead' }
  if (entry.status === 'waiting') return { label: 'waiting', on: entry.waitingFor ?? 'a dialog' }
  const t = transcript ?? { state: 'empty', lastAt: null }
  if (t.state === 'limit' && (t.resetsAt === null || t.resetsAt > now - 5 * 60_000)) {
    return { label: 'limited', resetsAt: t.resetsAt }
  }
  if (entry.status === 'idle' || t.state === 'ended') return { label: 'idle', since: t.lastAt }
  const silentFor = t.lastAt === null ? 0 : now - t.lastAt
  if (silentFor > hungMs && !hasChildren) return { label: 'hung', silentFor }
  return { label: 'working', lastAt: t.lastAt }
}

/** Whether a pid has child processes (a tool or background task still running). */
export function hasChildren(pid, readFile = readFileSync) {
  try {
    return readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0
  } catch {
    return false
  }
}
