import { bar } from './render.mjs'
import { binding } from './buckets.mjs'

/**
 * Pure. Renders the full bucket map for the `/limits` CLI — the one surface where this
 * plugin is deliberately loud, unlike the hook which stays silent unless speaking helps.
 *
 * Never claims a percentage it does not have: with an empty `buckets` array this prints
 * ONLY the reason sentence, no bar, no bucket line, no `%` anywhere — a percentage would
 * imply knowledge the tool does not possess (see buckets.mjs's own no-buckets reason).
 *
 * Never guesses the model or effort: a null value for either prints "could not be
 * determined" rather than being silently omitted, so the user can tell "we checked and
 * don't know" apart from "this line doesn't exist".
 *
 * Never states or implies a cost/cheapness comparison between models — it prints `reason`
 * (produced by switchingHelps) verbatim rather than composing its own sentence, so any
 * such claim would have to originate in buckets.mjs, which is tested against that
 * property directly.
 */
export function renderBuckets({ buckets, model, effort, helps, reason }) {
  const lines = ['model-advisor: /limits', '']
  lines.push(`  model:  ${model ?? 'could not be determined'}`)
  lines.push(`  effort: ${effort ?? 'could not be determined'}`)
  lines.push('')

  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) {
    lines.push(`  ${reason}`)
    return lines.join('\n')
  }

  const bindingBucket = binding(list)
  for (const b of list) {
    const scope = b.model ?? b.modelId ?? 'shared'
    const active = b.active ? 'active' : 'inactive'
    const marker = b === bindingBucket ? '  <- binding' : ''
    const pct = String(Math.round(b.percent)).padStart(3)
    lines.push(`  ${b.kind.padEnd(16)} [${bar(b.percent)}] ${pct}%  scope: ${scope.padEnd(10)} (${active})${marker}`)
  }
  lines.push('')
  lines.push(`  switching models: ${helps ? 'would help right now.' : 'would not help right now.'}`)
  lines.push(`  ${reason}`)
  return lines.join('\n')
}
