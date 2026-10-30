// reflect: `/reflect` opens a pane that charts how you use Claude Code.
//
// Every number comes from `indexer/cli.mjs`, a Node program this module runs and
// whose one JSON answer, a View, it keeps in $.state. A hooks module has no Node
// and cannot read a file over 4 MiB, which is why the reading is done there.
// This file holds every hook and every call on `$`; the tabs it draws are pure
// modules that are handed the surface's elements and the View.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RangeId, TabId, Tips, View } from '../types'
import { count, tokens } from './format.mjs'
import { activity } from './tabs/activity.tsx'
import { models } from './tabs/models.tsx'
import { overview } from './tabs/overview.tsx'
import { projects } from './tabs/projects.tsx'
import { tips as tipsTab } from './tabs/tips.tsx'
import { tools } from './tabs/tools.tsx'
import { work } from './tabs/work.tsx'
import { tipsRequest } from './tips.mjs'

const PANE = 'reflect'
const RANGES: { id: RangeId; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
]
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'projects', label: 'Projects' },
  { id: 'models', label: 'Models' },
  { id: 'tools', label: 'Tools' },
  { id: 'work', label: 'Work' },
  { id: 'tips', label: 'Tips' },
]
const NO_TIPS: Tips = { status: 'idle', for: null, text: null, tokens: null }

const status = atom({ plugin: 'reflect', key: 'status' } as const, 'idle')
const view = atom({ plugin: 'reflect', key: 'view' } as const, null)
const error = atom({ plugin: 'reflect', key: 'error' } as const, null)
const range = atom({ plugin: 'reflect', key: 'range' } as const, '30d')
const tab = atom({ plugin: 'reflect', key: 'tab' } as const, 'overview')
const tips = atom({ plugin: 'reflect', key: 'tips' } as const, NO_TIPS)

// Which refresh was started last. An older one that finishes later must not
// put its answer over a newer one's.
let newest = 0

function isView(value: unknown): value is View {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1
}

/** What a run of the indexer amounts to: a View, or the reason there is none. */
function readRun(ran: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }): { view: View } | { reason: string } {
  if (ran.exitCode !== 0) {
    const said = ran.stderr.trim().replace(/^reflect: /, '')
    return { reason: said === '' ? `the indexer stopped with exit code ${ran.exitCode}` : said.slice(0, 400) }
  }
  if (ran.isStdoutTruncated) return { reason: 'the indexer printed more than this pane can read' }
  let parsed: unknown
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return { reason: 'the indexer did not print a view' }
  }
  return isView(parsed) ? { view: parsed } : { reason: 'the indexer printed a view this version does not understand' }
}

async function refresh($: EngineInterface, wanted: RangeId): Promise<void> {
  const mine = (newest += 1)
  await update($, range, () => wanted)
  await update($, status, () => 'loading')

  let outcome: { view: View } | { reason: string }
  try {
    outcome = readRun(await $.process.run(['node', `${$.plugin.root}/indexer/cli.mjs`, 'view', '--range', wanted], { timeoutMs: 180_000 }))
  } catch (err) {
    // The command could not be started, or ran past its three minutes.
    outcome = { reason: `the indexer could not be run. Reflect needs Node 22 or newer on your PATH. (${err instanceof Error ? err.message : String(err)})` }
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

async function writeTips($: EngineInterface, about: View): Promise<void> {
  const key = `${about.range.id}:${about.range.to}`
  await update($, tips, () => ({ status: 'loading', for: key, text: null, tokens: null }))
  try {
    const ask = tipsRequest(about)
    const answer = await $.model.complete({ model: 'haiku', system: ask.system, prompt: ask.prompt, maxTokens: 700 })
    if (!answer.isAnswered) {
      const why = answer.reason === 'api-error' ? `the request failed (${answer.status ?? 'no status'})` : answer.reason === 'aborted' ? 'the request was cut short' : 'the reply was empty'
      await update($, tips, () => ({ status: 'error', for: key, text: why, tokens: null }))
      return
    }
    const text = ask.restore(answer.text)
    const used = answer.usage.input_tokens + answer.usage.output_tokens + answer.usage.cache_read_input_tokens + answer.usage.cache_creation_input_tokens
    await update($, tips, () => ({ status: 'ready', for: key, text, tokens: used }))
    await $.store.set(`tips:${key}`, text)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, tips, () => ({ status: 'error', for: key, text: why, tokens: null }))
  }
}

// Suggestions already written for this range today are shown without asking again.
async function showTips($: EngineInterface, about: View): Promise<void> {
  await update($, tab, () => 'tips')
  const key = `${about.range.id}:${about.range.to}`
  if ((await read($, tips)).for === key) return
  const saved = await $.store.get(`tips:${key}`)
  if (typeof saved === 'string') await update($, tips, () => ({ status: 'ready', for: key, text: saved, tokens: null }))
}

async function openPane($: EngineInterface): Promise<{ text: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Reflect' })
  void refresh($, await read($, range))

  return { text: opened.isPlaced ? 'Reflect is open.' : `Reflect could not be shown: ${opened.reason}` }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'reflect', description: 'See how you use Claude Code: activity, projects, models, tools', immediate: true })

    return next(e)
  })

  on('command.run', { command: 'reflect' }, ($) => openPane($))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, status)
    const data = await read($, view)
    const problem = await read($, error)
    const currentRange = await read($, range)
    const currentTab = await read($, tab)
    const advice = await read($, tips)

    if (e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text bold>Reflect</Text>
          <Text>
            {isView(data)
              ? `${count(data.totals.prompts)} prompts, ${count(data.totals.sessions)} sessions and ${tokens(data.totals.out)} output tokens from ${data.range.from} to ${data.range.to}.`
              : state === 'error'
                ? `Your history could not be read: ${problem ?? 'unknown reason'}`
                : 'Reading your history…'}
          </Text>
          <Text dimColor>The charts are drawn in the Code tab of the Claude desktop app.</Text>
        </Box>
      )
    }

    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const shown = isView(data) ? data : null

    let body
    if (shown === null) {
      body =
        state === 'error' ? null : (
          <Box key="loading">
            <Text>Reading your history. The first time takes about twenty seconds.</Text>
          </Box>
        )
    } else if (currentTab === 'activity') body = activity(el, shown)
    else if (currentTab === 'projects') body = projects(el, shown)
    else if (currentTab === 'models') body = models(el, shown)
    else if (currentTab === 'tools') body = tools(el, shown)
    else if (currentTab === 'work') body = work(el, shown)
    else if (currentTab === 'tips') body = tipsTab(el, shown, advice, () => void writeTips($, shown))
    else body = overview(el, shown)

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="ranges" gap={1} flexWrap="wrap">
          {RANGES.map((each) => (
            <Button key={`range-${each.id}`} label={each.label} variant={currentRange === each.id ? 'primary' : 'secondary'} onPress={() => void refresh($, each.id)} />
          ))}
        </Box>
        {shown !== null && (
          <Box key="tabs" gap={1} flexWrap="wrap">
            {TABS.map((each) => (
              <Button
                key={`tab-${each.id}`}
                label={each.label}
                variant={currentTab === each.id ? 'primary' : 'secondary'}
                onPress={() => (each.id === 'tips' ? showTips($, shown) : update($, tab, () => each.id))}
              />
            ))}
          </Box>
        )}
        {state === 'loading' && shown !== null && (
          <Box key="updating">
            <Text dimColor>Updating…</Text>
          </Box>
        )}
        {state === 'error' && (
          <Box key="problem" flexDirection="column">
            <Text bold>{`Your history could not be read: ${problem ?? 'unknown reason'}`}</Text>
            <Button key="retry" label="Try again" variant="primary" onPress={() => void refresh($, currentRange)} />
          </Box>
        )}
        {body}
        {shown !== null && (
          <Box key="footnotes" flexDirection="column">
            <Text dimColor>
              {`Prompts since ${shown.coverage.historyFrom ?? shown.coverage.transcriptsFrom ?? shown.range.from}. Tokens, tools and sessions since ${shown.coverage.transcriptsFrom ?? shown.range.from}. Nothing leaves this machine except on the Tips tab, when you ask.`}
            </Text>
            {shown.notes.map((note) => (
              <Text dimColor>{note}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
