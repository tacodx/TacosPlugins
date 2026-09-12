import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

test('marketplace manifest has the three required keys', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  assert.ok(m.name, 'name is required')
  assert.ok(m.owner && m.owner.name, 'owner.name is required')
  assert.ok(Array.isArray(m.plugins), 'plugins must be an array')
})

test('marketplace name is kebab-case and does not impersonate Anthropic', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  assert.match(m.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.doesNotMatch(m.name, /official[^a-z0-9]*(anthropic|claude)/i)
})

test('every plugin source starts with ./ and resolves to a real plugin.json', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  for (const entry of m.plugins) {
    assert.ok(entry.name, 'plugin entry needs a name')
    assert.equal(typeof entry.source, 'string')
    assert.ok(entry.source.startsWith('./'),
      `source "${entry.source}" must start with "./" or the entry is silently stubbed`)
    const manifest = join(ROOT, entry.source, '.claude-plugin', 'plugin.json')
    assert.ok(existsSync(manifest), `missing ${manifest}`)
  }
})

test('plugin.json version matches its marketplace entry', () => {
  const m = readJson('.claude-plugin/marketplace.json')
  for (const entry of m.plugins) {
    const p = readJson(join(entry.source, '.claude-plugin', 'plugin.json'))
    assert.ok(p.name, 'plugin.json requires name')
    if (entry.version) assert.equal(p.version, entry.version)
  }
})
