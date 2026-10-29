// The git calls night makes. Every function takes a `run` that executes git, so
// tests can use real temporary repos or a stub. Nothing here writes to a branch
// other than the night's own.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Runs git and returns stdout; throws with git's message on failure. */
export function runGit(args, { cwd, timeoutMs = 60_000 } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${(result.stderr || '').trim()}`)
  return result.stdout
}

const tryGit = (run, args, options) => {
  try { return run(args, options) } catch { return null }
}

/** The main checkout of the repo `path` lies in (a worktree counts as its repo), or null. */
export function repoRoot(path, { run = runGit } = {}) {
  let dir = resolve(path)
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir)
  try { if (!statSync(dir).isDirectory()) dir = dirname(dir) } catch { return null }
  const common = tryGit(run, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir })
  if (!common) return null
  const gitDir = common.trim()
  return gitDir.endsWith('/.git') ? dirname(gitDir) : null
}

/** Local branches, most recently committed first. */
export function branchesByDate(repo, { run = runGit } = {}) {
  const out = tryGit(run, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], { cwd: repo })
  return out ? out.split('\n').filter(Boolean) : []
}

/** The branch where work last happened that is not protected; the checked-out branch otherwise. */
export function baseBranch(repo, protectedBranches, { run = runGit } = {}) {
  const shut = new Set(protectedBranches)
  const open = branchesByDate(repo, { run }).find((name) => !shut.has(name))
  if (open) return open
  const head = tryGit(run, ['symbolic-ref', '--short', 'HEAD'], { cwd: repo })
  return head ? head.trim() : 'main'
}

/** The text of `path` at `ref`, or null. */
export function showFile(repo, ref, path, { run = runGit } = {}) {
  return tryGit(run, ['show', `${ref}:${path}`], { cwd: repo })
}

/** Every file path at `ref`. */
export function listFiles(repo, ref, { run = runGit } = {}) {
  const out = tryGit(run, ['ls-tree', '-r', '--name-only', ref], { cwd: repo })
  return out ? out.split('\n').filter(Boolean) : []
}

/** A glob (`*` within a folder, `**` across folders) as a regular expression. */
export function globToRegex(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The files at `ref` matching any of `globs`. */
export function matchFiles(files, globs) {
  const patterns = globs.map(globToRegex)
  return files.filter((file) => patterns.some((re) => re.test(file)))
}

/** The branch checked out at `dir`, or null. */
export function currentBranch(dir, { run = runGit } = {}) {
  const out = tryGit(run, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
  return out ? out.trim() : null
}

export function branchExists(repo, branch, { run = runGit } = {}) {
  return tryGit(run, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }) !== null
}

/**
 * Makes sure `path` is a worktree of `repo` on `branch`, cutting the branch from
 * `base` the first time. Returns the worktree path.
 */
export function ensureWorktree(repo, path, branch, base, { run = runGit } = {}) {
  if (existsSync(path) && currentBranch(path, { run }) === branch) return path
  tryGit(run, ['worktree', 'prune'], { cwd: repo })
  if (branchExists(repo, branch, { run })) run(['worktree', 'add', '--force', path, branch], { cwd: repo })
  else run(['worktree', 'add', '-b', branch, path, base], { cwd: repo })
  return path
}

/** Uncommitted paths in a worktree. */
export function dirtyPaths(dir, { run = runGit } = {}) {
  const out = tryGit(run, ['status', '--porcelain'], { cwd: dir })
  return out ? out.split('\n').filter(Boolean) : []
}

/**
 * Commits on any local branch since `since` (ms): hash, time, author, subject,
 * lines added and removed. Merges are left out; `exclude` leaves out branches
 * matching a glob (the night's own, when counting what the owner's sessions did).
 */
export function commitsSince(repo, since, { until, exclude, run = runGit } = {}) {
  const args = ['log', ...(exclude ? [`--exclude=${exclude}`] : []), '--branches', '--no-merges', `--since=${new Date(since).toISOString()}`]
  if (until) args.push(`--until=${new Date(until).toISOString()}`)
  args.push('--format=%x1e%H%x1f%at%x1f%ae%x1f%s', '--numstat')
  const out = tryGit(run, args, { cwd: repo })
  if (!out) return []
  const commits = []
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue
    const [head, ...stats] = chunk.split('\n')
    const [hash, seconds, email, subject] = head.split('\x1f')
    let added = 0
    let removed = 0
    for (const line of stats) {
      const [a, r, file] = line.split('\t')
      if (!file || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(file)) continue
      added += Number(a) || 0
      removed += Number(r) || 0
    }
    commits.push({ hash, at: Number(seconds) * 1000, email, subject, added, removed })
  }
  return commits
}

/** The branches that contain a commit, short names. */
export function branchesWith(repo, hash, { run = runGit } = {}) {
  const out = tryGit(run, ['branch', '--format=%(refname:short)', '--contains', hash], { cwd: repo })
  return out ? out.split('\n').filter(Boolean) : []
}
