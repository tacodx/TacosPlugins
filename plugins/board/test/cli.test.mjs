import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from '../reader/cli.mjs'
import { commit, GIT_ENV, lines, makeRepo, sessionEntry, tempDir } from './helpers.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'reader', 'cli.mjs')
const NOW = '2026-03-10T11:40:00Z'
const PLAN = '# Plan\n\n## Next\n\n| # | Session |\n| --- | --- |\n| ~~1~~ | ~~**One**~~ |\n| 2 | **Two** |\n'

/** A home with two repos, a running session and a plan, all made up. */
function world(t) {
  const home = tempDir(t)
  const claude = join(home, '.claude')
  const alpha = makeRepo(join(home, 'Projects', 'alpha'))
  const beta = makeRepo(join(home, 'Projects', 'beta'))
  commit(alpha, { at: '2026-03-10T09:15:00Z', files: { 'a.txt': lines(12) } })
  commit(beta, { at: '2026-03-08T20:00:00Z', files: { 'b.txt': lines(3) } })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${process.pid}.json`), JSON.stringify(sessionEntry({ name: 'Alpha · Work', cwd: alpha, statusUpdatedAt: Date.parse(NOW) - 600_000 })))
  writeFileSync(join(home, 'plan.md'), PLAN)
  return { home, claude, alpha }
}

function cli(args, env = {}) {
  const ran = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env } })
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

test('view prints the board for a made-up home, and writes its config and cache', (t) => {
  const { home, claude } = world(t)
  const data = join(claude, 'tacos', 'board')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ repos: ['~/Projects/*'], plan: { file: '~/plan.md', section: 'Next' } }))

  const ran = cli(['view', '--home', home, '--claude', claude, '--now', NOW, '--tz', 'Europe/Berlin'])

  assert.equal(ran.stderr, '')
  assert.equal(ran.code, 0)
  const view = JSON.parse(ran.stdout)
  assert.equal(view.version, 1)
  assert.deepEqual(view.totals, { commitsToday: 1, linesToday: 12, commits7d: 2, projectsToday: 1, projects7d: 2 })
  assert.equal(view.hours.at(-2).commits, 0)
  assert.equal(view.hours.find((each) => each.hour === 10 && each.day === '2026-03-10').commits, 1)
  assert.deepEqual(view.sessions, { source: 'registry', working: [{ name: 'Alpha · Work', project: 'alpha', since: Date.parse(NOW) - 600_000 }], idle: 0 })
  assert.deepEqual(view.plan.rows.map((row) => [row.id, row.name, row.done]), [['1', 'One', true], ['2', 'Two', false]])
  assert.deepEqual(view.repos, { count: 2, unreadable: [] })

  const cache = JSON.parse(readFileSync(join(data, 'cache.json'), 'utf8'))
  assert.equal(cache.version, 1)
  assert.equal(Object.keys(cache.repos).length, 2)
  assert.deepEqual(Object.keys(cache.colours).sort(), ['alpha', 'beta'])
})

test('the first run makes the config, and a second run reads the cache to the same view', (t) => {
  const { home, claude } = world(t)

  const first = cli(['view', '--home', home, '--claude', claude, '--now', NOW, '--tz', 'UTC'])
  const second = cli(['view', '--home', home, '--claude', claude, '--now', NOW, '--tz', 'UTC'])

  assert.equal(first.code, 0, first.stderr)
  assert.ok(existsSync(join(claude, 'tacos', 'board', 'config.json')))
  assert.equal(JSON.parse(first.stdout).plan, null)
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout))
})

test('a project folder git cannot read is a note, not a failure', (t) => {
  const { home, claude } = world(t)
  mkdirSync(join(home, 'Projects', 'broken'))
  writeFileSync(join(home, 'Projects', 'broken', '.git'), 'gitdir: /nowhere\n')

  const ran = cli(['view', '--home', home, '--claude', claude, '--now', NOW, '--tz', 'UTC'])

  assert.equal(ran.code, 0, ran.stderr)
  const view = JSON.parse(ran.stdout)
  assert.deepEqual(view.repos.unreadable, ['broken'])
  assert.deepEqual(view.notes, ['1 repo could not be read: broken.'])
})

test('a cache that is not JSON is rebuilt', (t) => {
  const { home, claude } = world(t)
  mkdirSync(join(claude, 'tacos', 'board'), { recursive: true })
  writeFileSync(join(claude, 'tacos', 'board', 'cache.json'), 'garbage')

  const ran = cli(['view', '--home', home, '--claude', claude, '--now', NOW, '--tz', 'UTC'])

  assert.equal(ran.code, 0, ran.stderr)
  assert.equal(JSON.parse(readFileSync(join(claude, 'tacos', 'board', 'cache.json'), 'utf8')).version, 1)
})

test('a broken config stops the run with the reason', async (t) => {
  const { home, claude } = world(t)
  mkdirSync(join(claude, 'tacos', 'board'), { recursive: true })
  writeFileSync(join(claude, 'tacos', 'board', 'config.json'), '{')

  const ran = await run(['view', '--home', home, '--claude', claude, '--now', NOW], {})

  assert.equal(ran.code, 1)
  assert.equal(ran.stdout, '')
  assert.match(ran.stderr, /^board: .*config\.json is not valid JSON/)
})

test('a command line it does not understand is a usage error', async () => {
  for (const argv of [[], ['show'], ['view', '--colour', 'red'], ['view', '--now'], ['view', '--now', 'soon']]) {
    const ran = await run(argv, {})
    assert.ok(ran.code === 2 || (ran.code === 1 && /--now/.test(ran.stderr)), JSON.stringify(argv))
    assert.equal(ran.stdout, '')
  }
})

test('without --claude the folder comes from CLAUDE_CONFIG_DIR', (t) => {
  const { home, claude } = world(t)

  const ran = cli(['view', '--home', home, '--now', NOW, '--tz', 'UTC'], { CLAUDE_CONFIG_DIR: claude })

  assert.equal(ran.code, 0, ran.stderr)
  assert.ok(existsSync(join(claude, 'tacos', 'board', 'config.json')))
})
