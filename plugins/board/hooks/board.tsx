import type { ElementTable } from 'claude-code'

import type { View } from '../types'
import { hoursCard, kpiCard, listCard, planCard, stackedCard, textCard } from './charts.mjs'
import { altTexts, dayColumns, hourColumns, kpiItems, planInput, projectSeries, sessionsCard } from './shape.mjs'

export type Desktop = ElementTable<'desktop'>

/**
 * One drawing of the pane. `id` lets a test find it; `alt` is what the drawing
 * says, for whoever cannot see it.
 */
function card(el: Desktop, id: string, source: string, alt: string) {
  const { Box, Svg } = el

  return (
    <Box key={`card-${id}`}>
      <Svg source={source} alt={alt} isInteractive />
    </Box>
  )
}

/** The five cards, top to bottom: today's figures, the hours, the projects, the sessions, the plan. */
export function board(el: Desktop, view: View) {
  const { Box } = el
  const alt = altTexts(view)
  const plan = planInput(view)

  return (
    <Box key="cards" flexDirection="column" gap={1}>
      {card(el, 'kpis', kpiCard(kpiItems(view)), alt.kpis)}
      {card(el, 'hours', hoursCard({ eyebrow: 'Commits per hour', aside: 'last 30 hours', columns: hourColumns(view), unit: 'commit' }), alt.hours)}
      {card(el, 'projects', stackedCard({ eyebrow: 'Commits per project', aside: 'last 7 days', columns: dayColumns(view), series: projectSeries(view), unit: 'commit' }), alt.projects)}
      {card(el, 'sessions', listCard(sessionsCard(view)), alt.sessions)}
      {card(
        el,
        'plan',
        plan.kind === 'rows'
          ? planCard({ eyebrow: 'The plan', aside: plan.aside ?? '', rows: plan.rows ?? [] })
          : textCard({ eyebrow: 'The plan', aside: plan.aside ?? '', lines: plan.lines ?? [] }),
        alt.plan,
      )}
    </Box>
  )
}
