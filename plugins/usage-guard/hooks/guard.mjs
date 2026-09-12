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

/**
 * True only for the guard's own /budget CLI invoked as a Bash tool call. At the hard
 * ceiling every PreToolUse is denied — including the Bash call commands/budget.md uses
 * to run bin/budget.mjs — so without this exemption a user has no way to reach
 * `/budget off` once the ceiling is hit; the off-switch would be denied by the thing
 * it turns off. Deliberately narrow (both substrings must appear in the Bash command)
 * so this can never become a general bypass for arbitrary tool calls.
 */
function isBudgetCommand(input) {
  const command = input.tool_name === 'Bash' ? input.tool_input?.command : null
  return typeof command === 'string' && command.includes('usage-guard') && command.includes('bin/budget.mjs')
}

const advisory = (d) => [
  `Usage budget: ${d.gauge} is at ${Math.round(d.percent)}% (soft ${d.soft}, ceiling ${d.hard}).`,
  'Finish the current task properly. Do NOT start new large-scope work.',
  'Prefer a small number of targeted subagents over broad fan-out.',
  'Do NOT reduce effort, switch model, shorten reasoning, or cut corners on work already underway —',
  'quality is not the lever here; scope is.',
].join(' ')

const blindNotice = (reason) =>
  `usage-guard has no usage data (${reason || 'unknown'}) and is allowing everything this session.`

/** Pure, so it can be tested without fs or network. */
export function decideForHook({ input, cfg, gauges, blind, reason }) {
  if (cfg.mode === 'off') return { action: 'allow', text: null }
  if (blind || !gauges) {
    // Spec §9: when blind, say so once per session rather than silently implying 0%
    // usage. SessionStart fires exactly once per session, so that alone is the "once
    // per session" mechanism — no extra state tracking needed. Every other event
    // (in particular PreToolUse) stays a silent allow, same as before.
    if (input.hook_event_name === 'SessionStart') return { action: 'context', text: blindNotice(reason) }
    return { action: 'allow', text: null }
  }
  const d = decide(gauges, cfg.gauges)
  if (d.state === STATE.OK) return { action: 'allow', text: null }

  const event = input.hook_event_name
  const enforcing = cfg.mode === 'enforce'

  if (event === 'PreToolUse' && isBudgetCommand(input)) return { action: 'allow', text: null }

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
  const { gauges, blind, reason } = await getGauges({ dir, now: Date.now() })
  const { action, text } = decideForHook({ input, cfg, gauges, blind, reason })
  if (action === 'deny') return denyOutput(input.hook_event_name, text)
  if (action === 'context') return contextOutput(input.hook_event_name, text)
  return allowOutput()
})
