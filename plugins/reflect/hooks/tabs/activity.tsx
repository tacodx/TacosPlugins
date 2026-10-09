import type { SessionBrief, View } from '../../types'
import { calendarCard, columnCard, statCard, textCard } from '../charts.mjs'
import { count, dayLabel, duration, percent, plural } from '../format.mjs'
import { busiestHour, calendarOf, columnsOf, lateShare } from '../shape.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const sessionLine = (each: SessionBrief) =>
  `${each.title ?? 'Untitled'} — ${each.project}, ${duration(each.activeMs)}, ${plural(each.prompts, 'prompt')}`

export function activity(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const busiest = busiestHour(view.hours)
  const late = lateShare(view.hours)
  const prompts = columnsOf(view.days, (each) => ({ n: each.prompts })).map((each) => ({ ...each, value: each.values.n ?? 0 }))
  const sessions = columnsOf(view.days, (each) => ({ n: each.sessions })).map((each) => ({ ...each, value: each.values.n ?? 0 }))

  return (
    <Box flexDirection="column" gap={1}>
      {card(
        el,
        'stats',
        statCard([
          { label: 'Active days', figure: count(t.activeDays), note: `of ${count(view.range.days)} in this range` },
          { label: 'Streak', figure: plural(t.currentStreak, 'day'), note: `best ${plural(t.bestStreak, 'day')}` },
          {
            label: 'Busiest hour',
            figure: busiest === null ? 'n/a' : `${WEEKDAYS[busiest.weekday]} ${String(busiest.hour).padStart(2, '0')}:00`,
            note: busiest === null ? 'no prompts yet' : plural(busiest.n, 'prompt'),
          },
          { label: 'Late prompts', figure: late === null ? 'n/a' : percent(late), note: 'between 22:00 and 05:00' },
        ]),
        `Active on ${count(t.activeDays)} of ${count(view.range.days)} days, a streak of ${plural(t.currentStreak, 'day')}`,
      )}
      {/* Under eight weeks a calendar is a small square in a wide card; the columns below say the same. */}
      {view.days.length >= 56 &&
        card(
          el,
          'calendar',
          calendarCard({ eyebrow: 'Prompts per day', aside: `since ${dayLabel(view.days.slice(-371)[0]?.day ?? view.range.from)}`, calendar: calendarOf(view.days), unit: 'prompts' }),
          `A calendar of prompts per day, ${count(t.prompts)} in all`,
        )}
      {card(el, 'prompts', columnCard({ eyebrow: 'Prompts over time', columns: prompts, format: count, unit: 'prompts' }), `Prompts over time, ${count(t.prompts)} in all`)}
      {card(
        el,
        'sessions',
        columnCard({ eyebrow: 'Sessions at work', columns: sessions, format: count, unit: 'sessions at work' }),
        `Sessions with activity over time, ${count(t.sessions)} started in this range`,
      )}
      {card(el, 'longest', textCard({ eyebrow: 'Longest sessions', lines: view.sessions.longest.map(sessionLine) }), 'The sessions that were at work longest')}
      {card(el, 'most-prompts', textCard({ eyebrow: 'Most prompts in one session', lines: view.sessions.mostPrompts.map(sessionLine) }), 'The sessions with the most prompts')}
    </Box>
  )
}
