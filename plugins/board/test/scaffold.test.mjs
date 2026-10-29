import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

// A bare `node --test` also runs *.test.ts on Node 22, and a mod's engine tests
// import 'claude-code/testing', which only `claude plugin test` can resolve.
test('npm test runs only the .mjs tests', () => {
  assert.equal(json('package.json').scripts.test, 'node --test "**/*.test.mjs"')
})

test('the board manifest names the plugin, with a version, and not like one of Anthropic\'s', () => {
  const manifest = json('plugins/board/.claude-plugin/plugin.json')
  assert.equal(manifest.name, 'board')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(!manifest.name.startsWith('claude'))
})
