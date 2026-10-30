// Prompt counts from ~/.claude/history.jsonl: one line per prompt typed in a
// terminal session. Desktop sessions do not write to it, so it matters most for
// the months before the surviving transcripts begin.
import { isPlausible } from './clock.mjs'

/** @returns {{ [day: string]: { prompts: number, hours: number[] } }} */
export function readHistory(text, clock) {
  const days = {}
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // a half-written last line, or anything else that is not a prompt
    }
    if (record === null || typeof record !== 'object' || !isPlausible(record.timestamp)) continue
    const { day, hour } = clock(record.timestamp)
    const entry = (days[day] ??= { prompts: 0, hours: new Array(24).fill(0) })
    entry.prompts += 1
    entry.hours[hour] += 1
  }
  return days
}
