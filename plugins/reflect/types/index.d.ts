// The values this mod keeps in $.state, and the shape of what the indexer prints.

export type RangeId = '7d' | '30d' | '90d' | 'all'

export type TabId = 'overview' | 'activity' | 'projects' | 'models' | 'tools' | 'work' | 'tips'

export type Status = 'idle' | 'loading' | 'ready' | 'error'

export type Ranked = { name: string; n: number }

export type SessionBrief = { title: string | null; project: string; start: number; activeMs: number; prompts: number }

/** What `indexer/cli.mjs view` prints. Defined by `indexer/query.mjs`. */
export type View = {
  version: 1
  generatedAt: string
  range: { id: RangeId; from: string; to: string; days: number }
  coverage: { transcriptsFrom: string | null; historyFrom: string | null; workFrom: string | null }
  totals: {
    prompts: number
    activeDays: number
    sessions: number
    desktopSessions: number
    cliSessions: number
    toolCalls: number
    projects: number
    activeMs: number
    out: number
    inp: number
    cacheR: number
    cacheW: number
    msgs: number
    subMsgs: number
    cacheHitRate: number | null
    currentStreak: number
    bestStreak: number
  }
  days: { day: string; prompts: number; out: number; sessions: number; models: Record<string, number> }[]
  hours: number[][]
  projects: { name: string; prompts: number; out: number; sessions: number }[]
  models: { name: string; msgs: number; out: number; inp: number; cacheR: number; cacheW: number }[]
  tools: Ranked[]
  skills: Ranked[]
  mcp: Ranked[]
  efforts: Ranked[]
  sessions: { longest: SessionBrief[]; mostPrompts: SessionBrief[] }
  work: null | {
    types: Ranked[]
    byMonth: { month: string; types: Record<string, number> }[]
    byProject: { name: string; n: number; types: Record<string, number> }[]
  }
  previous: { prompts: number; sessions: number; out: number; activeMs: number } | null
  notes: string[]
}

/** The model-written reading of a View. `for` names the range and day it was written for. */
export type Tips = {
  status: Status
  for: string | null
  text: string | null
  tokens: number | null
}

declare module 'claude-code' {
  interface PluginState {
    reflect: {
      status: Status
      view: View | null
      error: string | null
      range: RangeId
      tab: TabId
      tips: Tips
    }
  }
}
