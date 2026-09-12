import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vendorCore } from '../../../scripts/release.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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

test('vendorCore prunes a stale module removed from core, but leaves non-.mjs files alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacos-'))
  const core = join(root, 'core')
  const lib = join(root, 'lib')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'decide.mjs'), 'export const a = 1')
  writeFileSync(join(core, 'old-module.mjs'), 'export const z = 9')
  vendorCore(core, lib)
  assert.ok(existsSync(join(lib, 'old-module.mjs')), 'sanity check: stale module was vendored first')

  // a plugin author's own non-.mjs file in lib/ must survive vendoring untouched
  writeFileSync(join(lib, 'README.txt'), 'kept by the plugin, not core output')

  rmSync(join(core, 'old-module.mjs'))

  const copied = vendorCore(core, lib)

  assert.deepEqual(copied, ['decide.mjs'])
  assert.ok(!existsSync(join(lib, 'old-module.mjs')), 'a module deleted from core must not linger in lib/')
  assert.ok(existsSync(join(lib, 'decide.mjs')))
  assert.ok(existsSync(join(lib, 'README.txt')), 'a non-.mjs file in lib/ must not be pruned')
})

// This is the guarantee that Critical 1 (the published plugin could not run at all,
// because plugins/*/lib/ was gitignored while guard.mjs/budget.mjs/explain.mjs import
// from it at startup with no build step) can never silently recur: the vendored copy
// actually shipped in git must never drift from packages/core. `npm test` runs against
// the working tree exactly as `git archive` would ship it, so this fails the moment
// someone edits packages/core and forgets to re-run scripts/release.mjs before committing.
test('every packages/core module is vendored byte-identically into plugins/usage-guard/lib/', () => {
  const core = join(ROOT, 'packages', 'core')
  const lib = join(ROOT, 'plugins', 'usage-guard', 'lib')
  const coreModules = readdirSync(core)
    .filter((name) => name.endsWith('.mjs') && !statSync(join(core, name)).isDirectory())

  assert.ok(coreModules.length > 0, 'sanity check: packages/core must actually contain modules')

  for (const name of coreModules) {
    const vendoredPath = join(lib, name)
    assert.ok(existsSync(vendoredPath), `plugins/usage-guard/lib/${name} is missing — run scripts/release.mjs`)
    const source = readFileSync(join(core, name), 'utf8')
    const vendored = readFileSync(vendoredPath, 'utf8')
    assert.equal(vendored, source, `plugins/usage-guard/lib/${name} has drifted from packages/core/${name} — run scripts/release.mjs and commit the result`)
  }
})
