// The values this mod keeps in $.state, and the shape of what `bin/night.mjs` prints.

export type Phase = 'idle' | 'armed' | 'dusk' | 'night' | 'day' | 'stopped'

export type TabId = 'tonight' | 'settings'

export type Status = 'idle' | 'loading' | 'ready' | 'error'

/** What the pane asks of `bin/night.mjs`: `view`, or one of the actions. */
export type Action = 'view' | 'arm' | 'disarm' | 'start' | 'stop' | 'set' | 'sessions' | 'project'

export type Worker = {
  slot: number
  /** `working`, `waiting`, `limited`, `paused` or `off`; anything else reads as off. */
  state: string
  project: string | null
  /** The title of the item the worker holds. */
  item: string | null
  since: number | null
  limitedUntil: number | null
}

/** What `bin/night.mjs view` prints, and every action prints as `{ ok: true, view }`. */
export type View = {
  version: 1
  now: number
  phase: Phase
  date: string | null
  window: { from: string; to: string }
  /** The window as instants, in ms, while armed or running. */
  armed: { start: number; end: number } | null
  sessions: number
  workers: Worker[]
  watchers: { name: string; ok: boolean; lastBeat: number | null }[]
  queue: { open: number; taken: number; done: number; parked: number; failed: number }
  /** Percentages, 0 to 100; `resetsAt` in ms or as an ISO string. */
  usage: { fiveHour: number | null; sevenDay: number | null; resetsAt: number | string | null } | null
  health: { line: string; blockers: number }
  projects: { name: string; status: string; on: boolean }[]
  fans: { token: boolean; dayMode: boolean; nightMode: boolean; tokenPath: string }
  recap: { headline: string; projects: { name: string; line: string }[]; artifactUrl: string | null } | null
  problems: string[]
}

/** From and To as the owner is typing them, before Save; null where untouched. */
export type Draft = { from: string | null; to: string | null }

declare module 'claude-code' {
  interface PluginState {
    night: {
      status: Status
      view: View | null
      error: string | null
      tab: TabId
      busy: Action | null
      confirmStop: boolean
      draft: Draft
    }
  }
}
