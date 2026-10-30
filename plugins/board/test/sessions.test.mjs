import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRunning, projectNamer, readRegistry, readTranscripts, workingNow } from '../reader/sessions.mjs'
import { sessionEntry, tempDir, transcriptLine, writeAt } from './helpers.mjs'

const NOW = Date.parse('2026-03-10T12:00:00Z')
const MIN = 60_000
const alive = () => true

function registry(t, entries) {
  const dir = join(tempDir(t), 'sessions')
  mkdirSync(dir)
  for (const [name, value] of Object.entries(entries)) {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return dir
}

test('the running sessions: busy ones by name, idle ones counted', (t) => {
  const dir = registry(t, {
    '101.json': sessionEntry({ pid: 101, name: 'Alpha · Build', cwd: '/w/alpha', statusUpdatedAt: NOW - 12 * MIN }),
    '102.json': sessionEntry({ pid: 102, name: 'Beta · Fix', cwd: '/w/beta/.claude/worktrees/calm-fox', statusUpdatedAt: NOW - 40 * MIN }),
    '103.json': sessionEntry({ pid: 103, status: 'idle' }),
    '104.json': sessionEntry({ pid: 104, status: 'idle' }),
  })

  assert.deepEqual(readRegistry(dir, { isAlive: alive }), {
    busy: [
      { name: 'Beta · Fix', cwd: '/w/beta/.claude/worktrees/calm-fox', since: NOW - 40 * MIN },
      { name: 'Alpha · Build', cwd: '/w/alpha', since: NOW - 12 * MIN },
    ],
    idle: 2,
  })
})

test('sessions that ended, programs on the SDK and files that are not sessions are left out', (t) => {
  const dir = registry(t, {
    '201.json': sessionEntry({ pid: 201, name: 'Ended' }),
    '202.json': sessionEntry({ pid: 202, name: 'Observer', entrypoint: 'sdk-cli' }),
    '203.json': '{ not json',
    '204.json': JSON.stringify({ pid: 'x', status: 'busy' }),
    '205.json': JSON.stringify(['a list']),
    // Claude Code keeps keys beside the sessions. They are never opened: this one
    // would show up as a session if it were.
    '206.f00d.key': JSON.stringify(sessionEntry({ pid: 206, name: 'A key' })),
    '207.json': sessionEntry({ pid: 207, name: 'Still here', statusUpdatedAt: 'later' }),
  })

  const found = readRegistry(dir, { isAlive: (pid) => pid !== 201 })

  assert.deepEqual(found, { busy: [{ name: 'Still here', cwd: '/home/u/Projects/alpha', since: null }], idle: 0 })
})

test('no list of sessions, or one with nothing usable in it, is no answer', (t) => {
  assert.equal(readRegistry(join(tempDir(t), 'nowhere'), { isAlive: alive }), null)
  assert.equal(readRegistry(registry(t, { '1.json': '{}', 'x.txt': 'hello' }), { isAlive: alive }), null)
})

test('a list whose sessions have all ended is an answer: nothing is running', (t) => {
  const dir = registry(t, { '301.json': sessionEntry({ pid: 301 }) })

  assert.deepEqual(readRegistry(dir, { isAlive: () => false }), { busy: [], idle: 0 })
})

test('isRunning: this process is, a pid nobody has is not, a reused pid is not', () => {
  assert.equal(isRunning(process.pid), true)
  assert.equal(isRunning(2 ** 22 + 4321), false)
  const stat = `/proc/${process.pid}/stat`
  if (existsSync(stat)) {
    const started = readFileSync(stat, 'utf8').slice(readFileSync(stat, 'utf8').lastIndexOf(')') + 2).split(' ')[19]
    assert.equal(isRunning(process.pid, started), true)
    assert.equal(isRunning(process.pid, String(Number(started) + 1)), false)
  }
})

test('transcripts written to in the last ten minutes, with the folder they ran in', (t) => {
  const projects = join(tempDir(t), 'projects')
  const alpha = join(projects, '-w-alpha')
  writeAt(join(alpha, 's1.jsonl'), `${transcriptLine({ cwd: '/w/alpha' })}\n${transcriptLine({ cwd: '/w/alpha', type: 'user' })}\n`, NOW - 2 * MIN)
  writeAt(join(alpha, 's2.jsonl'), `${transcriptLine({ cwd: '/w/alpha' })}\n`, NOW - 30 * MIN)
  // A session whose own transcript is quiet while its subagent works.
  writeAt(join(alpha, 's3.jsonl'), `${transcriptLine({ cwd: '/w/alpha/.claude/worktrees/x' })}\n{"type":"cost-state"}\n`, NOW - 50 * MIN)
  writeAt(join(alpha, 's3', 'subagents', 'agent-1.jsonl'), `${transcriptLine({ cwd: '/w/alpha/.claude/worktrees/x' })}\n`, NOW - MIN)
  writeAt(join(projects, '-w-observer', 's4.jsonl'), `${transcriptLine({ cwd: '/w/observer', entrypoint: 'sdk-cli' })}\n`, NOW - MIN)
  writeAt(join(projects, '-w-beta', 's5.jsonl'), 'not json\n', NOW - 3 * MIN)

  assert.deepEqual(readTranscripts(projects, { now: NOW, windowMs: 10 * MIN }), [
    { cwd: '/w/alpha/.claude/worktrees/x', at: NOW - MIN },
    { cwd: '/w/alpha', at: NOW - 2 * MIN },
    { cwd: null, at: NOW - 3 * MIN },
  ])
})

test('a session is named by the repo it runs in, worktrees included', () => {
  const nameOf = projectNamer([{ path: '/w/alpha', name: 'alpha' }, { path: '/w/alpha/sub', name: 'sub' }, { path: '/w/beta', name: 'beta' }])

  assert.equal(nameOf('/w/alpha'), 'alpha')
  assert.equal(nameOf('/w/alpha/.claude/worktrees/calm-fox'), 'alpha')
  assert.equal(nameOf('/w/alpha/sub/deeper'), 'sub')
  assert.equal(nameOf('/w/alphabet'), 'alphabet')
  assert.equal(nameOf('/elsewhere/notes/'), 'notes')
  assert.equal(nameOf(null), 'unknown')
})

test('a session in a repo reached through a link is named by that repo', () => {
  const nameOf = projectNamer([{ path: '/home/u/Projects/alpha', name: 'alpha', real: '/data/projects/alpha' }])

  assert.equal(nameOf('/data/projects/alpha/.claude/worktrees/calm-fox'), 'alpha')
  assert.equal(nameOf('/home/u/Projects/alpha'), 'alpha')
})

test('workingNow prefers the list of running sessions and falls back to transcripts', (t) => {
  const repos = [{ path: '/w/alpha', name: 'alpha' }]
  const dir = registry(t, { '101.json': sessionEntry({ pid: 101, name: 'Alpha · Build', cwd: '/w/alpha/.claude/worktrees/x', statusUpdatedAt: NOW - 5 * MIN }) })
  const projects = join(tempDir(t), 'projects')
  writeAt(join(projects, '-w-alpha', 's1.jsonl'), `${transcriptLine({ cwd: '/w/alpha' })}\n`, NOW - 4 * MIN)

  assert.deepEqual(workingNow({ registryDir: dir, projectsDir: projects, now: NOW, repos, isAlive: alive }), {
    source: 'registry',
    working: [{ name: 'Alpha · Build', project: 'alpha', since: NOW - 5 * MIN }],
    idle: 0,
  })
  assert.deepEqual(workingNow({ registryDir: join(dir, 'gone'), projectsDir: projects, now: NOW, repos, isAlive: alive }), {
    source: 'transcripts',
    working: [{ name: 'alpha', project: 'alpha', since: NOW - 4 * MIN }],
    idle: null,
  })
})
