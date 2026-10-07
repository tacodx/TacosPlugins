// Builders for synthetic transcript lines. Nothing here is copied from a real
// transcript: the repo is public. JSON.stringify writes compact JSON, which is
// what Claude Code writes and what the scanner's cheap pre-filter expects.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClock } from '../indexer/clock.mjs'

export const HOME = '/home/u'
export const utc = createClock('UTC')

/** A temp directory that is removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflect-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export const text = (value) => ({ type: 'text', text: value })
export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })

/** One line of an assistant reply. A real reply is one such line per content block, all sharing `id` and usage. */
export function reply({
  id,
  session,
  at,
  blocks = [text('ok')],
  model = 'claude-opus-5-5',
  out = 10,
  inp = 1,
  cacheR = 0,
  cacheW = 0,
  cwd = `${HOME}/Projects/demo`,
  entrypoint = 'cli',
  effort,
}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: at,
    cwd,
    entrypoint,
    effort,
    message: {
      id,
      model,
      content: blocks,
      usage: {
        input_tokens: inp,
        output_tokens: out,
        cache_read_input_tokens: cacheR,
        cache_creation_input_tokens: cacheW,
      },
    },
  })
}

/** A prompt the person typed. `content` is a string, or an array when the prompt carried an attachment. */
export function prompt({ session, at, content = 'hello', cwd = `${HOME}/Projects/demo`, entrypoint = 'cli', isMeta }) {
  return JSON.stringify({
    type: 'user',
    sessionId: session,
    timestamp: at,
    cwd,
    entrypoint,
    isMeta,
    origin: { kind: 'human' },
    message: { role: 'user', content },
  })
}

/** A tool result: also a `user` line, never a prompt. `result` lands in `toolUseResult`. */
export function toolResult({ session, at, result = { stdout: 'done' }, cwd = `${HOME}/Projects/demo` }) {
  return JSON.stringify({
    type: 'user',
    sessionId: session,
    timestamp: at,
    cwd,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] },
    toolUseResult: result,
  })
}

export const title = ({ session, text: value }) =>
  JSON.stringify({ type: 'custom-title', customTitle: value, sessionId: session })

/** The title Claude Code makes up for a session nobody named. */
export const aiTitle = ({ session, text: value }) =>
  JSON.stringify({ type: 'ai-title', aiTitle: value, sessionId: session })
