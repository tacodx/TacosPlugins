#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)

// This is the tool someone runs when things look wrong, so the whole body is wrapped:
// any failure — a corrupt cache, a permissions error, an unexpected shape from the API —
// must collapse to one readable line, never a raw stack trace.
try {
  const { configDir } = await load('config.mjs')
  const { getGauges } = await load('usage.mjs')
  const { normaliseLimits, switchingHelps } = await load('buckets.mjs')
  const { currentModel } = await load('current-model.mjs')
  const { renderBuckets } = await load('render-buckets.mjs')

  const dir = configDir(process.env)

  // `/limits` (commands/limits.md) runs as a plain shell command substitution, not a
  // hook — Claude Code passes it only $CLAUDE_SESSION_ID, never the hook payload that
  // advisor.mjs receives on stdin. `effort` lives exclusively in that payload (see
  // docs/superpowers/specs/2026-09-12-model-advisor-design.md §5) and is not persisted
  // anywhere this CLI can read, so it is unconditionally unknown here — renderBuckets
  // says so plainly rather than this file guessing or omitting the line.
  const effort = null

  const { raw } = await getGauges({ dir, now: Date.now(), wantRaw: true })
  const buckets = normaliseLimits(raw)

  // Same reason as `effort` above: no transcript_path reaches this CLI, so only the
  // settings.json fallback tier of currentModel's two-tier lookup can ever apply here.
  const model = currentModel({ settingsPath: join(dir, 'settings.json'), readFile: readFileSync })

  const { helps, reason } = switchingHelps(buckets, model)

  console.log(renderBuckets({ buckets, model, effort, helps, reason }))
} catch (err) {
  console.log(`model-advisor: /limits could not run — ${err?.message ?? 'unknown error'}`)
}
