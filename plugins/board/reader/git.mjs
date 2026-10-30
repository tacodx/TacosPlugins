// Commits from `git log --all`, one repo at a time, kept per repo until its refs move.
//
// A repo's refs (every branch, tag and remote, and HEAD) are hashed into a key.
// While the key is the same the commits read last time are still the commits,
// so a refresh costs one `git show-ref` per repo. Commits are kept with their
// author's email, and only the ones made by your own identities are counted.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Bumped when what is kept per repo changes, so older entries are read again. */
export const GIT_VERSION = 2

// Every git call only reads: it takes no lock another session's git could trip
// over, and a partial clone is never made to fetch what it lacks (git 2.44 and
// newer; older ones are kept from it by not being asked for file contents).
const READ_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }

// Names of files a package manager writes: a lockfile can add thousands of lines
// nobody wrote, so its lines are not counted as lines added.
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum',
  'flake.lock', 'pubspec.lock', 'Podfile.lock', 'mix.lock', 'packages.lock.json',
])

/** Runs git in `cwd`, `env` added to the environment, and answers what it printed; throws when it fails or takes over 20 s. */
export function runGit(args, cwd, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
}

/** A numstat path, renamed (`a => b`, `{a => b}/c`) or quoted, is a lockfile by its last name. */
export function isLockfile(path) {
  const plain = path.replace(/^"(.*)"$/, '$1')
  const after = plain.includes(' => ') ? plain.slice(plain.lastIndexOf(' => ') + 4) : plain
  const name = after.replace(/[{}]/g, '').split('/').pop()
  return LOCKFILES.has(name)
}

/**
 * `git log --format=%x1e%H%x1f%at%x1f%ae --numstat` as commits.
 * @returns {{ h: string, t: number, e: string, a: number }[]} t in ms, e lowercased, a lines added outside lockfiles
 */
export function parseLog(text) {
  const commits = []
  for (const chunk of text.split('\x1e')) {
    if (chunk.trim() === '') continue
    const [header, ...rest] = chunk.split('\n')
    const [h, seconds, email = ''] = header.split('\x1f')
    const t = Number(seconds) * 1000
    if (!h || !Number.isFinite(t)) continue
    let a = 0
    for (const line of rest) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (match && match[1] !== '-' && !isLockfile(match[3])) a += Number(match[1])
    }
    commits.push({ h, t, e: email.trim().toLowerCase(), a })
  }
  return commits
}

/**
 * Every commit on any ref but the stash and notes, committed since `since` (ms).
 * With `lines` false no file is looked at, and every commit adds 0 lines.
 */
export function readLog(repo, since, run = runGit, { lines = true } = {}) {
  const args = [
    'log', '--exclude=refs/stash', '--exclude=refs/notes/*', '--all', `--since=${Math.floor(since / 1000)}`,
    '--no-color', '--no-show-signature', '--format=%x1e%H%x1f%at%x1f%ae',
  ]
  if (lines) args.push('--no-ext-diff', '--no-textconv', '--numstat')
  return parseLog(run(args, repo, READ_ENV))
}

/**
 * A hash of every ref, HEAD and the HEAD of every linked worktree (which `log
 * --all` follows and no ref names); '' for a repo with no commits yet. Throws
 * when git cannot read the repo.
 */
export function refsKey(repo, run = runGit) {
  let refs
  try {
    refs = run(['show-ref', '--head'], repo, READ_ENV)
  } catch (err) {
    // show-ref exits 1, saying nothing, where there is no ref at all.
    if (err.status === 1 && String(err.stdout ?? '') === '') return ''
    throw err
  }
  const heads = existsSync(join(repo, '.git', 'worktrees')) ? run(['worktree', 'list', '--porcelain'], repo, READ_ENV) : ''
  return createHash('sha1').update(refs).update('\0').update(heads).digest('hex')
}

/**
 * The email the repo commits as (its own config, else the global one), and
 * whether it is a partial clone: one with a promisor remote, from which git
 * would fetch any file it lacks.
 */
function settings(repo, run) {
  let text = ''
  try {
    text = run(['config', '--get-regexp', '^(user\\.email|extensions\\.partialclone|remote\\..+\\.promisor)$'], repo, READ_ENV)
  } catch {
    // exit 1: none is set
  }
  const emails = [...text.matchAll(/^user\.email (.*)$/gm)].map((match) => match[1].trim().toLowerCase()).filter(Boolean)
  return { email: emails.at(-1) ?? null, isPartial: /^extensions\.partialclone \S/m.test(text) || /^remote\..+\.promisor true$/m.test(text) }
}

const isCommit = (each) =>
  typeof each === 'object' && each !== null && typeof each.h === 'string' && Number.isFinite(each.t) && typeof each.e === 'string' && Number.isFinite(each.a)

/** An entry this version wrote, whole: anything else is read again. */
const isEntry = (entry) =>
  typeof entry === 'object' && entry !== null && entry.v === GIT_VERSION && typeof entry.key === 'string' &&
  Number.isFinite(entry.since) && Array.isArray(entry.commits) && entry.commits.every(isCommit)

/** An entry less any commit older than `since`. */
function trimmed(entry, since) {
  const kept = entry.commits.filter((each) => each.t >= since)
  return kept.length === entry.commits.length ? entry : { ...entry, since: Math.max(entry.since, since), commits: kept }
}

/**
 * Brings each repo's entry up to date. An entry whose refs have not moved is
 * kept, less any commit older than `since`; the rest are read again. A repo git
 * cannot read, and every repo after `deadline` (by `clock`), keeps the entry it
 * had, so a slow or broken repo costs this run its news and not its history.
 * @param {{ path: string, name: string }[]} repos
 * @param {{ cache: Record<string, any>, since: number, run?: Function, deadline?: number, clock?: () => number }} options
 *   cache keyed by path
 * @returns {{ cache: Record<string, { v: number, key: string, since: number, email: string | null, lines: boolean, commits: object[] }>,
 *             unreadable: string[], late: string[], partial: string[] }} `partial`: repos whose lines are not counted
 */
export function collect(repos, { cache, since, run = runGit, deadline = Infinity, clock = Date.now }) {
  const next = {}
  const unreadable = []
  const late = []
  const partial = []
  for (const { path, name } of repos) {
    const old = isEntry(cache[path]) ? cache[path] : undefined
    const keepOld = () => {
      if (old !== undefined) next[path] = trimmed(old, since)
    }
    if (clock() > deadline) {
      late.push(name)
      keepOld()
      continue
    }
    let key
    try {
      key = refsKey(path, run)
    } catch {
      unreadable.push(name)
      keepOld()
      continue
    }
    if (old !== undefined && old.key === key && old.since <= since) {
      next[path] = trimmed(old, since)
      if (old.lines === false) partial.push(name)
      continue
    }
    try {
      const { email, isPartial } = key === '' ? { email: null, isPartial: false } : settings(path, run)
      let lines = !isPartial
      let commits = []
      if (key !== '') {
        try {
          commits = readLog(path, since, run, { lines })
        } catch (err) {
          // A file git cannot read without fetching it, or cannot read at all: count the commits alone.
          if (!lines) throw err
          lines = false
          commits = readLog(path, since, run, { lines })
        }
      }
      next[path] = { v: GIT_VERSION, key, since, email, lines, commits }
      if (!lines) partial.push(name)
    } catch {
      unreadable.push(name)
      keepOld()
    }
  }
  return { cache: next, unreadable, late, partial }
}

/**
 * Your commits from every repo, each once (the first repo that has it names its
 * project). Yours means made by an email one of these repos commits as, or by
 * one of `authors` when that list is not empty. With no identity known at all,
 * every commit counts.
 * @returns {{ h: string, t: number, a: number, project: string }[]}
 */
export function mine(repos, cache, authors) {
  const wanted = new Set(
    authors.length > 0
      ? authors.map((each) => each.trim().toLowerCase())
      : repos.map(({ path }) => cache[path]?.email).filter((email) => typeof email === 'string'),
  )
  const seen = new Set()
  const commits = []
  for (const { path, name } of repos) {
    for (const each of cache[path]?.commits ?? []) {
      if (seen.has(each.h) || (wanted.size > 0 && !wanted.has(each.e))) continue
      seen.add(each.h)
      commits.push({ h: each.h, t: each.t, a: each.a, project: name })
    }
  }
  return commits
}
