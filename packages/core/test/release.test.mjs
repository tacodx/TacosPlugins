import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vendorCore } from '../../../scripts/release.mjs'

test('vendorCore copies core modules but not tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacos-'))
  const core = join(root, 'core')
  const lib = join(root, 'lib')
  mkdirSync(join(core, 'test'), { recursive: true })
  writeFileSync(join(core, 'decide.mjs'), 'export const a = 1')
  writeFileSync(join(core, 'usage.mjs'), 'export const b = 2')
  writeFileSync(join(core, 'test', 'decide.test.mjs'), 'nope')

  const copied = vendorCore(core, lib)

  assert.deepEqual(copied.sort(), ['decide.mjs', 'usage.mjs'])
  assert.ok(existsSync(join(lib, 'decide.mjs')))
  assert.ok(!existsSync(join(lib, 'test')), 'tests must not ship to users')
  assert.match(readFileSync(join(lib, 'decide.mjs'), 'utf8'), /export const a/)
})

test('vendoring twice is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacos-'))
  const core = join(root, 'core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'decide.mjs'), 'export const a = 1')
  vendorCore(core, join(root, 'lib'))
  assert.doesNotThrow(() => vendorCore(core, join(root, 'lib')))
})
