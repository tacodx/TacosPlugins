import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { collect, GIT_VERSION, isLockfile, mine, parseLog, readLog } from '../reader/git.mjs'
import { commit, git, lines, makeRepo, run, tempDir } from './helpers.mjs'

const ms = (iso) => Date.parse(iso)
const SINCE = ms('2026-03-02T00:00:00Z')

test('a log is read into commits: hash, author time, email and lines added', () => {
  const text = [
    '\x1eaaa\x1f1773100000\x1fMe@Example.com',
    '',
    '10\t2\tsrc/a.js',
    '-\t-\timage.png',
    '500\t0\tpackage-lock.json',
    '3\t1\tsrc/{old => new}/b.js',
    '7\t0\t{x => y}/yarn.lock',
    '\x1ebbb\x1f1773100100\x1fother@example.com',
    '\x1eccc\x1f1773100200\x1fme@example.com',
    '',
    '4\t0\t"dir/\\303\\274ber.txt"',
  ].join('\n')

  assert.deepEqual(parseLog(text), [
    { h: 'aaa', t: 1773100000000, e: 'me@example.com', a: 13 },
    { h: 'bbb', t: 1773100100000, e: 'other@example.com', a: 0 },
    { h: 'ccc', t: 1773100200000, e: 'me@example.com', a: 4 },
  ])
})

test('lockfiles are known by name, wherever they sit', () => {
  for (const path of ['package-lock.json', 'web/pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'go.sum', 'a/{b => c}/bun.lock', '"x/composer.lock"']) {
    assert.equal(isLockfile(path), true, path)
  }
  for (const path of ['src/lock.js', 'package.json', 'docs/yarn.lock.md']) {
    assert.equal(isLockfile(path), false, path)
  }
})

test('a real repo: every branch, no stash, nothing before the cut-off', (t) => {
  const repo = makeRepo(join(tempDir(t), 'alpha'))
  commit(repo, { at: '2026-02-20T10:00:00Z', files: { 'old.txt': lines(9) } })
  const first = commit(repo, { at: '2026-03-09T08:00:00Z', files: { 'a.txt': lines(5), 'package-lock.json': lines(400) } })
  git(repo, ['checkout', '-q', '-b', 'side'])
  const side = commit(repo, { at: '2026-03-09T09:30:00Z', files: { 'b.txt': lines(2) }, email: 'Someone.Else@example.com' })
  git(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'a.txt'), lines(50))
  git(repo, ['stash', '-q'], { GIT_AUTHOR_DATE: '2026-03-09T10:00:00Z', GIT_COMMITTER_DATE: '2026-03-09T10:00:00Z' })

  const commits = readLog(repo, SINCE, run)

  assert.deepEqual(
    commits.sort((a, b) => a.t - b.t),
    [
      { h: first, t: ms('2026-03-09T08:00:00Z'), e: 'me@example.com', a: 5 },
      { h: side, t: ms('2026-03-09T09:30:00Z'), e: 'someone.else@example.com', a: 2 },
    ],
  )
})

test('a merge counts as a commit that adds no lines of its own', (t) => {
  const repo = makeRepo(join(tempDir(t), 'alpha'))
  commit(repo, { at: '2026-03-09T08:00:00Z', files: { 'a.txt': lines(1) } })
  git(repo, ['checkout', '-q', '-b', 'side'])
  commit(repo, { at: '2026-03-09T09:00:00Z', files: { 'b.txt': lines(3) } })
  git(repo, ['checkout', '-q', 'main'])
  commit(repo, { at: '2026-03-09T09:10:00Z', files: { 'c.txt': lines(4) } })
  git(repo, ['merge', '-q', '--no-ff', '--no-edit', 'side'], { GIT_AUTHOR_DATE: '2026-03-09T09:20:00Z', GIT_COMMITTER_DATE: '2026-03-09T09:20:00Z' })

  const commits = readLog(repo, SINCE, run).sort((a, b) => a.t - b.t)

  assert.deepEqual(commits.map((each) => each.a), [1, 3, 4, 0])
})

/** A runner that counts what it is asked to run. */
function counting() {
  const calls = []
  return {
    calls,
    run: (args, cwd, env) => {
      calls.push(args[0])
      return run(args, cwd, env)
    },
  }
}

test('a repo whose refs did not move is not read again', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  const beta = makeRepo(join(root, 'beta'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  commit(beta, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }, { path: beta, name: 'beta' }]

  const first = counting()
  const one = collect(repos, { cache: {}, since: SINCE, run: first.run })
  assert.deepEqual(first.calls.filter((name) => name === 'log').length, 2)

  const second = counting()
  const two = collect(repos, { cache: one.cache, since: SINCE + 3_600_000, run: second.run })
  assert.deepEqual(second.calls, ['show-ref', 'show-ref'])
  assert.deepEqual(two.cache, one.cache)

  commit(beta, { at: '2026-03-09T09:00:00Z' })
  const third = counting()
  const three = collect(repos, { cache: two.cache, since: SINCE + 7_200_000, run: third.run })
  assert.deepEqual(third.calls, ['show-ref', 'show-ref', 'config', 'log'])
  assert.equal(three.cache[beta].commits.length, 2)
})

test('a new branch in a worktree counts as a move, though HEAD stayed put', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }]
  const one = collect(repos, { cache: {}, since: SINCE, run })

  git(alpha, ['worktree', 'add', '-q', '-b', 'ct/elsewhere', join(root, 'wt')])
  commit(join(root, 'wt'), { at: '2026-03-09T10:00:00Z' })
  const two = collect(repos, { cache: one.cache, since: SINCE, run })

  assert.equal(two.cache[alpha].commits.length, 2)
})

test('commits older than the cut-off leave the cache', (t) => {
  const alpha = makeRepo(join(tempDir(t), 'alpha'))
  commit(alpha, { at: '2026-03-02T08:00:00Z' })
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }]
  const one = collect(repos, { cache: {}, since: SINCE, run })
  assert.equal(one.cache[alpha].commits.length, 2)

  const two = collect(repos, { cache: one.cache, since: ms('2026-03-05T00:00:00Z'), run })

  assert.equal(two.cache[alpha].commits.length, 1)
})

test('a repo git cannot read is named, and the others are still read', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  const broken = join(root, 'broken')
  mkdirSync(broken)
  writeFileSync(join(broken, '.git'), 'gitdir: /nowhere/at/all\n')
  const empty = makeRepo(join(root, 'empty'))

  const result = collect(
    [{ path: broken, name: 'broken' }, { path: alpha, name: 'alpha' }, { path: empty, name: 'empty' }],
    { cache: {}, since: SINCE, run },
  )

  assert.deepEqual(result.unreadable, ['broken'])
  assert.equal(result.cache[alpha].commits.length, 1)
  assert.deepEqual(result.cache[empty].commits, [])
})

test('mine: your commits once each, from every repo, by the identities your repos use', () => {
  const cache = {
    '/p/alpha': { email: 'me@example.com', commits: [{ h: 'a1', t: 1, e: 'me@example.com', a: 5 }, { h: 'x1', t: 2, e: 'stranger@example.com', a: 9 }] },
    '/p/alpha-copy': { email: 'me@example.com', commits: [{ h: 'a1', t: 1, e: 'me@example.com', a: 5 }] },
    '/p/beta': { email: 'work@example.com', commits: [{ h: 'b1', t: 3, e: 'work@example.com', a: 1 }, { h: 'b2', t: 4, e: 'me@example.com', a: 2 }] },
    '/p/gamma': { email: null, commits: [{ h: 'g1', t: 5, e: 'stranger@example.com', a: 0 }] },
  }
  const repos = [
    { path: '/p/alpha', name: 'alpha' },
    { path: '/p/alpha-copy', name: 'alpha' },
    { path: '/p/beta', name: 'beta' },
    { path: '/p/gamma', name: 'gamma' },
  ]

  assert.deepEqual(mine(repos, cache, []), [
    { h: 'a1', t: 1, a: 5, project: 'alpha' },
    { h: 'b1', t: 3, a: 1, project: 'beta' },
    { h: 'b2', t: 4, a: 2, project: 'beta' },
  ])
  assert.deepEqual(
    mine(repos, cache, ['Stranger@example.com']).map((each) => each.h),
    ['x1', 'g1'],
  )
})

test('with no identity anywhere, every commit counts', () => {
  const cache = { '/p/alpha': { email: null, commits: [{ h: 'a1', t: 1, e: 'anyone@example.com', a: 5 }] } }

  assert.deepEqual(mine([{ path: '/p/alpha', name: 'alpha' }], cache, []), [{ h: 'a1', t: 1, a: 5, project: 'alpha' }])
})

test('a commit on a detached worktree moves the key, though no ref did', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  git(alpha, ['worktree', 'add', '-q', '--detach', join(root, 'wt')])
  const repos = [{ path: alpha, name: 'alpha' }]
  const one = collect(repos, { cache: {}, since: SINCE, run })

  commit(join(root, 'wt'), { at: '2026-03-09T10:00:00Z' })
  const two = collect(repos, { cache: one.cache, since: SINCE, run })

  assert.equal(two.cache[alpha].commits.length, 2)
})

test('a partial clone is never made to fetch: its commits count, its lines are left out', (t) => {
  const root = tempDir(t)
  const origin = makeRepo(join(root, 'origin'))
  commit(origin, { at: '2026-03-09T08:00:00Z', files: { 'a.txt': lines(5) } })
  commit(origin, { at: '2026-03-09T09:00:00Z', files: { 'a.txt': lines(9) } })
  git(origin, ['config', 'uploadpack.allowFilter', 'true'])
  git(root, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, 'partial'])
  const partial = join(root, 'partial')
  git(partial, ['config', 'user.email', 'me@example.com'])
  const before = git(partial, ['count-objects', '-v'])

  const read = collect([{ path: partial, name: 'partial' }], { cache: {}, since: SINCE, run })

  assert.deepEqual(read.cache[partial].commits.map((each) => each.a), [0, 0])
  assert.equal(read.cache[partial].lines, false)
  assert.deepEqual(read.partial, ['partial'])
  assert.equal(git(partial, ['count-objects', '-v']), before)
})

test('a cache entry this version did not write, or that is broken, is read again', (t) => {
  const alpha = makeRepo(join(tempDir(t), 'alpha'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }]
  const key = collect(repos, { cache: {}, since: SINCE, run }).cache[alpha].key

  for (const broken of [{ v: GIT_VERSION, key, since: SINCE, email: null, lines: true, commits: [null] }, { v: GIT_VERSION, key, since: SINCE, email: null, lines: true, commits: 'no' }, null, 'text']) {
    const read = collect(repos, { cache: { [alpha]: broken }, since: SINCE, run })
    assert.equal(read.cache[alpha].commits.length, 1, JSON.stringify(broken))
  }
})

test('a repo that cannot be read keeps the commits read before, and is named', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  commit(alpha, { at: '2026-03-02T08:00:00Z' })
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }]
  const one = collect(repos, { cache: {}, since: SINCE, run })

  const failing = (args, cwd, env) => (args[0] === 'show-ref' ? (() => { throw new Error('timed out') })() : run(args, cwd, env))
  const two = collect(repos, { cache: one.cache, since: ms('2026-03-05T00:00:00Z'), run: failing })

  assert.deepEqual(two.unreadable, ['alpha'])
  assert.equal(two.cache[alpha].commits.length, 1)
})

test('past its deadline a run reads no more repos: they keep what they had and wait for the next', (t) => {
  const root = tempDir(t)
  const alpha = makeRepo(join(root, 'alpha'))
  const beta = makeRepo(join(root, 'beta'))
  commit(alpha, { at: '2026-03-09T08:00:00Z' })
  commit(beta, { at: '2026-03-09T08:00:00Z' })
  const repos = [{ path: alpha, name: 'alpha' }, { path: beta, name: 'beta' }]
  const one = collect(repos, { cache: {}, since: SINCE, run })
  commit(alpha, { at: '2026-03-09T09:00:00Z' })
  commit(beta, { at: '2026-03-09T09:00:00Z' })
  let now = 0
  const clock = () => (now += 10)

  const two = collect(repos, { cache: one.cache, since: SINCE, run, deadline: 15, clock })

  assert.deepEqual(two.late, ['beta'])
  assert.equal(two.cache[alpha].commits.length, 2)
  assert.equal(two.cache[beta].commits.length, 1)
})
