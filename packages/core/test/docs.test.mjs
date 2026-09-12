import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

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
