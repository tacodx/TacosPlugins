import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  chooseProjects, findProjects, parseChecklist, parseFrontmatter, parseRoadmapRows, percent, projectPlan,
  readNotes, rowForNote, wherePaths,
} from '../engine/sources.mjs'
import { baseBranch, commitsSince, ensureWorktree, globToRegex, matchFiles, repoRoot } from '../engine/git.mjs'
import { tempDir } from './helpers.mjs'

const NOTE = (status, area, where, extra = '') =>
  `---\nstatus: ${status}\narea: ${area}\nnext: "Do the thing"\nwhere: "${where}"\nupdated: 2026-03-10\n---\n\nBody line.${extra}\n`

test('frontmatter reads quoted, bare and commented values', () => {
  const { data, body } = parseFrontmatter('---\na: "x: y"\nb: plain # note\nc: \'it\'\'s\'\n---\nrest\n')
  assert.deepEqual(data, { a: 'x: y', b: 'plain', c: "it's" })
  assert.equal(body, 'rest\n')
  assert.deepEqual(parseFrontmatter('no block').data, {})
})

test('a where field names home paths before any comment', () => {
  assert.deepEqual(wherePaths('~/Projects/a (new plugin), row B in ~/Projects/b/docs/X.md', '/home/u'), [
    '/home/u/Projects/a', '/home/u/Projects/b/docs/X.md',
  ])
  assert.deepEqual(wherePaths('nowhere in particular', '/home/u'), [])
})

test('open notes become projects, one per repo, ranked by their most active note', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'Alpha site.md'), NOTE('Paused', 'Code', '~/Projects/alpha'))
  writeFileSync(join(dir, 'Alpha docs.md'), NOTE('Doing', 'Code', '~/Projects/alpha/docs/PLAN.md'))
  writeFileSync(join(dir, 'Client job.md'), NOTE('Doing', 'Client', '~/Projects/clients/acme'))
  writeFileSync(join(dir, 'Old thing.md'), NOTE('Archived', 'Code', '~/Projects/old'))
  writeFileSync(join(dir, 'Paper.md'), NOTE('Planned', 'Admin', ''))
  writeFileSync(join(dir, 'Beta.md'), NOTE('Planned', 'Code', '~/Projects/beta'))
  const repos = { '/home/u/Projects/alpha': '/r/alpha', '/home/u/Projects/alpha/docs/PLAN.md': '/r/alpha', '/home/u/Projects/beta': '/r/beta' }
  const projects = findProjects(readNotes(dir), {
    home: '/home/u', openStatuses: ['Doing', 'Planned', 'Paused'], excludeAreas: ['Client'], resolveRepo: (p) => repos[p] ?? null,
  })
  assert.deepEqual(projects.map((p) => [p.name, p.rank, p.notes.length]), [['alpha', 0, 2], ['beta', 1, 1]])
})

test('the owner\'s ticks and order decide which projects run, and in what order', () => {
  const projects = [{ name: 'a', rank: 0 }, { name: 'b', rank: 1 }, { name: 'c', rank: 2 }, { name: 'clients', rank: 0 }]
  assert.deepEqual(chooseProjects(projects, { exclude: ['clients'] }).map((p) => p.name), ['a', 'b', 'c'])
  assert.deepEqual(chooseProjects(projects, { include: ['c', 'a'] }).map((p) => p.name), ['a', 'c'])
  assert.deepEqual(chooseProjects(projects, { exclude: ['clients'], order: ['c'] }).map((p) => p.name), ['c', 'a', 'b'])
})

const ROADMAP = `# Roadmap

| # | Session | What | Needs |
| --- | --- | --- | --- |
| ~~1~~ | ~~**Offer**~~ | **Done and signed off.** | |
| 5 | **Build the site** | Pages in the repo | 1 |
| N | **Night mode** | One command | nothing |
`

test('roadmap rows are read from every table, struck rows are done', () => {
  const rows = parseRoadmapRows(ROADMAP)
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.done]), [['1', 'Offer', true], ['5', 'Build the site', false], ['N', 'Night mode', false]])
})

test('a note named Session X stands for roadmap row X', () => {
  const rows = parseRoadmapRows(ROADMAP)
  assert.equal(rowForNote('Session N Night mode', rows).name, 'Night mode')
  assert.equal(rowForNote('Session 9 Missing', rows), null)
  assert.equal(rowForNote('Plain project', rows), null)
})

test('a checklist counts ticked boxes and keeps the open ones with their heading', () => {
  const list = parseChecklist('# Plan\n## Task 1\n- [x] write the test\n- [ ] make it pass\n* [X] other\n  - [ ] nested\n')
  assert.equal(list.done, 2)
  assert.equal(list.total, 4)
  assert.deepEqual(list.open, [{ text: 'make it pass', heading: 'Task 1' }, { text: 'nested', heading: 'Task 1' }])
  assert.equal(percent(list), 50)
  assert.equal(percent({ done: 0, total: 0 }), null)
})

test('globs match within a folder with * and across folders with **', () => {
  assert.ok(globToRegex('docs/plans/*.md').test('docs/plans/a.md'))
  assert.ok(!globToRegex('docs/plans/*.md').test('docs/plans/x/a.md'))
  assert.ok(globToRegex('**/*-build.md').test('a/b/site-build.md'))
  assert.ok(globToRegex('**/*-build.md').test('site-build.md'))
  assert.deepEqual(matchFiles(['TODO.md', 'src/TODO.md', 'PLAN.md'], ['TODO.md', 'PLAN.md']), ['TODO.md', 'PLAN.md'])
})

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
})

function makeRepo(t) {
  const dir = join(tempDir(t), 'repo')
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'docs', 'plans', 'one.md'), '- [x] a\n- [ ] b\n- [ ] c\n')
  writeFileSync(join(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  git(dir, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'docs', 'plans', 'one.md'), '- [x] a\n- [x] b\n- [ ] c\n')
  git(dir, 'commit', '-q', '-am', 'tick b')
  git(dir, 'checkout', '-q', 'main')
  return dir
}

test('the base branch is where work last happened, never a protected one', (t) => {
  const repo = makeRepo(t)
  assert.equal(baseBranch(repo, ['main']), 'feature')
  assert.equal(repoRoot(join(repo, 'docs', 'plans', 'one.md')), repo)
})

test('a plan is read from a branch without checking it out', (t) => {
  const repo = makeRepo(t)
  const project = { name: 'repo', repo, notes: [{ name: 'Session 5 Build the site' }] }
  const plan = projectPlan(project, { ref: 'feature', planGlobs: ['docs/plans/*.md'], roadmapRows: parseRoadmapRows(ROADMAP) })
  assert.equal(plan.done, 2)
  assert.equal(plan.total, 4)
  assert.equal(plan.checklists[0].open[0].text, 'c')
})

test('a night worktree is cut from the base once and reused after', (t) => {
  const repo = makeRepo(t)
  const path = join(repo, '..', 'night-wt')
  ensureWorktree(repo, path, 'night/2026-03-10/repo', 'feature')
  ensureWorktree(repo, path, 'night/2026-03-10/repo', 'feature')
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'night/2026-03-10/repo')
  assert.match(git(path, 'log', '-1', '--format=%s'), /tick b/)
})

test('commits since an instant are counted on every branch, lock files left out', (t) => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'package-lock.json'), 'x\n'.repeat(500))
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'add a')
  const commits = commitsSince(repo, Date.now() - 3600_000)
  assert.equal(commits.length, 3)
  const added = commits.find((c) => c.subject === 'add a')
  assert.equal(added.added, 2)
})

test('commits on the night\'s own branches can be left out', (t) => {
  const repo = makeRepo(t)
  git(repo, 'checkout', '-q', '-b', 'night/2026-03-10/repo')
  writeFileSync(join(repo, 'n.txt'), 'n\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'night work')
  const all = commitsSince(repo, Date.now() - 3600_000).map((c) => c.subject)
  const theirs = commitsSince(repo, Date.now() - 3600_000, { exclude: 'night/*' }).map((c) => c.subject)
  assert.ok(all.includes('night work'))
  assert.ok(!theirs.includes('night work'))
  assert.ok(theirs.includes('tick b'))
})
