// Shared test helpers. Every fixture here is made up: the repo is public.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temp directory that is removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'night-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fixed instant for tests: 2026-03-10 21:00 UTC unless given. */
export const at = (iso = '2026-03-10T21:00:00Z') => Date.parse(iso)
