import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigError, expandRepos, loadConfig } from '../reader/config.mjs'
import { makeRepo, tempDir } from './helpers.mjs'

/** A home folder with projects laid out the way the default has to find them. */
function home(t) {
  const dir = tempDir(t)
  const projects = join(dir, 'Projects')
  makeRepo(join(projects, 'alpha'))
  makeRepo(join(projects, 'beta'))
  mkdirSync(join(projects, 'notes')) // a folder, no repo in it
  makeRepo(join(projects, 'group', 'one')) // a folder of repos
  makeRepo(join(projects, 'group', 'two'))
  makeRepo(join(projects, 'hub')) // a repo that holds repos of its own
  makeRepo(join(projects, 'hub', 'inner'))
  mkdirSync(join(projects, 'hub', 'docs'))
  makeRepo(join(projects, '.hidden'))
  return dir
}

test('the first run writes a config: every repo under ~/Projects, and every folder there that holds repos', (t) => {
  const dir = home(t)
  const data = join(dir, '.claude', 'tacos', 'board')

  const { config, created } = loadConfig(data, dir)

  assert.equal(created, true)
  assert.deepEqual(config, {
    repos: ['~/Projects/*', '~/Projects/group/*', '~/Projects/hub/*'],
    plan: null,
    refreshMinutes: 3,
    authors: [],
  })
  const written = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.deepEqual(written.repos, config.repos)
  assert.equal(written.plan, null)
})

test('a home with no Projects folder still gets a config', (t) => {
  const dir = tempDir(t)

  const { config } = loadConfig(join(dir, 'data'), dir)

  assert.deepEqual(config.repos, ['~/Projects/*'])
})

test('a config that exists is read, never rewritten', (t) => {
  const dir = tempDir(t)
  const data = join(dir, 'data')
  mkdirSync(data)
  const text = '{\n  "repos": ["~/code/*"],\n  "plan": { "file": "~/plan.md", "section": "Next" },\n  "refreshMinutes": 5\n}\n'
  writeFileSync(join(data, 'config.json'), text)

  const { config, created } = loadConfig(data, dir)

  assert.equal(created, false)
  assert.deepEqual(config, { repos: ['~/code/*'], plan: { file: '~/plan.md', section: 'Next' }, refreshMinutes: 5, authors: [] })
  assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), text)
})

test('a config that is not JSON is an error that names the file', (t) => {
  const dir = tempDir(t)
  const data = join(dir, 'data')
  mkdirSync(data)
  writeFileSync(join(data, 'config.json'), '{ "repos": [ }')

  assert.throws(() => loadConfig(data, dir), (err) => err instanceof ConfigError && err.message.includes(join(data, 'config.json')) && /not valid JSON/.test(err.message))
})

test('each setting that has the wrong shape is named', (t) => {
  const dir = tempDir(t)
  const data = join(dir, 'data')
  mkdirSync(data)
  const bad = [
    [{ repos: '~/Projects/*' }, /repos/],
    [{ repos: ['~/a', 3] }, /repos/],
    [{ repos: [], plan: 'roadmap.md' }, /plan/],
    [{ repos: [], plan: { section: 'x' } }, /plan\.file/],
    [{ repos: [], refreshMinutes: 0 }, /refreshMinutes/],
    [{ repos: [], refreshMinutes: 'often' }, /refreshMinutes/],
    [{ repos: [], authors: 'me@example.com' }, /authors/],
    // A relative path would be read from whichever folder a session runs in.
    [{ repos: ['Projects/*'] }, /repos/],
    [{ repos: [], plan: { file: 'docs/PLAN.md' } }, /plan\.file/],
    [[], /an object/],
  ]
  for (const [value, message] of bad) {
    writeFileSync(join(data, 'config.json'), JSON.stringify(value))
    assert.throws(() => loadConfig(data, dir), (err) => err instanceof ConfigError && message.test(err.message), JSON.stringify(value))
  }
})

test('missing settings take their defaults', (t) => {
  const dir = tempDir(t)
  const data = join(dir, 'data')
  mkdirSync(data)
  writeFileSync(join(data, 'config.json'), '{ "repos": ["~/x"] }')

  assert.deepEqual(loadConfig(data, dir).config, { repos: ['~/x'], plan: null, refreshMinutes: 3, authors: [] })
})

test('patterns expand to the repos they name, in order, each once', (t) => {
  const dir = home(t)
  symlinkSync(join(dir, 'Projects', 'alpha'), join(dir, 'Projects', 'group', 'alpha-link'))

  const repos = expandRepos(['~/Projects/group/*', '~/Projects/*', join(dir, 'Projects', 'hub', 'inner'), '~/Projects/missing/*', '~/Projects/notes'], dir)

  assert.deepEqual(
    repos.map((repo) => repo.name),
    ['alpha-link', 'one', 'two', 'beta', 'hub', 'inner'],
  )
  assert.equal(repos[0].path, join(dir, 'Projects', 'group', 'alpha-link'))
  assert.equal(repos[0].real, realpathSync(join(dir, 'Projects', 'alpha')))
  assert.ok(repos.every((repo) => existsSync(join(repo.path, '.git'))))
})
