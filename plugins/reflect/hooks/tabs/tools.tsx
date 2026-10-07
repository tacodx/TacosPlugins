import type { Ranked, View } from '../../types'
import { rankBars } from '../charts.mjs'
import { count, percent, plural } from '../format.mjs'
import { chart, pair, tile } from './parts.tsx'
import type { Desktop } from './parts.tsx'

// A tool of an MCP server is named mcp__<server>__<tool>, and a skill <plugin>:<skill>.
// Both lead with the part that is the same down the whole list.
const short = (name: string) => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp !== null) return `${mcp[1]}: ${mcp[2]}`
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
}
const rows = (list: Ranked[]) => list.map((each) => ({ name: each.name, label: short(each.name), value: each.n }))

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
