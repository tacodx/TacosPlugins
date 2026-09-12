import { bar } from './render.mjs'

/**
 * Pure. Renders the full bucket map for the `/limits` CLI — the one surface where this
 * plugin is deliberately loud, unlike the hook which stays silent unless speaking helps.
 *
 * Never claims a percentage it does not have: with an empty `buckets` array this prints
 * ONLY the reason sentence, no bar, no bucket line, no `%` anywhere — a percentage would
 * imply knowledge the tool does not possess (see buckets.mjs's own no-buckets reason).
 *
 * Never guesses the model: a null value prints "could not be determined" rather than
 * being silently omitted, so the user can tell "we checked and don't know" apart from
 * "this line doesn't exist" — the model genuinely varies call to call, so a reader needs
 * to know when the advice below is unanchored.
 *
 * Never states or implies a cost/cheapness comparison between models — it prints `reason`
 * (produced by switchingHelps) verbatim rather than composing its own sentence, so any
 * such claim would have to originate in buckets.mjs, which is tested against that
 * property directly.
 *
 * `bucket` is the exact object `switchingHelps` returned alongside `helps`/`reason` — the
 * one bucket it actually reasoned about. This renderer marks that bucket and ONLY that
 * bucket; it deliberately has no `binding()` call of its own. It used to: `binding()` is
 * scope-blind and would happily mark a bucket scoped to a model other than the one in
 * use, while `switchingHelps`'s sentence talked about a different bucket entirely — two
 * independent answers to "which bucket binds" that could, and did, disagree. There is
 * now exactly one place that decides that question.
 *
 * `unavailable` (with `unavailableReason`) is a THIRD state, distinct from "the account
 * reported zero buckets": it means the usage data itself could not be read right now —
 * blind, or serving a cache stale enough that `getGauges` no longer considers it usable.
 * Printing "no rate-limit buckets were reported" in that case would assert something
 * about the account with no basis — the account may have plenty of buckets, we simply
 * have no fresh read of them. So this branch prints neither a bucket list nor any
 * percentage at all, only that the read failed and (when known) why.
 */
export function renderBuckets({ buckets, model, helps, reason, bucket, unavailable, unavailableReason }) {
  const lines = ['model-advisor: /limits', '']
  lines.push(`  model:  ${model ?? 'could not be determined'}`)
  lines.push('')

  if (unavailable) {
    const why = unavailableReason ? ` (reason: ${unavailableReason})` : ''
    lines.push(`  Usage data could not be read${why}. No bucket information is available.`)
    return lines.join('\n')
  }

  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) {
    lines.push(`  ${reason}`)
    return lines.join('\n')
  }

  for (const b of list) {
    const scope = b.model ?? b.modelId ?? 'shared'
    const active = b.active ? 'active' : 'inactive'
    const marker = b === bucket ? '  <- binding' : ''
    const pct = String(Math.round(b.percent)).padStart(3)
    lines.push(`  ${b.kind.padEnd(16)} [${bar(b.percent)}] ${pct}%  scope: ${scope.padEnd(10)} (${active})${marker}`)
  }
  lines.push('')
  lines.push(`  switching models: ${helps ? 'would help right now.' : 'would not help right now.'}`)
  lines.push(`  ${reason}`)
  return lines.join('\n')
}
