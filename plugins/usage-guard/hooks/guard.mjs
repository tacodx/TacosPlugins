import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { decide, STATE } = await load('decide.mjs')
const { configDir, readConfig } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { run, allowOutput, denyOutput, contextOutput } = await load('hookio.mjs')

const FANOUT = new Set(['Agent', 'Workflow', 'Task'])

const advisory = (d) => [
  `Usage budget: ${d.gauge} is at ${Math.round(d.percent)}% (soft ${d.soft}, ceiling ${d.hard}).`,
  'Finish the current task properly. Do NOT start new large-scope work.',
  'Prefer a small number of targeted subagents over broad fan-out.',
  'Do NOT reduce effort, switch model, shorten reasoning, or cut corners on work already underway —',
  'quality is not the lever here; scope is.',
].join(' ')

/** Pure, so it can be tested without fs or network. */
export function decideForHook({ input, cfg, gauges, blind }) {
  if (blind || !gauges || cfg.mode === 'off') return { action: 'allow', text: null }
  const d = decide(gauges, cfg.gauges)
  if (d.state === STATE.OK) return { action: 'allow', text: null }

  const event = input.hook_event_name
  const enforcing = cfg.mode === 'enforce'

  if (d.state === STATE.HARD && enforcing && event === 'PreToolUse') {
    return { action: 'deny', text: `Usage ceiling reached: ${d.gauge} at ${Math.round(d.percent)}% (ceiling ${d.hard}). Winding down; nothing new will start.` }
  }
  if (d.state === STATE.SOFT && enforcing && event === 'PreToolUse' && FANOUT.has(input.tool_name)) {
    return { action: 'deny', text: `Usage budget: ${d.gauge} at ${Math.round(d.percent)}% (soft ${d.soft}). New fan-out is paused. Continue with the work already in progress.` }
  }
  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    return { action: 'context', text: advisory(d) }
  }
  return { action: 'allow', text: null }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) run(async (input) => {
  const dir = configDir(process.env)
  const cfg = readConfig({ dir, sessionId: input.session_id, readFile: readFileSync })
  const { gauges, blind } = await getGauges({ dir, now: Date.now() })
  const { action, text } = decideForHook({ input, cfg, gauges, blind })
  if (action === 'deny') return denyOutput(input.hook_event_name, text)
  if (action === 'context') return contextOutput(input.hook_event_name, text)
  return allowOutput()
})
