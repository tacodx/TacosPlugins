// board: `/board` opens a pane beside the chat that shows the work going on:
// today's commits, commits per hour and per project, the sessions at work and
// the plan, refreshed every few minutes while the pane is open.
//
// Every number comes from `reader/cli.mjs`, a Node program this module runs and
// whose one JSON answer, a View, it keeps in $.state. A hooks module has no Node,
// cannot run git and cannot read a file over 4 MiB, which is why the reading is
// done there. This file holds every hook and every call on `$`; the cards it
// draws come from pure modules handed the surface's elements and the View.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { View } from '../types'
import { board } from './board.tsx'
import { summary } from './shape.mjs'

const PANE = 'board'
/** How often the timer looks whether a refresh is due; the settings say how often one is. */
const TICK_MS = 60_000
const DEFAULT_REFRESH_MINUTES = 3

const status = atom({ plugin: 'board', key: 'status' } as const, 'idle')
const view = atom({ plugin: 'board', key: 'view' } as const, null)
const error = atom({ plugin: 'board', key: 'error' } as const, null)

// Which refresh was started last. An older one that finishes later must not
// put its answer over a newer one's.
let newest = 0
// Refreshes this copy of the module has under way. Kept here, not in $.state:
// a refresh cut off by a reload never finishes, and its 'loading' must not
// keep the reloaded module's timer from refreshing.
let running = 0
// When the last refresh started. A reload sets it back to 0, so a pane that
// stayed open through the reload is refreshed at the next tick.
let startedAt = 0
let ticking: Timer | null = null

function isView(value: unknown): value is View {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1
}

/** What a run of the reader amounts to: a View, or the reason there is none. */
function readRun(ran: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }): { view: View } | { reason: string } {
  if (ran.exitCode !== 0) {
    const said = ran.stderr.trim().replace(/^board: /, '')
    return { reason: said === '' ? `the reader stopped with exit code ${ran.exitCode}` : said.slice(0, 400) }
  }
  if (ran.isStdoutTruncated) return { reason: 'the reader printed more than this pane can read' }
  let parsed: unknown
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return { reason: 'the reader did not print a view' }
  }
  return isView(parsed) ? { view: parsed } : { reason: 'the reader printed a view this version does not understand' }
}

async function refresh($: EngineInterface): Promise<void> {
  const mine = (newest += 1)
  running += 1
  try {
    await readNow(mine, $)
  } finally {
    running -= 1
  }
}

/** One run of the reader, its View or its failure written to $.state unless a newer run has begun. */
async function readNow(mine: number, $: EngineInterface): Promise<void> {
  startedAt = await $.clock.now()
  await update($, status, () => 'loading')

  let outcome: { view: View } | { reason: string }
  try {
    // From the plugin's own folder: the session's may be a worktree that is gone.
    outcome = readRun(await $.process.run(['node', `${$.plugin.root}/reader/cli.mjs`, 'view'], { cwd: $.plugin.root, timeoutMs: 150_000 }))
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err)
    outcome = /timed out|time ?out|still running/i.test(said)
      ? { reason: 'the reader did not finish within two and a half minutes. It tries again at the next refresh.' }
      : { reason: `the reader could not be run. The board needs Node 22 or newer on your PATH. (${said})` }
  }
  if (mine !== newest) return

  if ('view' in outcome) {
    const fresh = outcome.view
    await update($, view, () => fresh)
    await update($, error, () => null)
    await update($, status, () => 'ready')
  } else {
    const reason = outcome.reason
    await update($, error, () => reason)
    await update($, status, () => 'error')
  }
}

/** Refreshes the pane while it is open, once the last refresh is as old as the settings allow. */
async function tick($: EngineInterface): Promise<void> {
  const isOpen = (await $.ui.panes()).some((pane) => pane.id === PANE && pane.isPlaced)
  if (!isOpen || running > 0) return
  const shown = await read($, view)
  const minutes = isView(shown) ? shown.refreshMinutes : DEFAULT_REFRESH_MINUTES
  // A few seconds early is on time: the ticks and the runs never line up exactly.
  if ((await $.clock.now()) - startedAt < minutes * 60_000 - 5_000) return
  await refresh($)
}

// A refresh cut short by an unload (a reload, the session's end) has nowhere
// left to put its answer, and nobody left to tell.
const quietly = (work: Promise<void>): void => void work.catch(() => undefined)

async function openPane($: EngineInterface): Promise<{ text: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Board' })
  quietly(refresh($))

  return { text: opened.isPlaced ? 'The board is open.' : `The board could not be shown: ${opened.reason}` }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Open the board: commits, the sessions at work and your plan, kept up to date', immediate: true })
    ticking?.cancel()
    ticking = $.clock.every(TICK_MS, () => quietly(tick($)))

    return next(e)
  })

  on('command.run', { command: 'board' }, ($) => openPane($))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, status)
    const data = await read($, view)
    const problem = await read($, error)
    const shown = isView(data) ? data : null

    if (e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text bold>Board</Text>
          {shown !== null ? (
            summary(shown).map((line) => <Text>{line}</Text>)
          ) : (
            <Text>{state === 'error' ? `The board could not be read: ${problem ?? 'unknown reason'}` : 'Reading your repos…'}</Text>
          )}
          <Text dimColor>The charts are drawn in the Code tab of the Claude desktop app.</Text>
        </Box>
      )
    }

    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el

    return (
      <Box flexDirection="column" gap={1}>
        {shown === null && state !== 'error' && (
          <Box key="loading">
            <Text>Reading your repos, sessions and plan…</Text>
          </Box>
        )}
        {state === 'error' && (
          <Box key="problem" flexDirection="column">
            <Text bold>{`The board could not be read: ${problem ?? 'unknown reason'}`}</Text>
            <Button key="retry" label="Try again" variant="primary" onPress={() => quietly(refresh($))} />
          </Box>
        )}
        {shown !== null && board(el, shown)}
        {shown !== null && (
          <Box key="footnotes" flexDirection="column">
            <Text dimColor>
              {`Updated ${shown.updated}${state === 'loading' ? ', updating now' : ''}. While open it refreshes every ${shown.refreshMinutes} min. Settings: ${shown.configFile}`}
            </Text>
            {shown.notes.map((note) => (
              <Text dimColor>{note}</Text>
            ))}
            <Button key="refresh" label="Refresh now" onPress={() => quietly(refresh($))} />
          </Box>
        )}
      </Box>
    )
  })
}
