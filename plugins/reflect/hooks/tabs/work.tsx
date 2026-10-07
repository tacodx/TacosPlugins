import type { View } from '../../types'
import { rankBars, shareBar, stackedColumnChart } from '../charts.mjs'
import { count, dayLabel, monthLabel } from '../format.mjs'
import { withOther } from '../shape.mjs'
import { chart } from './parts.tsx'
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

  return (
    <Box flexDirection="column" gap={1}>
      <Box key="work-count">
        <Text dimColor>
          {`${count(total)} notes from claude-mem in this range${view.coverage.workFrom === null ? '' : `, which it has kept since ${dayLabel(view.coverage.workFrom)}`}.`}
        </Text>
      </Box>
      {chart(el, 'types', 'What the work was', shareBar(withOther(types, 4, (each) => each.n), count), `The mix of work types, led by ${types[0]?.name ?? 'none'}`)}
      {chart(el, 'by-month', 'By month', stackedColumnChart(months, series, count), 'Work types per month')}
      {chart(el, 'by-project', 'By project', rankBars(view.work.byProject.map((each) => ({ name: each.name, value: each.n })), count), 'Projects ranked by notes')}
    </Box>
  )
}
