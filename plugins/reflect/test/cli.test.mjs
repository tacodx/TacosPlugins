import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NOTE_BUSY, NOTE_BUSY_LOST, NOTE_LOST, run } from '../indexer/cli.mjs'
import { STORE_VERSION } from '../indexer/store.mjs'
import { HOME, prompt, reply, tempDir, toolUse } from './helpers.mjs'

const INDEXER = join(dirname(fileURLToPath(import.meta.url)), '..', 'indexer')
const NOW = '2026-03-10T12:00:00Z'
const TRANSCRIPT = join('projects', '-home-u-Projects-demo', 's1.jsonl')

/** A config folder of its own: one session on 9 March, and one terminal prompt on 8 March. */
function configDir(t) {
  const config = tempDir(t)
  mkdirSync(dirname(join(config, TRANSCRIPT)), { recursive: true })
  writeFileSync(
    join(config, TRANSCRIPT),
    [
      prompt({ session: 's1', at: '2026-03-09T10:00:00.000Z' }),
      reply({ id: 'm1', session: 's1', at: '2026-03-09T10:00:05.000Z', out: 40, blocks: [toolUse('t1', 'Bash')] }),
    ]
      .map((line) => `${line}\n`)
      .join(''),
  )
  writeFileSync(
    join(config, 'history.jsonl'),
    `${JSON.stringify({ timestamp: Date.parse('2026-03-08T12:00:00Z'), project: '/x', sessionId: 'h' })}\n`,
  )
  return config
}

const args = (...more) => ['view', '--range', '7d', '--now', NOW, '--tz', 'UTC', '--home', HOME, ...more]
// Both folders the command would otherwise look for on the real machine.
const env = (config) => ({ CLAUDE_CONFIG_DIR: config, CLAUDE_MEM_DATA_DIR: join(config, 'claude-mem') })
const dataDir = (config) => join(config, 'tacos', 'reflect')
const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0

async function viewOf(config, ...more) {
  const result = await run(args(...more), env(config))
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  return JSON.parse(result.stdout)
}

test('view reads the transcripts and the prompt history of its config folder and prints a View', async (t) => {
  const config = configDir(t)

  const view = await viewOf(config)

  assert.equal(view.version, 1)
  assert.equal(view.range.from, '2026-03-04')
  assert.equal(view.totals.prompts, 2) // one in the transcript, one in the history
  assert.equal(view.totals.out, 40)
  assert.equal(view.totals.sessions, 1)
  assert.deepEqual(view.tools, [{ name: 'Bash', n: 1 }])
  assert.deepEqual(view.projects, [{ name: 'demo', prompts: 1, out: 40, sessions: 1 }])
  assert.equal(view.work, null)
  assert.deepEqual(view.notes, [])
  assert.deepEqual(readdirSync(dataDir(config)), ['store.json']) // saved, and the lock released
})

test('history outlives its transcript, because the store was saved', async (t) => {
  const config = configDir(t)
  await viewOf(config)
  rmSync(join(config, TRANSCRIPT))

  const view = await viewOf(config)

  assert.equal(view.totals.out, 40)
  assert.equal(view.totals.sessions, 1)
})

test('while another process holds the lock, view answers from the store as it stands and says so', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.lock'), 'someone else')

  const view = await viewOf(config)

  assert.deepEqual(view.notes, [NOTE_BUSY])
  assert.equal(view.totals.out, 0) // nothing was indexed
  assert.equal(view.totals.prompts, 1) // the prompt history needs no lock
  assert.deepEqual(readdirSync(dataDir(config)), ['store.lock']) // nothing saved, the other lock left alone
})

// --now sets what "today" is for the view. Whether a lock is abandoned is a matter of real time.
test('a lock is judged by the real clock, not by --now', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.lock'), 'someone else')

  const view = await viewOf(config, '--now', '2030-01-01T00:00:00Z')

  assert.deepEqual(view.notes, [NOTE_BUSY])
})

test('a transcript that exists in two project folders is counted once, and the view says so', async (t) => {
  const config = configDir(t)
  cpSync(join(config, 'projects', '-home-u-Projects-demo'), join(config, 'projects', '-home-u-Projects-copy'), { recursive: true })

  const view = await viewOf(config)

  assert.equal(view.totals.out, 40)
  assert.deepEqual(view.notes, ['1 transcript exists in more than one project folder; its larger copy is the one counted.'])
})

test('with no --range, the view covers thirty days', async (t) => {
  const config = configDir(t)

  const result = await run(['view', '--now', NOW, '--tz', 'UTC', '--home', HOME], env(config))

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).range.id, '30d')
})

test('an unreadable store while another process holds the lock is left alone, and nothing is called rebuilt', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.json'), 'not json')
  writeFileSync(join(dataDir(config), 'store.lock'), 'someone else')

  const view = await viewOf(config)

  assert.deepEqual(view.notes, [NOTE_BUSY_LOST])
  assert.deepEqual(readdirSync(dataDir(config)).sort(), ['store.json', 'store.lock'])
  assert.equal(readFileSync(join(dataDir(config), 'store.json'), 'utf8'), 'not json')
})

// The rebuild is the slow path, the one most likely to be cut short. If it is,
// the unreadable file must still be there, so the next run reports the loss.
test('a rebuild that fails leaves the unreadable store in place, and the next run still reports the loss', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.json'), 'not json')

  const failed = await run(args('--projects', join(config, 'history.jsonl')), env(config)) // a file where a folder belongs
  assert.equal(failed.code, 1)
  assert.deepEqual(readdirSync(dataDir(config)), ['store.json'])

  assert.deepEqual((await viewOf(config)).notes, [NOTE_LOST])
})

test('a store from a newer version stops the command and is not touched', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  const newer = JSON.stringify({ version: STORE_VERSION + 1, shape: 'unknown here' })
  writeFileSync(join(dataDir(config), 'store.json'), newer)

  const result = await run(args(), env(config))

  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^reflect: the saved history is from a newer version of reflect/)
  assert.deepEqual(readdirSync(dataDir(config)), ['store.json'])
  assert.equal(readFileSync(join(dataDir(config), 'store.json'), 'utf8'), newer)
})

test('a change of time zone is picked up on the next run', async (t) => {
  const config = configDir(t)
  appendFileSync(join(config, TRANSCRIPT), `${prompt({ session: 's1', at: '2026-03-09T23:30:00.000Z' })}\n`)

  const inUtc = await viewOf(config)
  assert.equal(inUtc.days.find((each) => each.day === '2026-03-09').prompts, 2)

  const inBerlin = await viewOf(config, '--tz', 'Europe/Berlin')
  assert.equal(inBerlin.days.find((each) => each.day === '2026-03-09').prompts, 1)
  assert.equal(inBerlin.days.find((each) => each.day === '2026-03-10').prompts, 1)
})

test('an unreadable store is moved aside and rebuilt, and the loss is said', async (t) => {
  const config = configDir(t)
  mkdirSync(dataDir(config), { recursive: true })
  writeFileSync(join(dataDir(config), 'store.json'), 'not json')

  const view = await viewOf(config)

  assert.deepEqual(view.notes, [NOTE_LOST])
  assert.equal(view.totals.out, 40)
  const files = readdirSync(dataDir(config)).sort()
  assert.equal(files.length, 2)
  assert.match(files[0], /^store\.corrupt-\d+\.json$/)
  assert.equal(files[1], 'store.json')
  assert.equal(readFileSync(join(dataDir(config), files[0]), 'utf8'), 'not json')
})

test('the work mix is read from the claude-mem folder named in the environment', { skip: !hasSqlite && 'sqlite3 is not installed' }, async (t) => {
  const config = configDir(t)
  mkdirSync(join(config, 'claude-mem'))
  execFileSync('sqlite3', [
    join(config, 'claude-mem', 'claude-mem.db'),
    `create table observations (project text, type text, created_at_epoch integer);
     insert into observations values ('demo', 'feature', ${Date.parse('2026-03-09T10:00:00Z')});`,
  ])

  const view = await viewOf(config)

  assert.deepEqual(view.work.types, [{ name: 'feature', n: 1 }])
})

test('transcript lines that cannot be read are counted in a note', async (t) => {
  const config = configDir(t)
  appendFileSync(join(config, TRANSCRIPT), '{"type":"assistant", broken\n')

  assert.deepEqual((await viewOf(config)).notes, ['1 transcript line could not be read and was skipped.'])

  appendFileSync(join(config, TRANSCRIPT), '{"type":"assistant", broken again\n')
  assert.deepEqual((await viewOf(config)).notes, ['2 transcript lines could not be read and were skipped.'])
})

test('a bad command line exits 2 with the usage and prints no View', async (t) => {
  // Isolated although none of these should get as far as a folder: if the parser
  // is ever broken, the command must land in this empty folder, not on the real machine.
  const isolated = env(tempDir(t))
  for (const argv of [[], ['index'], ['view', '--range', '1y'], ['view', '--bogus', 'x'], ['view', '--range']]) {
    const result = await run(argv, isolated)

    assert.equal(result.code, 2, argv.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^usage: /)
  }
})

test('a failure exits 1 with the reason, prints no View, and releases the lock', async (t) => {
  const config = configDir(t)

  const badTime = await run(args('--now', 'whenever'), env(config))
  assert.equal(badTime.code, 1)
  assert.equal(badTime.stdout, '')
  assert.match(badTime.stderr, /^reflect: --now is not a time: whenever\n$/)

  await viewOf(config)
  const elsewhere = await run(args('--projects', tempDir(t)), env(config))
  assert.equal(elsewhere.code, 1)
  assert.equal(elsewhere.stdout, '')
  assert.match(elsewhere.stderr, /^reflect: the saved history was built from /)
  assert.equal(existsSync(join(dataDir(config), 'store.lock')), false)
})

// A plugin folder is often reached through a symlink. The program must still
// recognise that it is the one being run.
test('run as a program through a symlinked folder, it prints a View', (t) => {
  const config = configDir(t)
  const link = join(tempDir(t), 'linked')
  symlinkSync(INDEXER, link)

  const stdout = execFileSync(process.execPath, [join(link, 'cli.mjs'), ...args()], {
    encoding: 'utf8',
    env: { ...process.env, ...env(config) },
  })

  assert.equal(JSON.parse(stdout).totals.out, 40)
})

test('run as a program with a bad command line, it exits 2 and prints the usage on stderr', (t) => {
  const result = spawnSync(process.execPath, [join(INDEXER, 'cli.mjs'), 'view', '--range', '1y'], {
    encoding: 'utf8',
    env: { ...process.env, ...env(tempDir(t)) },
  })

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /unknown range: 1y/)
})
