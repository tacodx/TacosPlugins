import type { View } from '../../types'
import { columnChart, hourGrid, rankBars, shareBar } from '../charts.mjs'
import { change, count, duration, modelName, percent, plural, tokens } from '../format.mjs'
import { columnsOf, withOther } from '../shape.mjs'
import { chart, pair, tile } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function overview(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const replies = t.msgs + t.subMsgs
  const top = view.models[0]
  const moved = view.previous === null ? null : change(t.prompts, view.previous.prompts)
  // Tokens exist only where transcripts do: no months of empty axis before them.
  const since = view.coverage.transcriptsFrom
  const tokenDays = since === null ? view.days : view.days.filter((each) => each.day >= since)
  const perDay = columnsOf(tokenDays, (each) => ({ out: each.out })).map((each) => ({ ...each, value: each.values.out ?? 0 }))

  return (
    <Box flexDirection="column" gap={1}>
      {pair(
        el,
        tile(el, 'prompts', 'Prompts', count(t.prompts), moved === null ? plural(t.activeDays, 'active day') : `${moved} on the ${view.range.days} days before`),
        tile(el, 'sessions', 'Sessions', count(t.sessions), `${count(t.desktopSessions)} desktop · ${count(t.cliSessions)} terminal`),
      )}
      {pair(
        el,
        tile(el, 'out', 'Output tokens', tokens(t.out), top !== undefined && t.out > 0 ? `${modelName(top.name)} wrote ${percent(top.out / t.out)}` : 'none yet'),
        tile(el, 'busy', 'Busy time', duration(t.activeMs), 'sessions at work, attended or not'),
      )}
      {pair(
        el,
        tile(el, 'streak', 'Streak', plural(t.currentStreak, 'day'), `best ${plural(t.bestStreak, 'day')}`),
        tile(el, 'cache', 'Cache hit rate', t.cacheHitRate === null ? 'n/a' : percent(t.cacheHitRate), `${tokens(t.cacheR)} read from cache`),
      )}
      {pair(
        el,
        tile(el, 'subagents', 'Subagent share', replies > 0 ? percent(t.subMsgs / replies) : 'n/a', `of ${plural(replies, 'reply', 'replies')}`),
        tile(el, 'tools', 'Tool calls', count(t.toolCalls), view.tools[0] !== undefined ? `${view.tools[0].name} ${count(view.tools[0].n)}` : 'none yet'),
      )}
      {chart(el, 'tokens', 'Output tokens per day', columnChart(perDay, tokens, 'output tokens'), `Output tokens over time, ${tokens(t.out)} in all`)}
      {chart(el, 'hours', 'When you prompt', hourGrid(view.hours), `Prompts by weekday and hour, ${count(t.prompts)} in all`)}
      {chart(
        el,
        'projects',
        'Top projects by output tokens',
        rankBars(view.projects.slice(0, 5).map((each) => ({ name: each.name, value: each.out })), tokens),
        `The ${Math.min(5, view.projects.length)} projects with the most output tokens, of ${t.projects}`,
      )}
      {chart(
        el,
        'models',
        'Models by output tokens',
        shareBar(withOther(view.models, 4, (each) => each.out, (each) => modelName(each.name)), tokens),
        `Share of output tokens by model, led by ${top !== undefined ? modelName(top.name) : 'none'}`,
      )}
    </Box>
  )
}
