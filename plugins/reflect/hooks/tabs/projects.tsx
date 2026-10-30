import type { View } from '../../types'
import { rankCard } from '../charts.mjs'
import { count, plural, tokens } from '../format.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function projects(el: Desktop, view: View) {
  const { Box } = el
  const ranked = (valueOf: (each: View['projects'][number]) => number) =>
    [...view.projects]
      .sort((a, b) => valueOf(b) - valueOf(a))
      .filter((each) => valueOf(each) > 0)
      .map((each) => ({ name: each.name, value: valueOf(each) }))
  const all = plural(view.totals.projects, 'project')
  // The view carries the dozen with the most output; say so when there are more.
  const aside = view.totals.projects > view.projects.length ? `top ${view.projects.length} of ${view.totals.projects}` : all

  return (
    <Box flexDirection="column" gap={1}>
      {card(el, 'by-tokens', rankCard({ eyebrow: 'By output tokens', aside, rows: ranked((each) => each.out), format: tokens }), `${all} in this range, ranked by output tokens, ${view.projects[0]?.name ?? 'none'} first`)}
      {card(el, 'by-prompts', rankCard({ eyebrow: 'By prompts', rows: ranked((each) => each.prompts), format: count }), 'Projects ranked by prompts')}
      {card(el, 'by-sessions', rankCard({ eyebrow: 'By sessions started', rows: ranked((each) => each.sessions), format: count }), 'Projects ranked by sessions started')}
    </Box>
  )
}
