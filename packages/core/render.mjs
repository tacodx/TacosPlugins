import { STATE } from './decide.mjs'

export function formatMoney(usedMinor, limitMinor, currency, decimals = 2) {
  const f = (v) => (decimals > 0 ? (v / 10 ** decimals).toFixed(decimals) : String(v))
  return `${currency} ${f(usedMinor)} / ${f(limitMinor)}`
}

export function bar(percent, width = 14) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  const filled = Math.round((clamped / 100) * width)
  return '='.repeat(filled) + '.'.repeat(width - filled)
}

export function renderStatus({ gauges, thresholds, decision, mode, blind, reason }) {
  const lines = [`usage-guard  [mode: ${mode}]`, '']
  if (blind || !gauges) {
    lines.push(`  no usage data available (${reason || 'unknown'})`)
    lines.push('  the guard is blind and is allowing everything.')
    return lines.join('\n')
  }
  for (const [name, limit] of Object.entries(thresholds)) {
    if (name === 'scoped') continue
    const g = gauges[name]
    if (!g) { lines.push(`  ${name.padEnd(12)} not reported by this account`); continue }
    const money = g.usedMinor != null
      ? `  (${formatMoney(g.usedMinor, g.limitMinor, g.currency, g.decimals)})` : ''
    lines.push(`  ${name.padEnd(12)} [${bar(g.percent)}] ${String(Math.round(g.percent)).padStart(3)}%` +
      `  soft ${limit.soft} / hard ${limit.hard}${money}`)
    if (g.resetsAt) lines.push(`  ${''.padEnd(12)} resets ${g.resetsAt}`)
  }
  for (const s of gauges.scoped || []) {
    lines.push(`  ${`scoped:${s.model}`.padEnd(12)} [${bar(s.percent)}] ${String(Math.round(s.percent)).padStart(3)}%  (informational)`)
  }
  lines.push('')
  const state = decision?.state ?? STATE.OK
  if (state === STATE.OK) lines.push('  decision: allow — below every soft threshold.')
  else if (state === STATE.SOFT) lines.push(`  decision: advise — ${decision.gauge} at ${decision.percent}% (soft ${decision.soft}). New fan-out would be declined.`)
  else lines.push(`  decision: deny — ${decision.gauge} at ${decision.percent}% (ceiling ${decision.hard}).`)
  return lines.join('\n')
}
