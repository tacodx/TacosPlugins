#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { configDir, readConfig } = await load('config.mjs')
const { parseBudgetArgs, writeSessionConfig, gcSessions } = await load('session.mjs')
const { getGauges } = await load('usage.mjs')
const { decide } = await load('decide.mjs')
const { renderStatus } = await load('render.mjs')

/**
 * Persists a /budget patch and reports the outcome. Never lets a failed save report
 * success: the user must be told their budget is unchanged, not shown a raw stack trace
 * for a command whose entire job is to be a friendly front end. Exits 0 either way — this
 * CLI is invoked from a slash-command prompt, where a non-zero exit is noise, not signal.
 */
export function saveBudget(dir, sessionId, patch, successLine, {
  writeSessionConfig: write = writeSessionConfig, log = console.log, exit = process.exit,
} = {}) {
  try {
    write(dir, sessionId, patch)
  } catch (err) {
    log(`usage-guard: could not save this chat's budget — ${err?.message ?? 'unknown error'}`)
    log('usage-guard: your budget is unchanged.')
    exit(0)
    return
  }
  log(successLine)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const dir = configDir(process.env)
  const sessionId = process.env.TACOS_SESSION_ID || process.argv[2]
  const rest = process.argv.slice(3)

  if (!sessionId) { console.log('usage-guard: no session id available; cannot scope a budget.'); process.exit(0) }
  gcSessions(dir, { now: Date.now() })

  if (rest.length === 0) {
    const cfg = readConfig({ dir, sessionId, readFile: readFileSync })
    const { gauges, blind, reason } = await getGauges({ dir, now: Date.now() })
    console.log(renderStatus({ gauges, thresholds: cfg.gauges, decision: blind ? null : decide(gauges, cfg.gauges), mode: cfg.mode, blind, reason, configUnreadable: cfg.configUnreadable }))
    process.exit(0)
  }

  const parsed = parseBudgetArgs(rest)
  if (parsed.error) { console.log(`usage-guard: ${parsed.error}`); process.exit(0) }

  const existing = readConfig({ dir, sessionId, readFile: readFileSync })
  const patch = parsed.mode
    ? { mode: parsed.mode }
    : { gauges: { [parsed.gauge]: { soft: Math.max(1, parsed.hard - 15), hard: parsed.hard } } }
  const successLine = parsed.mode
    ? `usage-guard: mode set to ${parsed.mode} for this chat.`
    : `usage-guard: ${parsed.gauge} ceiling set to ${parsed.hard}% for this chat (advisory at ${Math.max(1, parsed.hard - 15)}%). Previous mode: ${existing.mode}.`
  saveBudget(dir, sessionId, patch, successLine)
}
