import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// Same cost-comparison pattern the model-advisor hook itself is tested against in
// advisor.contract.test.mjs — kept in sync deliberately: the README must not claim
// anything the code is forbidden from claiming.
const COST_LANGUAGE = /cheap|expensive|costs? (more|less)|save (money|tokens)/i

test('the root readme documents installation via the marketplace', () => {
  const r = read('README.md')
  assert.match(r, /plugin marketplace add/)
  assert.match(r, /tacodx\/TacosPlugins/)
})

test('the plugin readme states the undocumented-endpoint caveat', () => {
  const r = read('plugins/usage-guard/README.md')
  assert.match(r, /undocumented/i)
  assert.match(r, /fails? open/i)
})

test('no readme promises macos keychain support', () => {
  const r = read('plugins/usage-guard/README.md')
  assert.doesNotMatch(r, /keychain support/i)
})

test('the model-advisor readme exists', () => {
  assert.ok(existsSync(join(ROOT, 'plugins/model-advisor/README.md')))
})

test('the model-advisor readme documents the hook and the /limits command', () => {
  const r = read('plugins/model-advisor/README.md')
  assert.match(r, /UserPromptSubmit/)
  assert.match(r, /\/limits/)
})

test('the model-advisor readme has a Limitations section', () => {
  const r = read('plugins/model-advisor/README.md')
  assert.match(r, /^## Limitations/m)
})

test('the model-advisor readme states plainly that it never denies anything', () => {
  const r = read('plugins/model-advisor/README.md')
  assert.match(r, /never denies/i)
})

test('the model-advisor readme contains no cost-comparison language', () => {
  const r = read('plugins/model-advisor/README.md')
  assert.doesNotMatch(r, COST_LANGUAGE)
})

test('the root readme lists model-advisor in the plugin table', () => {
  const r = read('README.md')
  assert.match(r, /model-advisor/)
})
