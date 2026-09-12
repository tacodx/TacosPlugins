const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null)

/** Pure. Tolerates any payload shape; unusable entries are dropped, never defaulted. */
export function normaliseLimits(raw) {
  const list = Array.isArray(raw?.limits) ? raw.limits : []
  return list
    .filter((l) => l && typeof l.kind === 'string' && num(l.percent) !== null)
    .map((l) => ({
      kind: l.kind,
      group: l.group ?? null,
      percent: l.percent,
      model: l.scope?.model?.display_name ?? null,
      resetsAt: l.resets_at ?? null,
      active: l.is_active === true,
    }))
}

/** The bucket closest to exhausted. Ties break toward the active one, then input order. */
export function binding(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null
  let best = null
  for (const b of buckets) {
    if (best === null) { best = b; continue }
    if (b.percent > best.percent) { best = b; continue }
    if (b.percent === best.percent && b.active && !best.active) best = b
  }
  return best
}

/**
 * Switching models helps ONLY when the binding bucket is scoped to the model in use.
 * Anything else — a shared bucket, an unknown model, a bucket scoped to another model —
 * is false. This function never speculates about relative model cost; the API does not
 * support that and inventing it is the confusion this plugin exists to remove.
 */
export function switchingHelps(buckets, currentModel) {
  const b = binding(buckets)
  if (!b) return { helps: false, reason: 'No rate-limit buckets were reported.' }
  if (!b.model) {
    return { helps: false,
      reason: `The binding limit is ${b.kind} at ${Math.round(b.percent)}%, which every model draws on. Switching models would not change it.` }
  }
  if (!currentModel) {
    return { helps: false,
      reason: `The binding limit is ${b.kind} at ${Math.round(b.percent)}%, scoped to ${b.model}. The current model could not be determined, so no advice is offered.` }
  }
  if (!sameModel(b.model, currentModel)) {
    return { helps: false,
      reason: `The binding limit is scoped to ${b.model}, which is not the model in use. Switching would not change it.` }
  }
  return { helps: true,
    reason: `The binding limit is ${b.model}'s own weekly allowance at ${Math.round(b.percent)}%. Another model draws on a different allowance, so switching would help right now.` }
}

/** "Fable" matches "fable" and "claude-fable-5-1". Deliberately loose in one direction only. */
function sameModel(bucketModel, current) {
  const a = String(bucketModel).toLowerCase()
  const b = String(current).toLowerCase()
  return b === a || b.includes(a)
}
