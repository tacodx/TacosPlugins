// The sessions working right now.
//
// A mod's API has no list of other sessions. Claude Code keeps one, though: a
// small JSON file per running session in ~/.claude/sessions, with its name, the
// folder it runs in and whether it is busy or idle. It is what the ListAgents
// tool reads, and it is read here the same way, never its key files. Its shape
// is Claude Code's own and may change, so when it cannot be read, or holds
// nothing usable, the answer falls back to the transcripts in ~/.claude/projects
// written to in the last ten minutes, each named by its project.
//
// Sessions that programs start through the SDK (such as claude-mem's
// observers) are left out of both: they are not someone's sessions at work.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const TAIL_BYTES = 64 * 1024
export const RECENT_MS = 10 * 60 * 1000

const isSdk = (entrypoint) => typeof entrypoint === 'string' && entrypoint.startsWith('sdk')

/**
 * Whether `pid` is a running process. With `procStart` (the start time Claude
 * Code wrote, in clock ticks since boot) a pid that has since been reused by
 * another process is not taken for the session, where /proc can say so.
 */
export function isRunning(pid, procStart) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code !== 'EPERM') return false
  }
  if (typeof procStart !== 'string' || !/^\d+$/.test(procStart)) return true
  let stat
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return true
  }
  // The second field is the command in parentheses and may hold spaces: count from after it.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === procStart
}

const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value > Date.UTC(2020, 0, 1)

/**
 * The running sessions in Claude Code's list, or null when there is no list or nothing in it can be used.
 * @returns {null | { busy: { name: string, cwd: string | null, since: number | null }[], idle: number }}
 */
export function readRegistry(dir, { isAlive = isRunning } = {}) {
  let names
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return null
  }
  let usable = 0
  const busy = []
  let idle = 0
  for (const name of names) {
    let entry
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.status !== 'string' || typeof entry.sessionId !== 'string') continue
    usable += 1
    if (isSdk(entry.entrypoint) || !isAlive(entry.pid, entry.procStart)) continue
    if (entry.status !== 'busy') {
      idle += 1
      continue
    }
    busy.push({
      name: typeof entry.name === 'string' ? entry.name : '',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      since: isTime(entry.statusUpdatedAt) ? entry.statusUpdatedAt : null,
    })
  }
  if (usable === 0) return null
  // Longest at work first, which keeps the rows in place from one refresh to the next.
  busy.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.name.localeCompare(b.name))
  return { busy, idle }
}

/** The last `TAIL_BYTES` of a file as lines, the first (cut) one dropped when the file is longer. */
function tailLines(path) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    return size > length ? lines.slice(1) : lines
  } finally {
    closeSync(fd)
  }
}

/** The folder a transcript's session ran in, and how it was started, from its newest line that says. */
function whereFrom(path) {
  let lines
  try {
    lines = tailLines(path)
  } catch {
    return { cwd: null, entrypoint: null }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"cwd"')) continue
    try {
      const line = JSON.parse(lines[i])
      if (typeof line?.cwd === 'string') return { cwd: line.cwd, entrypoint: typeof line.entrypoint === 'string' ? line.entrypoint : null }
    } catch {
      // a line cut short or not JSON: look further back
    }
  }
  return { cwd: null, entrypoint: null }
}

/** Every .jsonl file under `dir`, at any depth, with its modification time. */
function transcriptsUnder(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...transcriptsUnder(path))
    else if (entry.name.endsWith('.jsonl')) {
      try {
        found.push({ path, at: statSync(path).mtimeMs })
      } catch {
        // gone between the listing and the look
      }
    }
  }
  return found
}

/**
 * Sessions whose transcript, or a subagent's under it, was written to in the last `windowMs`.
 * @returns {{ cwd: string | null, at: number }[]} newest first
 */
export function readTranscripts(projectsDir, { now, windowMs = RECENT_MS }) {
  let projects
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  const found = []
  for (const project of projects) {
    const dir = join(projectsDir, project.name)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    // A session is its transcript, <id>.jsonl, and the folder <id>/ its subagents write into.
    const sessions = new Map()
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -'.jsonl'.length)
        let at
        try {
          at = statSync(path).mtimeMs
        } catch {
          continue
        }
        const known = sessions.get(id) ?? { main: null, at: 0, other: null }
        sessions.set(id, { ...known, main: path, at: Math.max(known.at, at) })
      } else if (entry.isDirectory()) {
        const inner = transcriptsUnder(path)
        if (inner.length === 0) continue
        const newest = inner.reduce((best, each) => (each.at > best.at ? each : best))
        const known = sessions.get(entry.name) ?? { main: null, at: 0, other: null }
        sessions.set(entry.name, { ...known, at: Math.max(known.at, newest.at), other: newest.path })
      }
    }
    for (const { main, at, other } of sessions.values()) {
      if (at < now - windowMs) continue
      const from = whereFrom(main ?? other)
      if (from.cwd === null && main !== null && other !== null) Object.assign(from, whereFrom(other))
      if (isSdk(from.entrypoint)) continue
      found.push({ cwd: from.cwd, at })
    }
  }
  return found.sort((a, b) => b.at - a.at)
}

/** Names a folder by the repo it lies in (the deepest one, worktrees included), else by its own name. */
export function projectNamer(repos) {
  const roots = repos.map(({ path, name }) => ({ path: path.replace(/\/+$/, ''), name })).sort((a, b) => b.path.length - a.path.length)
  return (cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return 'unknown'
    const folder = cwd.replace(/\/+$/, '')
    const root = roots.find(({ path }) => folder === path || folder.startsWith(`${path}/`))
    return root ? root.name : basename(folder) || 'unknown'
  }
}

/**
 * @returns {{ source: 'registry' | 'transcripts', working: { name: string, project: string, since: number | null }[], idle: number | null }}
 *   `since`: when the session turned busy (registry) or last wrote (transcripts)
 */
export function workingNow({ registryDir, projectsDir, now, repos, isAlive = isRunning }) {
  const nameOf = projectNamer(repos)
  const listed = readRegistry(registryDir, { isAlive })
  if (listed !== null) {
    return {
      source: 'registry',
      working: listed.busy.map(({ name, cwd, since }) => ({ name: name || nameOf(cwd), project: nameOf(cwd), since })),
      idle: listed.idle,
    }
  }
  return {
    source: 'transcripts',
    working: readTranscripts(projectsDir, { now }).map(({ cwd, at }) => ({ name: nameOf(cwd), project: nameOf(cwd), since: at })),
    idle: null,
  }
}
