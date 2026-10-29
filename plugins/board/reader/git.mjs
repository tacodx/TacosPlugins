// Commits from `git log --all`, one repo at a time, kept per repo until its refs move.
//
// A repo's refs (every branch, tag and remote, and HEAD) are hashed into a key.
// While the key is the same the commits read last time are still the commits,
// so a refresh costs one `git show-ref` per repo. Commits are kept with their
// author's email, and only the ones made by your own identities are counted.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Bumped when what is kept per commit changes, so older entries are read again. */
export const GIT_VERSION = 1

// Names of files a package manager writes: a lockfile can add thousands of lines
// nobody wrote, so its lines are not counted as lines added.
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum',
  'flake.lock', 'pubspec.lock', 'Podfile.lock', 'mix.lock', 'packages.lock.json',
])

/** Runs git in `cwd` and answers what it printed; throws when it fails. */
export function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Reads only: no lock another session's git could trip over.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
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

/** Every commit on any ref but the stash and notes, committed since `since` (ms). */
export function readLog(repo, since, run = runGit) {
  return parseLog(
    run(
      [
        'log', '--exclude=refs/stash', '--exclude=refs/notes/*', '--all', `--since=${Math.floor(since / 1000)}`,
        '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature',
        '--format=%x1e%H%x1f%at%x1f%ae', '--numstat',
      ],
      repo,
    ),
  )
}

/** A hash of every ref and HEAD; '' for a repo with no commits yet. Throws when git cannot read the repo. */
export function refsKey(repo, run = runGit) {
  let refs
  try {
    refs = run(['show-ref', '--head'], repo)
  } catch (err) {
    // show-ref exits 1, saying nothing, where there is no ref at all.
    if (err.status === 1 && String(err.stdout ?? '') === '') return ''
    throw err
  }
  return createHash('sha1').update(refs).digest('hex')
}

/** The email the repo commits as (its own config, else the global one), or null. */
function identity(repo, run) {
  try {
    const email = run(['config', 'user.email'], repo).trim().toLowerCase()
    return email === '' ? null : email
  } catch {
    return null
  }
}

/**
 * Brings each repo's entry up to date. An entry whose refs have not moved is kept,
 * less any commit older than `since`; the rest are read again.
 * @param {{ path: string, name: string }[]} repos
 * @param {{ cache: Record<string, any>, since: number, run?: Function }} options cache keyed by path
 * @returns {{ cache: Record<string, { v: number, key: string, since: number, email: string | null, commits: object[] }>, unreadable: string[] }}
 */
export function collect(repos, { cache, since, run = runGit }) {
  const next = {}
  const unreadable = []
  for (const { path, name } of repos) {
    let key
    try {
      key = refsKey(path, run)
    } catch {
      unreadable.push(name)
      continue
    }
    const old = cache[path]
    if (old && old.v === GIT_VERSION && old.key === key && old.since <= since && Array.isArray(old.commits)) {
      const kept = old.commits.filter((each) => each.t >= since)
      next[path] = kept.length === old.commits.length ? old : { ...old, since, commits: kept }
      continue
    }
    try {
      next[path] = { v: GIT_VERSION, key, since, email: key === '' ? null : identity(path, run), commits: key === '' ? [] : readLog(path, since, run) }
    } catch {
      unreadable.push(name)
    }
  }
  return { cache: next, unreadable }
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
