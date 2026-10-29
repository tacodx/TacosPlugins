// The owner's plans, read as data: project notes with frontmatter, roadmap tables
// and checklists. The parsers are pure; `readNotes` and `findProjects` read the
// disk through arguments they are given.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { baseBranch, listFiles, matchFiles, repoRoot, showFile } from './git.mjs'

/** A Markdown file's leading `---` block as flat key/value pairs, and the rest. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    let value = pair[2].trim()
    if (/^".*"$/.test(value)) {
      try { value = JSON.parse(value) } catch { value = value.slice(1, -1) }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    else value = value.replace(/\s+#.*$/, '')
    data[pair[1]] = value
  }
  return { data, body: text.slice(match[0].length) }
}

/** Every note in a folder: name, status, area, next, where, and its body. */
export function readNotes(dir, { readdir = readdirSync, readFile = readFileSync } = {}) {
  let names = []
  try { names = readdir(dir) } catch { return [] }
  const notes = []
  for (const file of names.sort()) {
    if (!file.endsWith('.md')) continue
    let text
    try { text = readFile(join(dir, file), 'utf8') } catch { continue }
    const { data, body } = parseFrontmatter(text)
    notes.push({
      name: file.slice(0, -3),
      status: data.status ?? '',
      area: data.area ?? '',
      next: data.next ?? '',
      where: data.where ?? '',
      due: data.due ?? '',
      body: body.trim(),
    })
  }
  return notes
}

/** The paths a note's `where` names, home-relative or absolute, wherever they stand in its text. */
export function wherePaths(where, home) {
  return [...String(where).matchAll(/(?:^|[\s(,;])(~\/|\/)([^\s,;()]+)/g)]
    .map((m) => (m[1] === '~/' ? join(home, m[2]) : `/${m[2]}`))
}

const STATUS_RANK = { Doing: 0, Planned: 1, Paused: 2 }

/**
 * Open projects: git repos named by notes in an open status and not in an
 * excluded area. Several notes may share a repo; the project takes the most
 * active status among them.
 */
export function findProjects(notes, { home, openStatuses, excludeAreas, resolveRepo = (p) => repoRoot(p) }) {
  const open = new Set(openStatuses)
  const shut = new Set(excludeAreas)
  const byRepo = new Map()
  for (const note of notes) {
    if (!open.has(note.status) || shut.has(note.area)) continue
    for (const path of wherePaths(note.where, home)) {
      const repo = resolveRepo(path)
      if (!repo) continue
      const project = byRepo.get(repo) ?? { name: basename(repo), repo, notes: [], rank: 9 }
      if (!project.notes.includes(note)) project.notes.push(note)
      project.rank = Math.min(project.rank, STATUS_RANK[note.status] ?? 9)
      byRepo.set(repo, project)
      break
    }
  }
  return [...byRepo.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
}

/** Applies the owner's ticks and order to the open projects. */
export function chooseProjects(projects, { include = [], exclude = [], order = [] }) {
  const shut = new Set(exclude)
  const only = new Set(include)
  const chosen = projects.filter((p) => !shut.has(p.name) && (only.size === 0 || only.has(p.name)))
  const position = (p) => {
    const i = order.indexOf(p.name)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return chosen.sort((a, b) => position(a) - position(b) || a.rank - b.rank || a.name.localeCompare(b.name))
}

const plain = (cell) => cell.replace(/~~/g, '').replace(/\*\*/g, '').trim()

/** Rows of every Markdown table in `text`: key (first cell), name, text, and done when struck. */
export function parseRoadmapRows(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2 || /^:?-{3,}/.test(cells[0]) || cells[0] === '#') continue
    rows.push({
      key: plain(cells[0]),
      name: plain(cells[1]),
      text: plain(cells[2] ?? ''),
      done: /^~~.*~~$/.test(cells[0]) || /\*\*Done\b/.test(cells[2] ?? ''),
    })
  }
  return rows
}

/** The roadmap row a note stands for: "Session 5 Build slait.io" is row 5. */
export function rowForNote(noteName, rows) {
  const match = /^Session\s+(\S+)\s/i.exec(noteName)
  if (!match) return null
  return rows.find((row) => row.key === match[1]) ?? null
}

/** Checklist boxes in Markdown: how many are ticked, and the open ones with their heading. */
export function parseChecklist(text) {
  let heading = ''
  let done = 0
  let total = 0
  const open = []
  for (const line of text.split(/\r?\n/)) {
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (head) {
      heading = head[1].trim()
      continue
    }
    const box = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (!box) continue
    total++
    if (box[1] === ' ') open.push({ text: box[2].trim(), heading })
    else done++
  }
  return { done, total, open }
}

/** done / total as a whole percent, or null when there is nothing to count. */
export const percent = ({ done, total }) => (total > 0 ? Math.round((done / total) * 100) : null)

/**
 * Everything the planner and the recap need to know about one project at a ref:
 * the roadmap rows its notes stand for, the checklists in its plan files, and
 * the % done they add up to.
 */
export function projectPlan(project, { ref, planGlobs, roadmapRows = [], run }) {
  const rows = project.notes.map((note) => rowForNote(note.name, roadmapRows)).filter(Boolean)
  const files = matchFiles(listFiles(project.repo, ref, { run }), planGlobs)
  const checklists = []
  for (const file of files) {
    const text = showFile(project.repo, ref, file, { run })
    if (text === null) continue
    const list = parseChecklist(text)
    if (list.total > 0) checklists.push({ file, ...list })
  }
  const done = rows.filter((r) => r.done).length + checklists.reduce((n, c) => n + c.done, 0)
  const total = rows.length + checklists.reduce((n, c) => n + c.total, 0)
  return { ref, rows, checklists, done, total, pct: percent({ done, total }) }
}

/** The ref night reads a project's plan from: tonight's branch once it exists, else the base branch. */
export function planRef(project, { nightBranch, protectedBranches, run, branchExistsFn }) {
  if (nightBranch && branchExistsFn(project.repo, nightBranch)) return nightBranch
  return baseBranch(project.repo, protectedBranches, { run })
}
