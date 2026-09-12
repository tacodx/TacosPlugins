#!/usr/bin/env node
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
  const { currentModel, findSessionTranscript } = await load('current-model.mjs')
  const { renderBuckets } = await load('render-buckets.mjs')

  const dir = configDir(process.env)

  // `/limits` (commands/limits.md) runs as a plain shell command substitution, not a
  // hook — Claude Code passes it only $CLAUDE_SESSION_ID, never the hook payload that
  // advisor.mjs receives on stdin. `effort` lives exclusively in that payload and is not
  // persisted anywhere this CLI can read, so renderBuckets no longer has a parameter for
  // it at all — there is no reachable caller (this one, or the hook, which never calls
  // renderBuckets) that could ever supply a real value. (The design doc's §5/§7 still
  // describe an effort line; that text is now stale and needs reconciling separately.)

  const { raw } = await getGauges({ dir, now: Date.now(), wantRaw: true })
  const buckets = normaliseLimits(raw)

  // No transcript_path reaches this CLI directly (see above), but the session id does —
  // recover the transcript by searching for it under <dir>/projects/, one level deep.
  // findSessionTranscript is conservative: it returns a path only on exactly one match,
  // so an ambiguous or absent transcript falls through to the settings.json fallback
  // below exactly as it would for a hook that received no transcript_path at all.
  const sessionId = process.argv[2] || null
  const transcriptPath = sessionId ? findSessionTranscript(dir, sessionId) : null
  const model = currentModel({ transcriptPath, settingsPath: join(dir, 'settings.json') })

  const { helps, reason, bucket } = switchingHelps(buckets, model)

  console.log(renderBuckets({ buckets, model, helps, reason, bucket }))
} catch (err) {
  console.log(`model-advisor: /limits could not run — ${err?.message ?? 'unknown error'}`)
}
