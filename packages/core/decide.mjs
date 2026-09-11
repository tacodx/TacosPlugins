export const STATE = { OK: 'ok', SOFT: 'soft', HARD: 'hard' }

const RANK = { ok: 0, soft: 1, hard: 2 }

const NONE = Object.freeze({
  state: STATE.OK, gauge: null, percent: null, soft: null, hard: null, resetsAt: null,
})

/**
 * Pure. Returns the most severe state across all governed gauges.
 * Anything unrecognised, null, or non-numeric is skipped — never treated as 0 or as a block.
 */
export function decide(gauges, thresholds) {
  if (!gauges || !thresholds) return NONE
  let worst = NONE
  for (const [name, limit] of Object.entries(thresholds)) {
    const gauge = gauges[name]
    if (!gauge || typeof gauge.percent !== 'number' || Number.isNaN(gauge.percent)) continue
    if (!limit || typeof limit.soft !== 'number' || typeof limit.hard !== 'number') continue

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
