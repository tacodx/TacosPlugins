import type { SessionBrief, View } from '../../types'
import { calendarChart, columnChart } from '../charts.mjs'
import { count, dayLabel, duration, percent, plural } from '../format.mjs'
import { busiestHour, calendarOf, columnsOf, lateShare } from '../shape.mjs'
import { chart, lines, pair, tile } from './parts.tsx'
import type { Desktop } from './parts.tsx'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const sessionLine = (each: SessionBrief) =>
  `${each.title ?? 'Untitled'} · ${each.project} · ${duration(each.activeMs)} · ${plural(each.prompts, 'prompt')}`

export function activity(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const busiest = busiestHour(view.hours)
  const late = lateShare(view.hours)
  const prompts = columnsOf(view.days, (each) => ({ n: each.prompts })).map((each) => ({ ...each, value: each.values.n ?? 0 }))
  const sessions = columnsOf(view.days, (each) => ({ n: each.sessions })).map((each) => ({ ...each, value: each.values.n ?? 0 }))

  return (
    <Box flexDirection="column" gap={1}>
      {pair(
        el,
        tile(el, 'active-days', 'Active days', count(t.activeDays), `of ${count(view.range.days)} in this range`),
        tile(el, 'streak', 'Streak', plural(t.currentStreak, 'day'), `best ${plural(t.bestStreak, 'day')}`),
      )}
      {pair(
        el,
        tile(el, 'busiest', 'Busiest hour', busiest === null ? 'n/a' : `${WEEKDAYS[busiest.weekday].slice(0, 3)} ${String(busiest.hour).padStart(2, '0')}:00`, busiest === null ? 'no prompts yet' : plural(busiest.n, 'prompt')),
        tile(el, 'late', 'Late prompts', late === null ? 'n/a' : percent(late), 'between 22:00 and 05:00'),
      )}
      {chart(el, 'calendar', 'Prompts per day', calendarChart(calendarOf(view.days), 'prompts'), `A calendar of prompts per day since ${dayLabel(view.range.from)}, ${count(t.prompts)} in all`)}
      {chart(el, 'prompts', 'Prompts over time', columnChart(prompts, count, 'prompts'), `Prompts over time, ${count(t.prompts)} in all`)}
      {chart(el, 'sessions', 'Sessions at work per day', columnChart(sessions, count, 'sessions'), `Sessions with activity per day, ${count(t.sessions)} started in this range`)}
      {lines(el, 'longest', 'Longest sessions', view.sessions.longest.length > 0 ? view.sessions.longest.map(sessionLine) : ['None in this range.'])}
      {lines(el, 'most-prompts', 'Most prompts in one session', view.sessions.mostPrompts.length > 0 ? view.sessions.mostPrompts.map(sessionLine) : ['None in this range.'])}
    </Box>
  )
}
