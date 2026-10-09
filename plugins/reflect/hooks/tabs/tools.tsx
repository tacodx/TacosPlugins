import type { Ranked, View } from '../../types'
import { rankCard, statCard } from '../charts.mjs'
import { count, percent, plural } from '../format.mjs'
import { card } from './parts.tsx'
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
      {card(
        el,
        'stats',
        statCard([
          { label: 'Tool calls', figure: count(t.toolCalls), note: first !== undefined && t.toolCalls > 0 ? `${percent(first.n / t.toolCalls)} of them ${first.name}` : 'none yet' },
          { label: 'Subagent share', figure: replies > 0 ? percent(t.subMsgs / replies) : 'n/a', note: `of ${plural(replies, 'reply', 'replies')}` },
        ]),
        `${count(t.toolCalls)} tool calls`,
      )}
      {card(el, 'tools', rankCard({ eyebrow: 'Most used tools', aside: 'calls', rows: rows(view.tools), format: count }), `The most used tools, of ${count(t.toolCalls)} calls`)}
      {card(el, 'skills', rankCard({ eyebrow: 'Skills', aside: 'times loaded', rows: rows(view.skills), format: count }), 'Skills ranked by how often they were loaded')}
      {card(el, 'mcp', rankCard({ eyebrow: 'MCP servers', aside: 'calls', rows: rows(view.mcp), format: count }), 'MCP servers ranked by calls to their tools')}
    </Box>
  )
}
