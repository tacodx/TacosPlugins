import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelFromTranscript, stripSuffix, currentModel } from '../current-model.mjs'

const row = (model, ts) => JSON.stringify({ message: { model }, timestamp: ts })

test('takes the most recent model, not the first', () => {
  const text = [row('claude-sonnet-5', '1'), row('claude-opus-5', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('ignores synthetic rows', () => {
  const text = [row('claude-opus-5', '1'), row('<synthetic>', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('tolerates junk lines and returns null when there is no model', () => {
  assert.equal(modelFromTranscript('not json\n{}\n'), null)
  assert.equal(modelFromTranscript(''), null)
})

test('strips a context suffix', () => {
  assert.equal(stripSuffix('claude-opus-5[1m]'), 'claude-opus-5')
  assert.equal(stripSuffix('claude-opus-5'), 'claude-opus-5')
  assert.equal(stripSuffix(null), null)
})

test('falls back to settings when the transcript yields nothing', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? '' : JSON.stringify({ model: 'claude-opus-5[1m]' })),
  })
  assert.equal(m, 'claude-opus-5')
})

test('prefers the transcript over settings', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? row('claude-sonnet-5', '1') : JSON.stringify({ model: 'claude-opus-5' })),
  })
  assert.equal(m, 'claude-sonnet-5')
})

test('never throws; returns null when everything fails', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: () => { throw new Error('nope') },
  })
  assert.equal(m, null)
})

test('returns null, not a guessed default, when there is no settings path to fall back to', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: undefined,
    readFile: () => '',
  })
  assert.equal(m, null)
})
