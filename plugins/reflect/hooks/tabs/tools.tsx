import type { Ranked, View } from '../../types'
import { rankBars } from '../charts.mjs'
import { count, percent, plural } from '../format.mjs'
import { chart, pair, tile } from './parts.tsx'
import type { Desktop } from './parts.tsx'

const rows = (list: Ranked[]) => list.map((each) => ({ name: each.name, value: each.n }))

export function tools(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const replies = t.msgs + t.subMsgs
  const first = view.tools[0]

  return (
    <Box flexDirection="column" gap={1}>
      {pair(
        el,
        tile(el, 'calls', 'Tool calls', count(t.toolCalls), first !== undefined && t.toolCalls > 0 ? `${first.name} is ${percent(first.n / t.toolCalls)} of them` : 'none yet'),
        tile(el, 'subagents', 'Subagent share', replies > 0 ? percent(t.subMsgs / replies) : 'n/a', `of ${plural(replies, 'reply', 'replies')}`),
      )}
      {chart(el, 'tools', 'Most used tools', rankBars(rows(view.tools), count), `The most used tools, of ${count(t.toolCalls)} calls`)}
      {chart(el, 'skills', 'Skills', rankBars(rows(view.skills), count), 'Skills ranked by how often they were loaded')}
      {chart(el, 'mcp', 'MCP servers', rankBars(rows(view.mcp), count), 'MCP servers ranked by calls to their tools')}
    </Box>
  )
}
