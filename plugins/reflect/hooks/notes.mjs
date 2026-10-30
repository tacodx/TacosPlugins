// Plain observations read straight off a View: no model, nothing sent anywhere. Pure.
import { count, duration, modelName, percent, tokens } from './format.mjs'
import { busiestHour, lateShare } from './shape.mjs'

const WEEKDAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays']

/** A handful of sentences, each one true of the range and each with its number. */
export function observations(view) {
  const t = view.totals
  const lines = []
  const replies = t.msgs + t.subMsgs

  const busiest = busiestHour(view.hours)
  if (busiest !== null) {
    lines.push(`You prompt most on ${WEEKDAYS[busiest.weekday]} around ${String(busiest.hour).padStart(2, '0')}:00 (${count(busiest.n)} prompts).`)
  }
  const late = lateShare(view.hours)
  if (late !== null && late >= 0.1) {
    lines.push(`${percent(late)} of your prompts were typed between 22:00 and 05:00.`)
  }
  if (t.activeDays > 0) {
    lines.push(`You were active on ${count(t.activeDays)} of ${count(view.range.days)} days, about ${count(t.prompts / t.activeDays)} prompts on an active day.`)
  }
  if (replies > 0 && t.subMsgs > 0) {
    lines.push(`Subagents wrote ${percent(t.subMsgs / replies)} of all replies: for each one in your own sessions, ${(t.subMsgs / Math.max(1, t.msgs)).toFixed(1)} came from agents working for it.`)
  }
  if (t.cacheHitRate !== null) {
    lines.push(`${percent(t.cacheHitRate)} of what Claude read came from the prompt cache (${tokens(t.cacheR)} tokens).`)
  }
  const top = view.projects[0]
  if (top !== undefined && t.out > 0) {
    lines.push(`${top.name} took ${percent(top.out / t.out)} of all output tokens, across ${count(top.sessions)} sessions.`)
  }
  const model = view.models[0]
  if (model !== undefined && t.out > 0) {
    lines.push(`${modelName(model.name)} wrote ${percent(model.out / t.out)} of the output (${tokens(model.out)} tokens).`)
  }
  const longest = view.sessions.longest[0]
  if (longest !== undefined && longest.activeMs > 0) {
    lines.push(`Your busiest session ran for ${duration(longest.activeMs)}${longest.title ? `: "${longest.title}"` : ''}.`)
  }
  return lines
}
