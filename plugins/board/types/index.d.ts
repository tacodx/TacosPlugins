// The values this mod keeps in $.state, and the shape of what the reader prints.

export type Status = 'idle' | 'loading' | 'ready' | 'error'

export type PlanRow = { id: string; name: string; done: boolean; note: string }

/** One session at work: its name, the project it runs in, and since when (ms) it has been busy or last wrote. */
export type Working = { name: string; project: string; since: number | null }

/** What `reader/cli.mjs view` prints. Defined by `reader/view.mjs`. */
export type View = {
  version: 1
  generatedAt: string
  now: number
  /** The time of `now` on the local clock, "HH:MM". */
  updated: string
  zone: string
  refreshMinutes: number
  today: string
  totals: { commitsToday: number; linesToday: number; commits7d: number; projectsToday: number; projects7d: number }
  /** Thirty hours, oldest first; the last is the hour now under way. */
  hours: { start: number; day: string; hour: number; commits: number }[]
  /** Seven days, oldest first; the last is today. */
  days: { day: string; total: number; projects: Record<string, number> }[]
  /** The projects with commits in those days, most first, each with its colour slot. */
  projects: { name: string; commits: number; slot: number | null }[]
  sessions: { source: 'registry' | 'transcripts'; working: Working[]; idle: number | null }
  plan: null | { file: string; rows: PlanRow[]; done: number; total: number } | { file: string; error: string }
  repos: { count: number; unreadable: string[] }
  /** Where the settings are, as the person would write the path. */
  configFile: string
  notes: string[]
}

declare module 'claude-code' {
  interface PluginState {
    board: {
      status: Status
      view: View | null
      error: string | null
    }
  }
}
