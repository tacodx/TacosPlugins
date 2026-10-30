import type { View } from '../../types'
import { heroCard, hourCard, rankCard, shareCard, statCard } from '../charts.mjs'
import { change, count, dayLabel, duration, modelName, percent, plural, tokens } from '../format.mjs'
import { busiestHour, columnsOf, isComparable, withOther } from '../shape.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function overview(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const replies = t.msgs + t.subMsgs
  const top = view.models[0]
  const busiest = busiestHour(view.hours)
  const before = isComparable(view) ? view.previous : null
  const moved = before === null ? null : change(t.out, before.out)
  const promptsMoved = before === null ? null : change(t.prompts, before.prompts)
  // Tokens exist only where transcripts do: no months of empty axis before them.
  const since = view.coverage.transcriptsFrom
  const tokenDays = since === null ? view.days : view.days.filter((each) => each.day >= since)
  const perDay = columnsOf(tokenDays, (each) => ({ out: each.out })).map((each) => ({ ...each, value: each.values.out ?? 0 }))

  return (
    <Box flexDirection="column" gap={1}>
      {card(
        el,
        'hero',
        heroCard({
          eyebrow: 'Output tokens',
          aside: `${dayLabel(tokenDays[0]?.day ?? view.range.from)} – ${dayLabel(view.range.to)}`,
          figure: tokens(t.out),
          unit: 'output tokens',
          note: moved === null ? '' : `${moved} on the ${view.range.days} days before`,
          columns: perDay,
          format: tokens,
        }),
        `${tokens(t.out)} output tokens from ${view.range.from} to ${view.range.to}${moved === null ? '' : `, ${moved} on the ${view.range.days} days before`}`,
      )}
      {card(
        el,
        'stats',
        statCard([
          { label: 'Prompts', figure: count(t.prompts), note: promptsMoved === null ? plural(t.activeDays, 'active day') : `${promptsMoved} on the days before` },
          { label: 'Sessions', figure: count(t.sessions), note: `${count(t.desktopSessions)} desktop · ${count(t.cliSessions)} terminal` },
          { label: 'Busy time', figure: duration(t.activeMs), note: 'at work, attended or not' },
          { label: 'Streak', figure: plural(t.currentStreak, 'day'), note: `best ${plural(t.bestStreak, 'day')}` },
          { label: 'Cache hit rate', figure: t.cacheHitRate === null ? 'n/a' : percent(t.cacheHitRate), note: `${tokens(t.cacheR)} read from cache` },
          { label: 'Subagent share', figure: replies > 0 ? percent(t.subMsgs / replies) : 'n/a', note: `of ${plural(replies, 'reply', 'replies')}` },
        ]),
        `${count(t.prompts)} prompts, ${count(t.sessions)} sessions, ${duration(t.activeMs)} of busy time, a streak of ${plural(t.currentStreak, 'day')}`,
      )}
      {card(
        el,
        'hours',
        hourCard({
          eyebrow: 'When you prompt',
          aside: busiest === null ? '' : `peak ${WEEKDAYS[busiest.weekday]} ${String(busiest.hour).padStart(2, '0')}:00`,
          hours: view.hours,
        }),
        `Prompts by weekday and hour, ${count(t.prompts)} in all`,
      )}
      {card(
        el,
        'projects',
        rankCard({
          eyebrow: 'Top projects',
          aside: 'output tokens',
          rows: view.projects.slice(0, 5).map((each) => ({ name: each.name, value: each.out })),
          format: tokens,
        }),
        `The ${Math.min(5, view.projects.length)} projects with the most output tokens, of ${t.projects}`,
      )}
      {card(
        el,
        'models',
        shareCard({
          eyebrow: 'Models',
          aside: 'output tokens',
          parts: withOther(view.models, 4, (each) => each.out, (each) => modelName(each.name)),
          format: tokens,
        }),
        `Share of output tokens by model, led by ${top !== undefined ? modelName(top.name) : 'none'}`,
      )}
    </Box>
  )
}
