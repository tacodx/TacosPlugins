import type { View } from '../../types'
import { rankBars } from '../charts.mjs'
import { count, plural, tokens } from '../format.mjs'
import { chart } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function projects(el: Desktop, view: View) {
  const { Box, Text } = el
  const ranked = (valueOf: (each: View['projects'][number]) => number) =>
    [...view.projects]
      .sort((a, b) => valueOf(b) - valueOf(a))
      .filter((each) => valueOf(each) > 0)
      .map((each) => ({ name: each.name, value: valueOf(each) }))
  const shown = view.projects.length

  return (
    <Box flexDirection="column" gap={1}>
      <Box key="projects-count">
        <Text dimColor>
          {view.totals.projects > shown
            ? `${plural(view.totals.projects, 'project')} in this range; the ${shown} with the most output are shown.`
            : `${plural(view.totals.projects, 'project')} in this range.`}
        </Text>
      </Box>
      {chart(el, 'by-tokens', 'By output tokens', rankBars(ranked((each) => each.out), tokens), `Projects ranked by output tokens, ${view.projects[0]?.name ?? 'none'} first`)}
      {chart(el, 'by-prompts', 'By prompts', rankBars(ranked((each) => each.prompts), count), 'Projects ranked by prompts')}
      {chart(el, 'by-sessions', 'By sessions started', rankBars(ranked((each) => each.sessions), count), 'Projects ranked by sessions started')}
    </Box>
  )
}
