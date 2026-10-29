import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, loadConfig, merge, nightFiles, nightPaths, saveConfig, validate } from '../engine/config.mjs'
import { readJson } from '../engine/fsx.mjs'
import { addEvent, beat, readBeats, readCurrent, staleBeats, updateCurrent } from '../engine/state.mjs'
import { tempDir } from './helpers.mjs'

const pathsIn = (dir) => nightPaths({ env: { HOME: dir }, home: dir })

test('night keeps everything under the Claude config folder, which CLAUDE_CONFIG_DIR moves', () => {
  const paths = nightPaths({ env: { CLAUDE_CONFIG_DIR: '/c' }, home: '/home/u' })
  assert.equal(paths.root, '/c/tacos/night')
  assert.equal(paths.sessions, '/c/sessions')
  assert.equal(paths.usageCache, '/c/tacos/usage-cache.json')
  assert.equal(paths.units, '/home/u/.config/systemd/user')
  assert.equal(nightFiles(paths, '2026-03-10').queue, '/c/tacos/night/nights/2026-03-10/queue.json')
})

test('the defaults hold no personal path and pass their own checks', () => {
  assert.deepEqual(validate(structuredClone(DEFAULTS)), [])
  const text = JSON.stringify(DEFAULTS)
  assert.doesNotMatch(text, /\/home\/|Documents|Projects/)
})

test('a missing config is the defaults', (t) => {
  const { config, problems } = loadConfig(pathsIn(tempDir(t)))
  assert.equal(config.sessions, DEFAULTS.sessions)
  assert.deepEqual(problems, [])
})

test('a stored config is laid over the defaults key by key', (t) => {
  const paths = pathsIn(tempDir(t))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ sessions: 4, hardware: { fans: { tokenFile: '/x' } } }))
  const { config } = loadConfig(paths)
  assert.equal(config.sessions, 4)
  assert.equal(config.hardware.fans.tokenFile, '/x')
  assert.equal(config.hardware.fans.pumpMinDuty, 50)
})

test('a broken config file falls back to the defaults', (t) => {
  const paths = pathsIn(tempDir(t))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.config, '{ not json')
  assert.equal(loadConfig(paths).config.sessions, DEFAULTS.sessions)
})

test('saving a window stores only the change', (t) => {
  const paths = pathsIn(tempDir(t))
  saveConfig(paths, { window: { from: '00:15', to: '06:45' } })
  assert.deepEqual(readJson(paths.config), { window: { from: '00:15', to: '06:45' } })
  assert.equal(loadConfig(paths).config.window.from, '00:15')
})

test('a change that breaks the config is refused and nothing is written', (t) => {
  const paths = pathsIn(tempDir(t))
  assert.throws(() => saveConfig(paths, { window: { from: '25:00' } }), /window.from/)
  assert.throws(() => saveConfig(paths, { sessions: 5 }), /sessions/)
  assert.throws(() => saveConfig(paths, { hardware: { fans: { pumpMinDuty: 40 } } }), /pump/)
  assert.equal(readJson(paths.config), null)
})

test('lists replace rather than merge', () => {
  assert.deepEqual(merge({ a: [1, 2] }, { a: [3] }), { a: [3] })
})

test('with no night armed the phase is idle', (t) => {
  assert.deepEqual(readCurrent(pathsIn(tempDir(t))), { phase: 'idle' })
})

test('the current night is updated in place', (t) => {
  const paths = pathsIn(tempDir(t))
  updateCurrent(paths, () => ({ phase: 'armed', date: '2026-03-10' }))
  updateCurrent(paths, (c) => ({ ...c, phase: 'night' }))
  assert.deepEqual(readCurrent(paths), { phase: 'night', date: '2026-03-10' })
})

test('events and heartbeats land in the night folder', (t) => {
  const files = nightFiles(pathsIn(tempDir(t)), '2026-03-10')
  addEvent(files, 'dusk.step', { step: 'rgb', ok: true }, Date.parse('2026-03-10T22:30:00Z'))
  beat(files, 'health', {}, 1000)
  beat(files, 'medic', {}, 50_000)
  const beats = readBeats(files)
  assert.equal(beats.health.at, 1000)
  assert.deepEqual(staleBeats(beats, ['health', 'medic', 'logs'], 60_000, 30_000), ['health', 'logs'])
})
