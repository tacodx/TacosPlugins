#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, for worker tests.
// FAKE_MODE picks what it does; every call's argv is appended to FAKE_LOG.
import { appendFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), env: { NIGHT_WORKER: process.env.NIGHT_WORKER, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, TMPDIR: process.env.TMPDIR } })}\n`)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const session = flag('--session-id') ?? flag('--resume')
const say = (line) => process.stdout.write(`${JSON.stringify({ session_id: session, ...line })}\n`)
const mode = process.env.FAKE_MODE ?? 'done'

if (mode === 'crash-silent') process.exit(1)
say({ type: 'system', subtype: 'init' })
if (mode === 'done' || mode === 'partial' || mode === 'needs-owner') {
  writeFileSync('work.txt', `${Date.now()}\n`)
  execFileSync('git', ['add', 'work.txt'])
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'night work'])
  const text = `All set.\nNIGHT-RESULT: ${mode} · wrote work.txt`
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01 })
} else if (mode === 'limit') {
  say({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit" }] }, apiErrorParams: { rate_limit_info: { resetsAt: Number(process.env.FAKE_RESETS_AT) } } })
  say({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit" })
} else if (mode === 'login') {
  say({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' })
} else if (mode === 'crash') {
  process.exit(1)
} else if (mode === 'hang') {
  setInterval(() => {}, 1000)
}
