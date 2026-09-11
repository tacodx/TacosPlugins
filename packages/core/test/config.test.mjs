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

test('invalid dir (e.g. undefined) never throws and returns defaults', () => {
  const fn = () => readConfig({
    dir: undefined, sessionId: 's1',
    readFile: () => '{}',
  })
  assert.doesNotThrow(fn)
  const r = fn()
  assert.deepEqual(r.gauges, DEFAULTS.gauges)
  assert.equal(r.mode, DEFAULTS.mode)
})
