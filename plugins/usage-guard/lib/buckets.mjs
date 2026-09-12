// Number.isFinite, not !isNaN: Infinity is a number and would always win binding(),
// producing a confident "at Infinity%" answer from a malformed payload.
const num = (v) => (Number.isFinite(v) ? v : null)

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
  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) return { helps: false, reason: 'No rate-limit buckets were reported.' }

  // Decide from the SET of buckets at the maximum, not from a single `binding()` pick.
  // With two model-scoped buckets tied at the same percentage, an order-dependent pick
  // flipped this function between true and false for identical inputs.
  const max = Math.max(...list.map((b) => b.percent))
  const atMax = list.filter((b) => b.percent === max)
  const shown = binding(list)

  if (!currentModel || typeof currentModel !== 'string') {
    return { helps: false,
      reason: `The binding limit is ${shown.kind} at ${Math.round(max)}%. The current model could not be determined, so no advice is offered.` }
  }

  // Switching helps only if EVERY bucket at the maximum is scoped to the model in use.
  // If any shared bucket, or one scoped to another model, is equally exhausted, then
  // switching moves you off one ceiling straight onto another.
  const allOurs = atMax.every((b) => b.model && sameModel(b.model, currentModel))
  if (!allOurs) {
    const blocker = atMax.find((b) => !b.model || !sameModel(b.model, currentModel))
    return { helps: false,
      reason: blocker.model
        ? `The binding limit is scoped to ${blocker.model}, not the model in use. Switching would not change it.`
        : `The binding limit is ${blocker.kind} at ${Math.round(max)}%, which every model draws on. Switching models would not change it.` }
  }
  return { helps: true,
    reason: `The binding limit is ${atMax[0].model}'s own weekly allowance at ${Math.round(max)}%. Another model draws on a different allowance, so switching would help right now.` }
}

/**
 * "Fable" matches "fable" and "claude-fable-5-1", but NOT "affable-5" or "unfabled-model-x".
 * A substring test matched both of those and produced a confident, wrong "switching helps".
 * Compare on token boundaries instead, and require every token of the bucket's name to be
 * present. A name made only of digits identifies nothing, so it never matches.
 */
function sameModel(bucketModel, current) {
  if (typeof bucketModel !== 'string' || typeof current !== 'string') return false
  const tokens = (v) => v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const want = tokens(bucketModel)
  if (want.length === 0 || want.every((t) => /^\d+$/.test(t))) return false
  const have = new Set(tokens(current))
  return want.every((t) => have.has(t))
}
