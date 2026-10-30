// night: `/night` opens a pane to set the night's window, arm it, start or stop
// it, and see tonight's workers and the last recap.
//
// Every read and every change goes through `bin/night.mjs`, a Node program this
// module runs and whose JSON answer, a View, it keeps in $.state; the engine
// never needs the pane. This file holds every hook and every call on `$`; the
// tabs it draws are pure modules handed the surface's elements and the View.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Action, Draft, TabId, View } from '../types'
import { isView, readRun } from './answer.mjs'
import { settings } from './tabs/settings.tsx'
import { tonightDrawn, tonightPlain } from './tabs/tonight.tsx'
import { controls, DOING, timeOfDay } from './words.mjs'

const PANE = 'night'
/** How often the pane reads the night again while it is open. */
const EVERY = 60_000
const VIEW_MS = 30_000
const ACTION_MS = 120_000
const TABS: { id: TabId; label: string }[] = [
  { id: 'tonight', label: 'Tonight' },
  { id: 'settings', label: 'Settings' },
]
const NO_DRAFT: Draft = { from: null, to: null }

const status = atom({ plugin: 'night', key: 'status' } as const, 'idle')
const view = atom({ plugin: 'night', key: 'view' } as const, null)
const error = atom({ plugin: 'night', key: 'error' } as const, null)
const tab = atom({ plugin: 'night', key: 'tab' } as const, 'tonight')
const busy = atom({ plugin: 'night', key: 'busy' } as const, null)
const confirmStop = atom({ plugin: 'night', key: 'confirmStop' } as const, false)
const draft = atom({ plugin: 'night', key: 'draft' } as const, NO_DRAFT)

// Which run was started last. A read that finishes after a newer run started,
// or after an action finished, must not put its older view over a newer one.
let newest = 0
// The minute's timer while the pane is open. A reload drops it with the module.
let ticker: Timer | null = null

/** Runs `bin/night.mjs` with `args` and keeps the view it prints, or why there is none. */
async function run($: EngineInterface, args: string[]): Promise<boolean> {
  const action = args[0] as Action
  const isRead = action === 'view'
  const mine = (newest += 1)
  if (!isRead) await update($, busy, () => action)
  await update($, status, () => 'loading')

  let outcome: { view: View } | { reason: string }
  try {
    outcome = readRun(await $.process.run(['node', `${$.plugin.root}/bin/night.mjs`, ...args], { timeoutMs: isRead ? VIEW_MS : ACTION_MS }))
  } catch (err) {
    // The command could not be started, or ran past its time.
    outcome = { reason: `night could not be run. It needs Node 22 or newer on your PATH. (${err instanceof Error ? err.message : String(err)})` }
  }
  const isStale = isRead && mine !== newest
  if (!isRead) {
    newest += 1
    await update($, busy, () => null)
  }
  if (isStale) return 'view' in outcome

  if ('view' in outcome) {
    const fresh = outcome.view
    await update($, view, () => fresh)
    await update($, error, () => null)
    await update($, status, () => 'ready')
    return true
  }
  const reason = outcome.reason
  await update($, error, () => reason)
  await update($, status, () => 'error')
  return false
}

/** An action of the owner's: one at a time, and it takes back a half-pressed Stop. */
async function act($: EngineInterface, args: string[]): Promise<boolean> {
  if ((await read($, busy)) !== null) return false
  await update($, confirmStop, () => false)
  return run($, args)
}

async function refresh($: EngineInterface): Promise<void> {
  await update($, confirmStop, () => false)
  await run($, ['view'])
}

// Stop asks once: the first press turns the button into the question, the second stops.
async function pressStop($: EngineInterface): Promise<void> {
  if ((await read($, busy)) !== null) return
  if (!(await read($, confirmStop))) {
    await update($, confirmStop, () => true)
    return
  }
  await act($, ['stop'])
}

async function saveWindow($: EngineInterface, typed?: { which: 'from' | 'to'; text: string }): Promise<void> {
  const shown = await read($, view)
  if (shown === null) return
  const held = await read($, draft)
  const wanted: Draft = typed === undefined ? held : { ...held, [typed.which]: typed.text }
  await update($, draft, () => wanted)
  const from = timeOfDay(wanted.from ?? shown.window.from)
  const to = timeOfDay(wanted.to ?? shown.window.to)
  if (from === null || to === null) {
    await update($, error, () => 'From and To are times of day, like 23:30 and 06:30.')
    return
  }
  if (await act($, ['set', from, to])) await update($, draft, () => NO_DRAFT)
}

async function showTab($: EngineInterface, id: TabId): Promise<void> {
  await update($, confirmStop, () => false)
  await update($, tab, () => id)
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some((pane) => pane.id === PANE)

// Each minute while the pane is open, by whatever road it was closed: the
// close mark, Escape, or the pane given up while undrawn.
function keepFresh($: EngineInterface): void {
  if (ticker !== null) return
  ticker = $.clock.every(EVERY, () => void tick($))
}

async function tick($: EngineInterface): Promise<void> {
  if (await isOpen($)) {
    await run($, ['view'])
    return
  }
  ticker?.cancel()
  ticker = null
}

async function openPane($: EngineInterface): Promise<{ text: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Night' })
  await update($, confirmStop, () => false)
  void run($, ['view'])
  keepFresh($)

  return { text: opened.isPlaced ? 'Night is open.' : `Night could not be shown: ${opened.reason}` }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'night', description: "Night: set the window, arm it, and see tonight's workers and the last recap", immediate: true })
    // A reload drops the minute's timer; a pane that stayed up gets it back.
    if (await isOpen($)) keepFresh($)

    return next(e)
  })

  on('command.run', { command: 'night' }, ($) => openPane($))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, status)
    const data = await read($, view)
    const problem = await read($, error)
    const currentTab = await read($, tab)
    const doing = await read($, busy)
    const confirming = await read($, confirmStop)
    const typed = await read($, draft)
    const shown = isView(data) ? data : null
    const { Box, Text, Button } = $.ui.resolve(e)

    let body
    if (shown === null) {
      body =
        state === 'error' ? null : (
          <Box key="loading">
            <Text dimColor>Reading tonight…</Text>
          </Box>
        )
    } else if (currentTab === 'settings') {
      const acts = {
        type: (which: 'from' | 'to', text: string) => void update($, draft, (held) => ({ ...held, [which]: text })),
        save: (given?: { which: 'from' | 'to'; text: string }) => void saveWindow($, given),
        sessions: (value: string) => void act($, ['sessions', value]),
        project: (name: string, isOn: boolean) => void act($, ['project', name, isOn ? 'on' : 'off']),
      }
      if (e.surface === 'mobile') body = settings($.ui.resolve(e), null, shown, typed, acts)
      else {
        const el = $.ui.resolve(e)
        body = settings(el, el, shown, typed, acts)
      }
    } else {
      const can = controls(shown.phase)
      body = (
        <Box key="tonight-tab" flexDirection="column" gap={1}>
          {e.surface === 'terminal' ? tonightPlain($.ui.resolve(e), shown) : tonightDrawn($.ui.resolve(e), shown)}
          <Box key="actions" gap={1} flexWrap="wrap">
            {can.arm === 'arm' && <Button key="arm" label="Arm" variant="primary" onPress={() => void act($, ['arm'])} />}
            {can.arm === 'disarm' && <Button key="disarm" label="Disarm" onPress={() => void act($, ['disarm'])} />}
            {can.start && <Button key="start" label="Start now" onPress={() => void act($, ['start'])} />}
            {can.stop && (
              <Button
                key="stop"
                label={confirming ? 'Stop the night? Click again' : 'Stop'}
                variant={confirming ? 'primary' : 'secondary'}
                onPress={() => void pressStop($)}
              />
            )}
            <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {shown !== null && (
          <Box key="tabs" gap={1}>
            {TABS.map((each) => (
              <Button key={`tab-${each.id}`} label={each.label} variant={currentTab === each.id ? 'primary' : 'secondary'} onPress={() => void showTab($, each.id)} />
            ))}
          </Box>
        )}
        {doing !== null && (
          <Box key="busy">
            <Text dimColor>{DOING[doing]}</Text>
          </Box>
        )}
        {problem !== null && (
          <Box key="problem" flexDirection="column" gap={1}>
            <Text color="warning">{shown === null ? `Tonight could not be read: ${problem}` : problem}</Text>
            {shown === null && <Button key="retry" label="Try again" variant="primary" onPress={() => void refresh($)} />}
          </Box>
        )}
        {body}
      </Box>
    )
  })
}
