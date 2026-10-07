#!/usr/bin/env node
// `node cli.mjs view --range <id>`: bring the store up to date, then print one
// View as JSON on stdout. Exit 0 with a View, 2 for a bad command line, 1 for
// anything else, with the reason on stderr.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClock, systemTimeZone } from './clock.mjs'
import { readHistory } from './history.mjs'
import { readWork } from './mem.mjs'
import { buildView, RANGES } from './query.mjs'
import { acquireLock, mergedDays, readStore, saveStore } from './store.mjs'
import { updateStore } from './update.mjs'

const OPTIONS = ['range', 'projects', 'data', 'history', 'mem', 'now', 'tz', 'home']
const USAGE =
  `usage: cli.mjs view [--range ${Object.keys(RANGES).join('|')}] [--projects dir] [--data dir] ` +
  '[--history file] [--mem file] [--now iso-time] [--tz zone] [--home dir]'

export const NOTE_BUSY = 'Another session is updating the history, so this view may be a moment behind.'
export const NOTE_LOST =
  'The saved history could not be read and was rebuilt from the transcripts still on disk. Older history is lost.'
export const NOTE_BUSY_LOST =
  'The saved history could not be read, and another session is rebuilding it. Try again in a moment.'

class UsageError extends Error {}

function parse(argv) {
  if (argv[0] !== 'view') throw new UsageError(USAGE)
  const options = {}
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if (!OPTIONS.includes(name) || argv[i + 1] === undefined) throw new UsageError(`${USAGE}\nunexpected: ${argv[i]}`)
    options[name] = argv[i + 1]
  }
  const range = options.range ?? '30d'
  if (!Object.hasOwn(RANGES, range)) throw new UsageError(`${USAGE}\nunknown range: ${range}`)
  return { ...options, range }
}

async function view(options, env) {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const projects = options.projects ?? join(config, 'projects')
  const data = options.data ?? join(config, 'tacos', 'reflect')
  const historyFile = options.history ?? join(config, 'history.jsonl')
  const memFile = options.mem ?? join(env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem'), 'claude-mem.db')
  const home = options.home ?? homedir()
  const now = options.now === undefined ? Date.now() : Date.parse(options.now)
  if (Number.isNaN(now)) throw new Error(`--now is not a time: ${options.now}`)
  const zone = options.tz ?? systemTimeZone()
  const clock = createClock(zone)
  const notes = []

  // Null when another process is indexing: then this one neither indexes nor saves.
  const release = acquireLock(data)
  let store
  try {
    const read = readStore(data)
    // Not ours to replace: an older copy of this code must leave a newer store alone.
    if (read.lost === 'newer') throw new Error('the saved history is from a newer version of reflect; update the plugin')
    store = read.store
    if (release === null) {
      notes.push(read.lost === null ? NOTE_BUSY : NOTE_BUSY_LOST)
    } else {
      const updated = await updateStore(store, projects, { home, clock, zone })
      // An unusable store is set aside by the save itself, once the rebuilt one is
      // safely written: a run that fails before then leaves the file where it is,
      // and the next run says so again.
      saveStore(data, store, read.lost === null ? {} : { setAside: now })
      if (read.lost !== null) notes.push(NOTE_LOST)
      if (updated.duplicates === 1) {
        notes.push('1 transcript exists in more than one project folder; its larger copy is the one counted.')
      } else if (updated.duplicates > 1) {
        notes.push(`${updated.duplicates} transcripts exist in more than one project folder; the larger copy of each is the one counted.`)
      }
    }
  } finally {
    if (release !== null) release()
  }

  const bad = Object.values(store.files).reduce((sum, file) => sum + file.summary.bad, 0)
  if (bad === 1) notes.push('1 transcript line could not be read and was skipped.')
  else if (bad > 1) notes.push(`${bad} transcript lines could not be read and were skipped.`)

  return buildView({
    days: mergedDays(store),
    sessions: store.sessions,
    history: existsSync(historyFile) ? readHistory(readFileSync(historyFile, 'utf8'), clock) : {},
    work: existsSync(memFile) ? readWork(memFile, clock) : null,
    rangeId: options.range,
    today: clock(now).day,
    clock,
    generatedAt: new Date(now).toISOString(),
    notes,
  })
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
    return { code: 0, stdout: JSON.stringify(await view(options, env)), stderr: '' }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `reflect: ${err instanceof Error ? err.message : String(err)}\n` }
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
