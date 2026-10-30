import type { View } from '../../types'
import { rankCard, shareCard, stackedCard } from '../charts.mjs'
import { count, dayLabel, monthLabel } from '../format.mjs'
import { withOther } from '../shape.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function work(el: Desktop, view: View) {
  const { Box, Text } = el

  if (view.work === null) {
    return (
      <Box key="work-missing" flexDirection="column" gap={1}>
        <Text>
          This tab shows the mix of work you did: features, fixes, discoveries and so on. It reads the notes the claude-mem plugin keeps
          about each session.
        </Text>
        <Text dimColor>Nothing to show: claude-mem is not installed here, or the sqlite3 command is missing.</Text>
      </Box>
    )
  }

  const types = view.work.types
  const named = types.slice(0, 4).map((each) => each.name)
  const series = types.length > named.length ? [...named, 'Other'] : named
  const months = view.work.byMonth.map((each) => {
    const values: Record<string, number> = {}
    for (const [type, n] of Object.entries(each.types)) {
      const key = named.includes(type) ? type : 'Other'
      values[key] = (values[key] ?? 0) + n
    }
    return { label: monthLabel(each.month), title: monthLabel(each.month), values }
  })
  const total = types.reduce((sum, each) => sum + each.n, 0)
  const since = view.coverage.workFrom === null ? '' : `since ${dayLabel(view.coverage.workFrom)}`

  return (
    <Box flexDirection="column" gap={1}>
      {card(
        el,
        'types',
        shareCard({ eyebrow: 'What the work was', aside: `${count(total)} notes`, parts: withOther(types, 4, (each) => each.n), format: count }),
        `${count(total)} notes from claude-mem in this range, led by ${types[0]?.name ?? 'none'}`,
      )}
      {card(el, 'by-month', stackedCard({ eyebrow: 'By month', aside: since, columns: months, names: series, format: count }), 'Work types per month')}
      {card(el, 'by-project', rankCard({ eyebrow: 'By project', aside: 'notes', rows: view.work.byProject.map((each) => ({ name: each.name, value: each.n })), format: count }), 'Projects ranked by notes')}
    </Box>
  )
}
