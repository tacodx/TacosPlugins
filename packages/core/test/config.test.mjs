import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, mergeConfig, configDir, readConfig } from '../config.mjs'

test('defaults govern all four gauges and weekly is tighter than five_hour', () => {
  assert.ok(DEFAULTS.gauges.five_hour && DEFAULTS.gauges.seven_day)
  assert.ok(DEFAULTS.gauges.extra_usage && DEFAULTS.gauges.scoped)
  assert.ok(DEFAULTS.gauges.seven_day.hard < DEFAULTS.gauges.five_hour.hard,
    'overshooting the weekly costs days, so it brakes earlier')
  assert.equal(DEFAULTS.mode, 'enforce')
})

test('session config overrides user config overrides defaults', () => {
  const r = mergeConfig(
    { gauges: { five_hour: { soft: 50, hard: 60 } } },
    { gauges: { five_hour: { hard: 55 } } },
  )
  assert.equal(r.gauges.five_hour.soft, 50)
  assert.equal(r.gauges.five_hour.hard, 55)
  assert.equal(r.gauges.seven_day.hard, DEFAULTS.gauges.seven_day.hard)
})

test('mode off in the session config wins', () => {
  assert.equal(mergeConfig({}, { mode: 'off' }).mode, 'off')
})

test('an unknown mode falls back to the default rather than blocking', () => {
  assert.equal(mergeConfig({ mode: 'banana' }, {}).mode, 'enforce')
})

test('configDir honours CLAUDE_CONFIG_DIR and never expands a tilde', () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/tmp/x' }), '/tmp/x')
  assert.doesNotMatch(configDir({}), /^~/)
})

test('malformed json falls back to defaults instead of throwing', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => '{ not json',
  })
  assert.deepEqual(r.gauges.five_hour, DEFAULTS.gauges.five_hour)
})

test('a missing file is not an error', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
  })
  assert.equal(r.mode, DEFAULTS.mode)
})

test('invalid dir (e.g. undefined) never throws, and is treated as unreadable rather than silently enforcing', () => {
  // path.join(undefined, ...) throws before readFile is even called, with a
  // non-ENOENT error — the same "we could not read this" case as corrupt JSON,
  // so it degrades to dry-run instead of quietly defaulting to enforce.
  const fn = () => readConfig({
    dir: undefined, sessionId: 's1',
    readFile: () => '{}',
  })
  assert.doesNotThrow(fn)
  const r = fn()
  assert.deepEqual(r.gauges, DEFAULTS.gauges)
  assert.equal(r.mode, 'dry-run')
  assert.equal(r.configUnreadable, true)
})

test('a corrupt config (not ENOENT) is unreadable: it degrades to dry-run and says so, instead of silently re-arming enforce', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => '{ not json',
  })
  assert.equal(r.mode, 'dry-run')
  assert.equal(r.configUnreadable, true)
})

test('ENOENT means no config yet, not unreadable: the shipped default (enforce) applies normally', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
  })
  assert.equal(r.mode, DEFAULTS.mode)
  assert.equal(r.configUnreadable, undefined)
})

test('a valid config that deliberately turns the guard off is respected and is not marked unreadable', () => {
  const r = readConfig({
    dir: '/nope',
    readFile: () => JSON.stringify({ mode: 'off' }),
  })
  assert.equal(r.mode, 'off')
  assert.equal(r.configUnreadable, undefined)
})

test('a corrupt session file does not discard the user config\'s valid, explicit "off"', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: (path) => path.endsWith('config.json')
      ? JSON.stringify({ mode: 'off' })
      : (() => { throw new Error('session file truncated') })(),
  })
  assert.equal(r.mode, 'off')
  assert.equal(r.configUnreadable, true)
})

test('a corrupt session file does not discard the user config\'s valid, explicit "enforce"', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: (path) => path.endsWith('config.json')
      ? JSON.stringify({ mode: 'enforce' })
      : (() => { throw new Error('session file truncated') })(),
  })
  assert.equal(r.mode, 'enforce')
  assert.equal(r.configUnreadable, true)
})

test('a corrupt user config does not discard a valid session override (e.g. from /budget on)', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: (path) => path.includes('sessions')
      ? JSON.stringify({ mode: 'enforce' })
      : (() => { throw new Error('user config truncated') })(),
  })
  assert.equal(r.mode, 'enforce')
  assert.equal(r.configUnreadable, true)
})

test('a corrupt user config with no session file at all (ENOENT) degrades to dry-run', () => {
  const r = readConfig({
    dir: '/nope', sessionId: 's1',
    readFile: (path) => {
      if (path.includes('sessions')) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      throw new Error('user config truncated')
    },
  })
  assert.equal(r.mode, 'dry-run')
  assert.equal(r.configUnreadable, true)
})
