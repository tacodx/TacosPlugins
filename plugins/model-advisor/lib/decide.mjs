export const STATE = { OK: 'ok', SOFT: 'soft', HARD: 'hard' }

const RANK = { ok: 0, soft: 1, hard: 2 }

const NONE = Object.freeze({
  state: STATE.OK, gauge: null, percent: null, soft: null, hard: null, resetsAt: null,
})

/**
 * True only when resetsAt parses to a real, positive instant that has already passed.
 * A missing or unparseable resetsAt must never disable a gauge — that would be worse
 * than the bug this guards against, silencing enforcement on any gauge the account
 * simply didn't report a reset time for.
 *
 * Only strings and numbers are accepted as timestamp representations (an ISO string or
 * epoch millis). Everything else — including booleans — is rejected outright: `new
 * Date(false)` and `new Date(0)` both resolve to the Unix epoch, which is always
 * `<= now`, so treating `resetsAt: 0` or `resetsAt: false` as "parses to a time" would
 * silently disable the gauge every time. Requiring `t > 0` on top closes that for any
 * other falsy-but-parseable input (`''`, `NaN`) without special-casing each one.
 */
function hasResetInPast(resetsAt, now) {
  if (typeof resetsAt !== 'string' && typeof resetsAt !== 'number') return false
  const t = new Date(resetsAt).getTime()
  return Number.isFinite(t) && t > 0 && t <= now
}

/**
 * Pure. Returns the most severe state across all governed gauges.
 * Anything unrecognised, null, or non-numeric is skipped — never treated as 0 or as a block.
 * `now` defaults to Date.now() but is injectable so callers (and tests) can pass a fixed
 * instant; a stale cached reading whose own resetsAt has already passed is skipped
 * entirely, since the window it describes is known to have already rolled over.
 */
export function decide(gauges, thresholds, now = Date.now()) {
  if (!gauges || !thresholds) return NONE
  let worst = NONE
  for (const [name, limit] of Object.entries(thresholds)) {
    const gauge = gauges[name]
    if (!gauge || typeof gauge.percent !== 'number' || Number.isNaN(gauge.percent)) continue
    if (!limit) continue
    if (limit.enforce === false) continue // watch-only: still rendered, but never decides
    if (typeof limit.soft !== 'number' || Number.isNaN(limit.soft)) continue
    if (typeof limit.hard !== 'number' || Number.isNaN(limit.hard)) continue
    if (hasResetInPast(gauge.resetsAt, now)) continue // window already rolled over: this reading is known-invalid

    let state = STATE.OK
    if (gauge.percent >= limit.hard) state = STATE.HARD
    else if (gauge.percent >= limit.soft) state = STATE.SOFT
    if (RANK[state] <= RANK[worst.state]) continue

    worst = {
      state,
      gauge: name,
      percent: gauge.percent,
      soft: limit.soft,
      hard: limit.hard,
      resetsAt: gauge.resetsAt ?? null,
    }
  }
  return worst
}
