#!/usr/bin/env node
// `node cli.mjs view`: read the repos, the running sessions and the plan, and
// print one View as JSON on stdout. Exit 0 with a View, 2 for a bad command
// line, 1 for anything else, with the reason on stderr.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readCache, writeCache } from './cache.mjs'
import { systemTimeZone } from './clock.mjs'
import { CONFIG_FILE, expandRepos, loadConfig } from './config.mjs'
import { collect, mine } from './git.mjs'
import { readPlan } from './plan.mjs'
import { workingNow } from './sessions.mjs'
import { buildView } from './view.mjs'

const OPTIONS = ['home', 'claude', 'now', 'tz']
const USAGE = 'usage: cli.mjs view [--home dir] [--claude dir] [--now iso-time] [--tz zone]'
// Commits are kept for a day longer than the seven the pane shows, so a day boundary never falls short.
const KEEP_MS = 8 * 24 * 60 * 60 * 1000
// Past this, repos not yet read keep what they had and are read at the next refresh, so a
// hanging repo cannot run the reader into the pane's time limit and lose every repo's news.
const BUDGET_MS = 45_000

class UsageError extends Error {}

function parse(argv) {
  if (argv[0] !== 'view') throw new UsageError(USAGE)
  const options = {}
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if (!OPTIONS.includes(name) || argv[i + 1] === undefined) throw new UsageError(`${USAGE}\nunexpected: ${argv[i]}`)
    options[name] = argv[i + 1]
  }
  return options
}

/** A path as the person would write it, with ~ for their home. */
const tildify = (path, home) => (path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path)

/** "1 repo", "2 repos", and the names. */
const names = (list) => `${list.length} ${list.length === 1 ? 'repo' : 'repos'}: ${list.join(', ')}`

function view(options, env) {
  const home = options.home ?? homedir()
  const claude = options.claude ?? (env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
  const now = options.now === undefined ? Date.now() : Date.parse(options.now)
  if (Number.isNaN(now)) throw new Error(`--now is not a time: ${options.now}`)
  const zone = options.tz ?? systemTimeZone()
  const data = join(claude, 'tacos', 'board')

  const { config } = loadConfig(data, home)
  const configFile = tildify(join(data, CONFIG_FILE), home)
  const repos = expandRepos(config.repos, home)
  const cache = readCache(data)
  const read = collect(repos, { cache: cache.repos, since: now - KEEP_MS, deadline: Date.now() + BUDGET_MS })
  const notes = []
  if (repos.length === 0) notes.push(`No git repo was found in the folders listed under "repos" in ${configFile}.`)
  if (read.unreadable.length > 0) notes.push(`Git could not read ${names(read.unreadable)}.`)
  if (read.late.length > 0) notes.push(`Not read in time, so read at the next refresh: ${names(read.late)}.`)
  if (read.partial.length > 0) notes.push(`Lines added are not counted for partial clones, as the board fetches nothing: ${names(read.partial)}.`)

  const built = buildView({
    commits: mine(repos, read.cache, config.authors),
    now,
    zone,
    sessions: workingNow({ registryDir: join(claude, 'sessions'), projectsDir: join(claude, 'projects'), now, repos }),
    plan: readPlan(config.plan, home),
    colours: cache.colours,
    refreshMinutes: config.refreshMinutes,
    repos: { count: repos.length, unreadable: read.unreadable },
    notes,
    configFile,
  })

  const next = { repos: read.cache, colours: built.colours }
  if (JSON.stringify({ version: cache.version, ...next }) !== cache.text && !writeCache(data, next)) {
    built.view.notes.push('The cache could not be saved, so the next refresh reads every repo again.')
  }
  return built.view
}

/** @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
export async function run(argv, env = process.env) {
  let options
  try {
    options = parse(argv)
  } catch (err) {
    if (err instanceof UsageError) return { code: 2, stdout: '', stderr: `${err.message}\n` }
    throw err
  }
  try {
    return { code: 0, stdout: JSON.stringify(view(options, env)), stderr: '' }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `board: ${err instanceof Error ? err.message : String(err)}\n` }
  }
}

// Compared by real path: a plugin folder is often reached through a symlink,
// and then the path Node was started with is not the path this module has.
function isMain() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false // an unresolvable path means we were imported, not run
  }
}

if (isMain()) {
  const { code, stdout, stderr } = await run(process.argv.slice(2))
  if (stderr !== '') process.stderr.write(stderr)
  if (stdout !== '') process.stdout.write(stdout)
  process.exitCode = code
}
