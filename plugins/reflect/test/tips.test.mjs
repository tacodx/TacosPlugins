import { test } from 'node:test'
import assert from 'node:assert/strict'

import { observations } from '../hooks/notes.mjs'
import { tipsRequest } from '../hooks/tips.mjs'

const hours = () => {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0))
  grid[0][16] = 6
  grid[4][23] = 4
  return grid
}

/** A View with twelve projects whose names must never leave the machine. */
function view(over = {}) {
  return {
    range: { id: '30d', from: '2026-02-09', to: '2026-03-10', days: 30 },
    totals: {
      prompts: 200, activeDays: 20, sessions: 30, desktopSessions: 25, cliSessions: 5, toolCalls: 900, projects: 12,
      activeMs: 36_000_000, out: 1_000_000, inp: 1000, cacheR: 97_000, cacheW: 2000, msgs: 100, subMsgs: 300,
      cacheHitRate: 0.97, currentStreak: 4, bestStreak: 9,
    },
    hours: hours(),
    projects: Array.from({ length: 12 }, (_, i) => ({ name: `secret-client-${i + 1}`, prompts: 20 - i, sessions: 3, out: 600_000 / (i + 1) })),
    models: [{ name: 'claude-opus-5-5', msgs: 300, out: 800_000, inp: 0, cacheR: 0, cacheW: 0 }],
    tools: [{ name: 'Bash', n: 700 }],
    skills: [{ name: 'superpowers:brainstorming', n: 5 }],
    efforts: [{ name: 'high', n: 10 }],
    sessions: { longest: [{ title: 'Private session title', project: 'secret-client-1', start: 0, activeMs: 7_200_000, prompts: 9 }], mostPrompts: [] },
    work: { types: [{ name: 'feature', n: 12 }], byMonth: [], byProject: [{ name: 'secret-client-1', n: 12, types: { feature: 12 } }] },
    previous: { prompts: 100, sessions: 10, out: 400_000, activeMs: 1000 },
    ...over,
  }
}

test('the request carries numbers and placeholders, never a project name or a session title', () => {
  const { system, prompt } = tipsRequest(view())

  assert.ok(!prompt.includes('secret-client'))
  assert.ok(!prompt.includes('Private session title'))
  assert.ok(!system.includes('secret-client'))
  const sent = JSON.parse(prompt)
  assert.equal(sent.projects.length, 12)
  assert.deepEqual(sent.projects[0], { name: 'project-1', prompts: 20, sessions: 3, outputTokens: 600_000 })
  assert.equal(sent.totals.outputTokens, 1_000_000)
  assert.equal(sent.totals.shareOfRepliesFromSubagents, 0.75)
  assert.deepEqual(sent.when, { busiest: { weekday: 'Monday', hour: 16 }, shareOfPromptsBetween22And05: 0.4 })
  assert.deepEqual(sent.models, [{ name: 'Opus 5.5', replies: 300, outputTokens: 800_000 }])
})

test('the reply gets its project names back, the right one for each number', () => {
  const { restore } = tipsRequest(view())

  assert.equal(
    restore('- project-1 leads; project-12 trails project-2. project-99 is not one of yours.'),
    '- secret-client-1 leads; secret-client-12 trails secret-client-2. project-99 is not one of yours.',
  )
})

test('a view with nothing in it still makes a request', () => {
  const empty = view({ hours: Array.from({ length: 7 }, () => new Array(24).fill(0)), projects: [], work: null, previous: null })
  empty.totals = { ...empty.totals, msgs: 0, subMsgs: 0, cacheHitRate: null }

  const sent = JSON.parse(tipsRequest(empty).prompt)

  assert.deepEqual(sent.when, { busiest: null, shareOfPromptsBetween22And05: null })
  assert.equal(sent.totals.shareOfRepliesFromSubagents, null)
  assert.equal(sent.workTypes, null)
})

test('the plain observations each state a number from the view', () => {
  const lines = observations(view())

  assert.deepEqual(lines, [
    'You prompt most on Mondays around 16:00 (6 prompts).',
    '40% of your prompts were typed between 22:00 and 05:00.',
    'You were active on 20 of 30 days, about 10 prompts on an active day.',
    'Subagents wrote 75% of all replies: for each one in your own sessions, 3.0 came from agents working for it.',
    '97% of what Claude read came from the prompt cache (97K tokens).',
    'secret-client-1 took 60% of all output tokens, across 3 sessions.',
    'Opus 5.5 wrote 80% of the output (800K tokens).',
    'Your busiest session ran for 2.0 h: "Private session title".',
  ])
})

test('observations say nothing they have no number for', () => {
  const empty = view({ hours: Array.from({ length: 7 }, () => new Array(24).fill(0)), projects: [], models: [], sessions: { longest: [], mostPrompts: [] } })
  empty.totals = { ...empty.totals, prompts: 0, activeDays: 0, msgs: 0, subMsgs: 0, cacheHitRate: null, out: 0 }

  assert.deepEqual(observations(empty), [])
})
