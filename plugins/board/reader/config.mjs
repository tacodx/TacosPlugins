// The board's settings: which repos to count, where the plan is, how often to refresh.
//
// They live in config.json in the board's folder. The first run writes one with
// defaults found on this machine, so nobody's own paths are in this code: every
// git repo directly under ~/Projects, and every repo one level inside a folder
// there that holds repos. After that the file is the person's and is only read.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

export const CONFIG_FILE = 'config.json'
const DEFAULT_REFRESH = 3

export class ConfigError extends Error {}

/** `~` and `~/…` against `home`; anything else as given. */
export const expandHome = (path, home) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path)

export const isRepo = (dir) => existsSync(join(dir, '.git'))

// A relative path would be read from whichever folder a session happens to run in.
const isPinned = (path) => path === '~' || path.startsWith('~/') || isAbsolute(path)

/** The folders directly in `dir`, by name, leaving out hidden ones. Empty when `dir` cannot be listed. */
function folders(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .sort()
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
}

export function defaultConfig(home) {
  const root = join(home, 'Projects')
  const nested = folders(root).filter((name) => folders(join(root, name)).some((inner) => isRepo(join(root, name, inner))))
  return {
    repos: ['~/Projects/*', ...nested.map((name) => `~/Projects/${name}/*`)],
    plan: null,
    refreshMinutes: DEFAULT_REFRESH,
    authors: [],
  }
}

function check(raw, file) {
  const fail = (why) => {
    throw new ConfigError(`${file}: ${why}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('it must be an object')
  const { repos, plan = null, refreshMinutes = DEFAULT_REFRESH, authors = [] } = raw
  if (!Array.isArray(repos) || !repos.every((each) => typeof each === 'string' && isPinned(each))) {
    fail('"repos" must be a list of folders from ~ or /, such as ["~/Projects/*"]')
  }
  if (plan !== null) {
    if (typeof plan !== 'object' || Array.isArray(plan)) fail('"plan" must be null or { "file": …, "section": … }')
    if (typeof plan.file !== 'string' || !isPinned(plan.file)) fail('"plan.file" must name a Markdown file from ~ or /')
    if (plan.section !== undefined && plan.section !== null && typeof plan.section !== 'string') fail('"plan.section" must be a heading\'s words')
  }
  if (typeof refreshMinutes !== 'number' || !Number.isFinite(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 60) {
    fail('"refreshMinutes" must be a number from 1 to 60')
  }
  if (!Array.isArray(authors) || !authors.every((each) => typeof each === 'string')) fail('"authors" must be a list of email addresses')
  return {
    repos,
    plan: plan === null ? null : { file: plan.file, ...(typeof plan.section === 'string' ? { section: plan.section } : {}) },
    refreshMinutes,
    authors,
  }
}

/**
 * The settings in `dataDir`, writing the defaults first when there are none.
 * @returns {{ config: { repos: string[], plan: null | { file: string, section?: string }, refreshMinutes: number, authors: string[] }, created: boolean }}
 */
export function loadConfig(dataDir, home) {
  const file = join(dataDir, CONFIG_FILE)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw new ConfigError(`${file} could not be read (${err.code})`)
    const config = defaultConfig(home)
    mkdirSync(dataDir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`)
    try {
      // A link is made whole or not at all, and never over a file another run wrote meanwhile.
      linkSync(temp, file)
    } catch (linked) {
      if (linked.code !== 'EEXIST') throw new ConfigError(`${file} could not be written (${linked.code})`)
      return loadConfig(dataDir, home)
    } finally {
      rmSync(temp, { force: true })
    }
    return { config, created: true }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`)
  }
  return { config: check(raw, file), created: false }
}

/**
 * The repos the patterns name, in their order, each once. A pattern is a repo's
 * folder, or a folder followed by `/*` for every repo directly inside it.
 * @returns {{ path: string, name: string, real: string }[]} `real` the path with every link resolved
 */
export function expandRepos(patterns, home) {
  const seen = new Set()
  const repos = []
  const add = (path) => {
    if (!isRepo(path)) return
    let real
    try {
      real = realpathSync(path)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    repos.push({ path, name: basename(path), real })
  }
  for (const pattern of patterns) {
    if (pattern.endsWith('/*') || pattern.endsWith('\\*')) {
      const dir = expandHome(pattern.slice(0, -2), home)
      for (const name of folders(dir)) add(join(dir, name))
    } else {
      add(expandHome(pattern, home).replace(/[\\/]+$/, ''))
    }
  }
  return repos
}
