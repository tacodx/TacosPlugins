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
      modelId: l.scope?.model?.id ?? null,
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
  //
  // No `b.model &&` / `!b.model ||` guard here: sameModel() already decides correctly on
  // its own, including when `model` (display_name) is null but `modelId` is present. Gating
  // on `b.model` first made a bucket identifiable only by id unreachable — it always looked
  // shared, which is not just a wrong answer but a false user-facing claim.
  const allOurs = atMax.every((b) => sameModel(b, currentModel))
  if (!allOurs) {
    const blocker = atMax.find((b) => !sameModel(b, currentModel))
    // A bucket is model-scoped if EITHER identifying field is present; prefer the
    // human-readable display_name for the message, falling back to the id.
    const label = blocker.model ?? blocker.modelId
    return { helps: false,
      reason: label
        ? `The binding limit is scoped to ${label}, not the model in use. Switching would not change it.`
        : `The binding limit is ${blocker.kind} at ${Math.round(max)}%, which every model draws on. Switching models would not change it.` }
  }
  return { helps: true,
    reason: `The binding limit is ${atMax[0].model ?? atMax[0].modelId}'s own weekly allowance at ${Math.round(max)}%. Another model draws on a different allowance, so switching would help right now.` }
}

/**
 * The API's schema carries a stable `scope.model.id` field, but on every real account
 * observed so far it is `null` — only `scope.model.display_name` ("Fable", "Opus 4") is
 * populated. Everything below the id check is a heuristic that exists SOLELY to cover
 * for that empty field. It is deliberately biased toward returning false (silence)
 * whenever it cannot be sure, because a confident wrong "switching helps" is worse than
 * saying nothing. If Anthropic starts populating `id`, every bucket takes the exact-match
 * branch above and the display-name heuristic below becomes dead weight — delete it then,
 * rather than extending it with a fourth matching rule.
 *
 * "Fable" matches "fable" and "claude-fable-5-1", but NOT "affable-5" or "unfabled-model-x".
 * A substring test matched both of those and produced a confident, wrong "switching helps".
 * Compare on token boundaries instead, and require every token of the bucket's name to be
 * present. A name made only of digits identifies nothing, so it never matches.
 *
 * A bucket name carrying a version digit ("Opus 4") is a SEPARATE case: token-subset
 * matching let it match "claude-opus-4-5-20250929" too, because that id's tokens are a
 * superset of the bucket's. There is no safe way to tell "Opus 4" apart from "Opus 4.5"
 * or any other point release by subset containment, so once any token is numeric we
 * require the tokens to match EXACTLY (same length, same order) instead of by subset.
 * That yields a false NEGATIVE on a real match we can't verify — silence, not a wrong
 * "switching helps" — which is the failure direction this module is required to prefer.
 * Do not "fix" this back to subset matching; that is exactly the bug being avoided.
 */
function sameModel(bucket, current) {
  if (typeof current !== 'string') return false

  // A present, non-empty id is a definitive answer either way. A mismatch here must NOT
  // fall through to the display-name heuristic below — an id that disagrees is a real "no",
  // and re-checking with the fuzzier heuristic would reintroduce the exact false-positive
  // risk (a stale/contradictory display_name "rescuing" a match) that having an id removes.
  if (typeof bucket?.modelId === 'string' && bucket.modelId.length > 0) {
    return bucket.modelId.toLowerCase() === current.toLowerCase()
  }

  const bucketModel = bucket?.model
  if (typeof bucketModel !== 'string') return false
  const tokens = (v) => v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const want = tokens(bucketModel)
  if (want.length === 0 || want.every((t) => /^\d+$/.test(t))) return false
  const have = tokens(current)
  if (want.some((t) => /\d/.test(t))) {
    return have.length === want.length && want.every((t, i) => have[i] === t)
  }
  const haveSet = new Set(have)
  return want.every((t) => haveSet.has(t))
}
