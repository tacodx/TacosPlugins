#!/usr/bin/env node
// The PreToolUse hook every night worker runs under. Reads the hook's JSON on
// stdin, asks engine/guard.mjs, prints the decision in the shape Claude Code
// expects, and writes each deny and rewrite to the night's events. It fails
// closed: when the guard cannot judge a call, only reading tools go through.
// It always exits 0; an allowed call prints nothing.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { appendJsonl } from '../engine/fsx.mjs'
import { decide as judge } from '../engine/guard.mjs'

const READS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const DETAIL_MAX = 300

/** The guard's context from the worker's environment and the hook payload. */
export function contextFrom(env, payload = {}) {
  const list = (text, sep) => String(text ?? '').split(sep).map((s) => s.trim()).filter(Boolean)
  return {
    worktree: env.NIGHT_WORKTREE,
    scratch: env.NIGHT_SCRATCH || undefined,
    home: env.HOME || homedir(),
    protected: list(env.NIGHT_PROTECTED, ','),
    testLock: env.NIGHT_TEST_LOCK || undefined,
    secrets: list(env.NIGHT_SECRETS, ':'),
    cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
  }
}

const failClosed = (tool, problem) => (READS.has(tool)
  ? { decision: 'allow' }
  : {
    decision: 'deny',
    reason: `The night guard cannot check this call (${problem}): only Read, Grep, Glob and LS work until it is fixed.`,
  })

const valid = (result) => result && (result.decision === 'allow'
  || (result.decision === 'deny' && typeof result.reason === 'string')
  || (result.decision === 'rewrite' && result.input && typeof result.input === 'object'))

function judgeCall(stdin, env, decide) {
  let payload = null
  try { payload = JSON.parse(stdin) } catch { /* not JSON: judged below */ }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload: null, tool: null, input: {}, result: failClosed(null, 'the hook input was not JSON') }
  }
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : null
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const ctx = contextFrom(env, payload)
  if (typeof env.NIGHT_WORKTREE !== 'string' || !env.NIGHT_WORKTREE.startsWith('/')) {
    // Reading tools still meet the secret rules, judged against no worktree at all.
    let result = failClosed(tool, 'NIGHT_WORKTREE is not set')
    if (READS.has(tool)) {
      try { result = decide(tool, input, { ...ctx, worktree: '/' }) } catch { /* the allow above stands */ }
      if (!valid(result) || result.decision === 'rewrite') result = { decision: 'allow' }
    }
    return { payload, tool, input, result }
  }
  try {
    const result = decide(tool, input, ctx)
    if (!valid(result)) return { payload, tool, input, result: failClosed(tool, 'the guard gave no decision') }
    return { payload, tool, input, result }
  } catch (err) {
    return { payload, tool, input, result: failClosed(tool, `the guard failed: ${err?.message ?? err}`) }
  }
}

function output(result) {
  if (result.decision === 'deny') {
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason },
    }
  }
  if (result.decision === 'rewrite') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: result.reason,
        updatedInput: result.input,
      },
    }
  }
  return null
}

function detailOf(input, stdin) {
  const value = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern
  return String(value ?? (typeof stdin === 'string' ? stdin : '')).slice(0, DETAIL_MAX)
}

/**
 * Runs the hook once: judges the call in `stdin`, writes the decision JSON with
 * `write` (nothing for an allow) and appends a deny or rewrite to NIGHT_EVENTS.
 * Never throws. Returns the decision.
 */
export function main({
  stdin = '', env = process.env, write = (text) => process.stdout.write(text), now = Date.now, decide = judge,
} = {}) {
  let call
  try {
    call = judgeCall(stdin, env, decide)
  } catch (err) {
    call = { payload: null, tool: null, input: {}, result: failClosed(null, `the guard failed: ${err?.message ?? err}`) }
  }
  const { payload, tool, input, result } = call
  const json = output(result)
  if (json) {
    try { write(`${JSON.stringify(json)}\n`) } catch { /* nothing more can be done */ }
  }
  if (json && env.NIGHT_EVENTS) {
    try {
      appendJsonl(env.NIGHT_EVENTS, {
        at: new Date(now()).toISOString(),
        kind: `guard.${result.decision}`,
        session: payload?.session_id ?? null,
        tool,
        reason: result.reason,
        detail: detailOf(input, stdin),
      })
    } catch { /* an event file that cannot be written never changes the decision */ }
  }
  return result
}

// Compared by real path: a plugin folder is often reached through a symlink,
// and then the path Node was started with is not the path this module has.
function isMain() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false // an unresolvable path means we were imported, not run
  }
}

if (isMain()) {
  let stdin = ''
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    stdin = Buffer.concat(chunks).toString('utf8')
  } catch { /* unreadable input fails closed in main */ }
  main({ stdin })
  process.exitCode = 0
}
