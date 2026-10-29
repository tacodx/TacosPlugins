import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const readme = read('plugins/night/README.md')

test('the night readme has a Limitations section and says it is not Anthropic\'s', () => {
  assert.match(readme, /^## Limitations/m)
  assert.match(readme, /not made by or affiliated with Anthropic/)
})

test('the night readme names every folder it writes to', () => {
  for (const folder of ['~/.claude/tacos/night/', '~/.local/share/night/', '~/.config/systemd/user/night']) assert.ok(readme.includes(folder), folder)
})

test('the night readme states the walls a night session runs behind', () => {
  assert.match(readme, /Bash sandbox/)
  assert.match(readme, /Pushes fail in git itself/)
  assert.match(readme, /fails closed/)
  assert.match(readme, /--strict-mcp-config --setting-sources project,local/)
})

test('the night readme states the pump rule', () => {
  assert.match(readme, /never edits a fan curve/)
  assert.match(readme, /fixed duty of\s+at least 50 %/)
})

test('the root readme lists night in the plugin table', () => {
  assert.match(read('README.md'), /\[`night`\]\(plugins\/night\/README\.md\)/)
})

test('nothing in the night plugin carries an em or en dash', () => {
  assert.doesNotMatch(readme, /[–—]/)
})
