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

/**
 * The bucket closest to exhausted. Ties break toward the active one, then input order.
 *
 * Scope-blind by design — it picks over whatever list it's handed and has no notion of
 * "the current model" at all. `switchingHelps` is the only place that reasons about
 * applicability; it uses this purely as a deterministic tie-break once it has already
 * narrowed the list down to the buckets worth comparing. Nothing outside this module
 * calls it anymore (see `renderBuckets`, which used to call it independently and marked
 * a bucket `switchingHelps` itself considered irrelevant) — kept exported because it's
 * still a reasonable, independently-testable primitive and removing it would gain
 * nothing.
 */
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

/** True for a bucket with no model scope at all — applies to every model, including one we can't name. */
function isShared(bucket) {
  const noModel = typeof bucket?.model !== 'string' || bucket.model === ''
  const noModelId = typeof bucket?.modelId !== 'string' || bucket.modelId === ''
  return noModel && noModelId
}

/**
 * A bucket is applicable to `currentModel` when it can actually constrain the session
 * that's running right now: a shared bucket applies to everyone, unconditionally. A
 * scoped bucket applies only when `sameModel` confirms the scope matches — which also
 * covers the "could not confirm" case (see `sameModel`'s own doc): an unconfirmed match
 * is treated as inapplicable, the same false-negative bias every guess-avoidance rule in
 * this module leans on. A bucket scoped to some other, confirmed-different model is
 * exactly as inapplicable as one whose scope simply couldn't be verified — either way it
 * must never be shown as binding this session or drive the advice sentence.
 */
function isApplicable(bucket, currentModel) {
  if (isShared(bucket)) return true
  return sameModel(bucket, currentModel)
}

/**
 * Switching models helps ONLY when the bucket actually binding THIS session — the
 * highest-percentage bucket that applies to `currentModel` — is scoped to that model.
 * Anything else — a shared bucket, an unknown model, a bucket scoped to another model —
 * is false. This function never speculates about relative model cost; the API does not
 * support that and inventing it is the confusion this plugin exists to remove.
 *
 * Returns `{ helps, bucket, reason }`. `bucket` is the single bucket this function
 * actually reasoned about — the one a renderer should mark as binding, if any — so a
 * caller (see `renderBuckets`) never has to (and never should) re-derive "which bucket
 * binds" on its own via a second, scope-blind pass; two independent answers to the same
 * question is exactly how this function and its renderer used to disagree.
 */
export function switchingHelps(buckets, currentModel) {
  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) return { helps: false, bucket: null, reason: 'No rate-limit buckets were reported.' }

  const modelKnown = typeof currentModel === 'string' && currentModel !== ''

  // When the current model is unknown, no bucket can be shown to be inapplicable to it —
  // "inapplicable" is a claim about a specific model, and we have none to compare
  // against — so every bucket counts as applicable and the sentence says plainly that no
  // advice is being offered, rather than picking a model to compare against by guessing.
  const applicable = modelKnown ? list.filter((b) => isApplicable(b, currentModel)) : list

  if (applicable.length === 0) {
    // Only reachable when the model IS known and every reported bucket is scoped away
    // from it (confirmed-different or unconfirmed) — nothing here constrains the session
    // actually running, so nothing is marked binding, but the reason still names the
    // highest bucket reported so the exclusion is visible rather than silent.
    const max = Math.max(...list.map((b) => b.percent))
    const atMax = list.filter((b) => b.percent === max)
    const excluded = binding(atMax)
    return { helps: false, bucket: null, reason: inapplicabilityReason(excluded, max) }
  }

  const max = Math.max(...applicable.map((b) => b.percent))
  const atMax = applicable.filter((b) => b.percent === max)
  // Decide from the SET of buckets at the maximum, not a single blind pick, then use
  // `binding()` only as a deterministic tie-break within that set. With two buckets tied
  // at the same percentage, an order-dependent pick flipped this function between true
  // and false for identical inputs.
  const winner = binding(atMax)

  if (!modelKnown) {
    return { helps: false, bucket: winner,
      reason: `The binding limit is ${winner.kind} at ${Math.round(max)}%. The current model could not be determined, so no advice is offered.` }
  }

  // Switching helps only if EVERY bucket at the maximum is scoped to the model in use.
  // If any shared bucket is equally exhausted, switching moves you off one ceiling
  // straight onto another. Note a bucket scoped to a DIFFERENT model can never reach
  // `atMax` here — it was already excluded from `applicable` above — so the only way
  // `allOurs` can be false is a shared bucket tying with a scoped one.
  const allOurs = atMax.every((b) => sameModel(b, currentModel))
  if (!allOurs) {
    const blockers = atMax.filter((b) => !sameModel(b, currentModel))
    const blocker = binding(blockers) // same deterministic tie-break, applied to the actual blocker(s)
    return { helps: false, bucket: blocker,
      reason: `The binding limit is ${blocker.kind} at ${Math.round(max)}%, which every model draws on. Switching models would not change it.` }
  }
  return { helps: true, bucket: winner,
    reason: `The binding limit is ${winner.model ?? winner.modelId}'s own weekly allowance at ${Math.round(max)}%. Another model draws on a different allowance, so switching would help right now.` }
}

/**
 * Explains why a bucket was excluded from consideration entirely (see the
 * `applicable.length === 0` branch above) — the one place `switchingHelps` still needs
 * to name a bucket that never got to be a candidate for binding this session. Distinct
 * from the `!allOurs` reason above, which explains why an applicable bucket lost: a
 * bucket reaching this function was inapplicable outright.
 */
function inapplicabilityReason(bucket, max) {
  const label = bucket?.model ?? bucket?.modelId
  if (!label) {
    // Defensive: unreachable in practice (a bucket with neither field is shared, and a
    // shared bucket is always applicable — see isShared/isApplicable), but never assert
    // a claim this function cannot back up.
    return `The binding limit is ${bucket.kind} at ${Math.round(max)}%. Its scope could not be determined.`
  }
  return `The binding limit is scoped to ${label} at ${Math.round(max)}%, which does not apply to the model in use. Switching would not change it.`
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
