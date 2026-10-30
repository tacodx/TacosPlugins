// What the Tips tab sends to a model, and how its answer is read back. Pure.
//
// Only numbers leave the machine. Project names are replaced by placeholders
// before the request is built and put back into the reply; session titles are
// not included at all.
import { modelName } from './format.mjs'
import { busiestHour, lateShare } from './shape.mjs'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const placeholder = (i) => `project-${i + 1}`
const round = (n, digits = 2) => Number(n.toFixed(digits))

export const TIPS_SYSTEM = [
  "You are reading one person's Claude Code usage statistics for a period of time.",
  'Write four to six short observations or suggestions as Markdown bullet points.',
  'Each must be specific, practical, and grounded in a number from the data.',
  'Projects are named project-1, project-2 and so on: refer to them by those names exactly.',
  'Do not invent numbers, do not flatter, and write no introduction or closing line.',
].join(' ')

/**
 * @param {object} view a View from the indexer
 * @returns {{ system: string, prompt: string, restore: (text: string) => string }}
 *   `restore` puts the real project names back into the model's answer
 */
export function tipsRequest(view) {
  const t = view.totals
  const replies = t.msgs + t.subMsgs
  const busiest = busiestHour(view.hours)
  const late = lateShare(view.hours)
  const names = view.projects.map((each) => each.name)

  const data = {
    period: { days: view.range.days, activeDays: t.activeDays, currentStreakDays: t.currentStreak, bestStreakDays: t.bestStreak },
    totals: {
      prompts: t.prompts,
      sessions: t.sessions,
      busyHours: round(t.activeMs / 3_600_000, 1),
      outputTokens: t.out,
      cacheHitRate: t.cacheHitRate === null ? null : round(t.cacheHitRate),
      toolCalls: t.toolCalls,
      shareOfRepliesFromSubagents: replies > 0 ? round(t.subMsgs / replies) : null,
    },
    beforeThisPeriod: view.previous,
    when: {
      busiest: busiest === null ? null : { weekday: WEEKDAYS[busiest.weekday], hour: busiest.hour },
      shareOfPromptsBetween22And05: late === null ? null : round(late),
    },
    projects: view.projects.map((each, i) => ({ name: placeholder(i), prompts: each.prompts, sessions: each.sessions, outputTokens: each.out })),
    models: view.models.map((each) => ({ name: modelName(each.name), replies: each.msgs, outputTokens: each.out })),
    effortLevels: view.efforts,
    tools: view.tools,
    skills: view.skills,
    workTypes: view.work === null ? null : view.work.types,
  }

  return {
    system: TIPS_SYSTEM,
    prompt: JSON.stringify(data),
    restore: (text) =>
      text.replace(/project-(\d+)/g, (whole, number) => {
        const i = Number(number) - 1
        return i >= 0 && i < names.length ? names[i] : whole
      }),
  }
}
