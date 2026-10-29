// Builders for the readers' tests. Every repo, transcript and session file here
// is made up on the spot in a temp directory: the repo is public.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A temp directory that is removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Git as the tests run it: no global or system config of whoever runs them.
export const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export function git(dir, args, env = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...GIT_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The git runner the readers take, isolated the same way. */
export const run = (args, cwd) => git(cwd, args)

/** A new repo whose commits are made as `email` unless a commit says otherwise. */
export function makeRepo(dir, { email = 'me@example.com' } = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  if (email !== null) git(dir, ['config', 'user.email', email])
  git(dir, ['config', 'user.name', 'Someone'])
  return dir
}

/**
 * One commit at `at` (an ISO time, used as author and committer date) of the
 * files given as name -> text. Returns its hash.
 */
export function commit(dir, { at, files = { 'notes.txt': `${at}\n` }, email, message = 'change' }) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  git(dir, ['add', '-A'])
  const env = { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
  if (email !== undefined) Object.assign(env, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email })
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], env)
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** `n` lines of text, for counting lines added. */
export const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n') + '\n'

/** Writes a file, making its folder, and sets its modification time. */
export function writeAt(path, text, ms) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, ms / 1000, ms / 1000)
}

/** One line of a transcript, as Claude Code writes them. */
export const transcriptLine = ({ cwd, entrypoint = 'claude-desktop', session = 's', type = 'assistant' }) =>
  JSON.stringify({ type, sessionId: session, cwd, entrypoint, timestamp: '2026-03-10T12:00:00.000Z' })

/** One session's entry in Claude Code's list of running sessions. */
export function sessionEntry(over = {}) {
  return {
    pid: process.pid,
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    cwd: '/home/u/Projects/alpha',
    startedAt: Date.parse('2026-03-10T09:00:00Z'),
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    name: 'Alpha · Build the thing',
    status: 'busy',
    statusUpdatedAt: Date.parse('2026-03-10T11:48:00Z'),
    updatedAt: Date.parse('2026-03-10T11:48:00Z'),
    ...over,
  }
}
