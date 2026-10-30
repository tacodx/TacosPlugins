import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

test('the night manifest names the plugin, with a version, and not like one of Anthropic\'s', () => {
  const manifest = json('plugins/night/.claude-plugin/plugin.json')
  assert.equal(manifest.name, 'night')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(!manifest.name.startsWith('claude'))
})

// Read as text: a standalone plugin may import nothing from outside its own folder, tests included.
test('night is standalone: it carries no vendored copy of packages/core', () => {
  const release = readFileSync(join(ROOT, 'scripts/release.mjs'), 'utf8')
  assert.match(release, /STANDALONE_PLUGINS = \[[^\]]*'night'/)
})
