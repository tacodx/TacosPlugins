import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createClock } from '../indexer/clock.mjs'
import { projectOf, scanLines } from '../indexer/scan.mjs'
import { aiTitle, HOME, prompt, reply, text, title, toolResult, toolUse, utc } from './helpers.mjs'

const S = 'session-1'
const main = (fileId = S, clock = utc) => ({ kind: 'main', fileId, home: HOME, clock })
const sub = () => ({ kind: 'sub', fileId: 'agent-a1', home: HOME, clock: utc })
const DAY = '2026-03-01'
const at = (time) => `${DAY}T${time}.000Z`

test('a reply written as three lines counts its usage once', () => {
  const usage = { id: 'm1', session: S, at: at('10:00:00'), out: 100, inp: 3, cacheR: 50, cacheW: 7 }
  const summary = scanLines(
    [
      reply({ ...usage, blocks: [{ type: 'thinking', thinking: '' }] }),
      reply({ ...usage, blocks: [text('hi')] }),
      reply({ ...usage, blocks: [toolUse('t1', 'Bash')] }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.msgs, 1)
  assert.equal(day.out, 100)
  assert.equal(day.inp, 3)
  assert.equal(day.cacheR, 50)
  assert.equal(day.cacheW, 7)
  assert.deepEqual(day.models, { 'claude-opus-5-5': { msgs: 1, out: 100, inp: 3, cacheR: 50, cacheW: 7 } })
  assert.deepEqual(day.tools, { Bash: 1 })
})

// Measured on real transcripts: in a subagent file the first line of a reply has
// the usage as it stood mid-stream (often 1 or 2 output tokens) and only the last
// line has the final figure. Counting the first line lost 62% of all output tokens.
test("a reply's usage is the largest any of its lines reports", () => {
  const line = (out, cacheW) => reply({ id: 'm1', session: 'parent', at: at('10:00:00'), out, inp: 3, cacheR: 50, cacheW })
  const day = scanLines([line(2, 7), line(2, 7), line(900, 6)], sub()).days[DAY]

  assert.equal(day.out, 900)
  assert.equal(day.cacheW, 7) // a field that shrinks keeps the larger value
  assert.equal(day.inp, 3)
  assert.equal(day.cacheR, 50)
  assert.equal(day.subMsgs, 1)
  assert.deepEqual(day.models, { 'claude-opus-5-5': { msgs: 1, out: 900, inp: 3, cacheR: 50, cacheW: 7 } })
})

test('a reply that grows is counted on the day of its first line, and in its session', () => {
  const summary = scanLines(
    [
      reply({ id: 'm1', session: S, at: '2026-03-01T23:59:59.000Z', out: 5 }),
      reply({ id: 'm1', session: S, at: '2026-03-02T00:00:01.000Z', out: 80 }),
    ],
    main(),
  )

  assert.equal(summary.days['2026-03-01'].out, 80)
  assert.equal(summary.days['2026-03-01'].msgs, 1)
  assert.equal(summary.days['2026-03-02'].out, 0)
  assert.equal(summary.days['2026-03-02'].msgs, 0)
  assert.equal(summary.session.out, 80)
})

test('a tool call is counted once per tool_use id, even when its line repeats', () => {
  const line = reply({ id: 'm1', session: S, at: at('10:00:00'), blocks: [toolUse('t1', 'Bash')] })
  const summary = scanLines(
    [line, line, reply({ id: 'm1', session: S, at: at('10:00:00'), blocks: [toolUse('t2', 'Read')] })],
    main(),
  )

  assert.deepEqual(summary.days[DAY].tools, { Bash: 1, Read: 1 })
})

test('in a main file, records carrying another session id are copies and are skipped', () => {
  const summary = scanLines(
    [
      title({ session: 'older', text: 'Old title' }),
      prompt({ session: 'older', at: at('09:00:00') }),
      reply({ id: 'm0', session: 'older', at: at('09:00:01'), out: 100 }),
      reply({ id: 'm1', session: S, at: at('10:00:00'), out: 5 }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.out, 5)
  assert.equal(day.msgs, 1)
  assert.equal(day.prompts, 0)
  assert.equal(summary.title, undefined)
})

test('a prompt is a user line whose own origin is human, with string or array content', () => {
  const summary = scanLines(
    [
      prompt({ session: S, at: at('10:00:00') }),
      prompt({ session: S, at: at('10:01:00'), content: [text('look'), { type: 'image', source: {} }] }),
      prompt({ session: S, at: at('10:02:00'), isMeta: true }),
      toolResult({ session: S, at: at('10:03:00') }),
      // Passes the cheap pre-filter because the words are on the line, but its own origin is not human.
      toolResult({ session: S, at: at('10:04:00'), result: { origin: { kind: 'human' } } }),
    ],
    main(),
  )

  assert.equal(summary.days[DAY].prompts, 2)
  assert.equal(summary.session.prompts, 2)
})

test('a subagent file adds to subMsgs, keeps records of its parent session, and is no session itself', () => {
  const summary = scanLines(
    [
      prompt({ session: 'parent', at: at('10:00:00') }),
      reply({ id: 'm1', session: 'parent', at: at('10:00:01'), out: 20 }),
      reply({ id: 'm2', session: 'parent', at: at('10:01:01'), out: 1 }),
      aiTitle({ session: 'parent', text: 'Not this file\'s to keep' }),
    ],
    sub(),
  )
  const day = summary.days[DAY]

  assert.equal(day.subMsgs, 2)
  assert.equal(day.msgs, 0)
  assert.equal(day.out, 21)
  assert.equal(day.prompts, 0)
  assert.equal(day.activeMs, 0) // busy time is a session's, and the session is the main file
  assert.equal(summary.session, undefined)
  assert.equal(summary.title, undefined)
})

test('a synthetic reply is ignored entirely', () => {
  const summary = scanLines(
    [reply({ id: 'm1', session: S, at: at('10:00:00'), model: '<synthetic>', blocks: [toolUse('t1', 'Bash')] })],
    main(),
  )

  assert.deepEqual(summary.days, {})
})

test('skills and MCP servers are read out of tool calls', () => {
  const summary = scanLines(
    [
      reply({
        id: 'm1',
        session: S,
        at: at('10:00:00'),
        blocks: [
          toolUse('a', 'Skill', { skill: 'superpowers:brainstorming' }),
          toolUse('b', 'mcp__github__create_issue'),
          toolUse('c', 'mcp__github__get_issue'),
          toolUse('d', 'Bash'),
        ],
      }),
    ],
    main(),
  )
  const day = summary.days[DAY]

  assert.deepEqual(day.tools, { Skill: 1, mcp__github__create_issue: 1, mcp__github__get_issue: 1, Bash: 1 })
  assert.deepEqual(day.skills, { 'superpowers:brainstorming': 1 })
  assert.deepEqual(day.mcp, { github: 2 })
})

test('days and hours are local to the clock it is given', () => {
  const lines = [prompt({ session: S, at: '2026-03-01T23:30:00.000Z' })]

  const inUtc = scanLines(lines, main())
  assert.equal(inUtc.days['2026-03-01'].hours[23], 1)

  const inBerlin = scanLines(lines, main(S, createClock('Europe/Berlin')))
  assert.equal(inBerlin.days['2026-03-01'], undefined)
  assert.equal(inBerlin.days['2026-03-02'].hours[0], 1)
})

test('active time sums the gaps under five minutes; a gap of exactly five is not one', () => {
  const summary = scanLines(
    [
      prompt({ session: S, at: at('10:00:00') }),
      reply({ id: 'm1', session: S, at: at('10:02:00') }), // 2 min: counts
      reply({ id: 'm2', session: S, at: at('10:07:00') }), // exactly 5 min: does not
      reply({ id: 'm3', session: S, at: at('10:08:30') }), // 90 s: counts
    ],
    main(),
  )

  assert.equal(summary.days[DAY].activeMs, 210_000)
  assert.deepEqual(summary.session, {
    start: Date.parse(at('10:00:00')),
    end: Date.parse(at('10:08:30')),
    activeMs: 210_000,
    prompts: 1,
    out: 30,
  })
})

test('projectOf names a project by its folder under home, and a worktree by its parent', () => {
  const cases = [
    [`${HOME}/Projects/demo`, 'demo'],
    [`${HOME}/Projects/demo/.claude/worktrees/keen-fox-1a2b3c`, 'demo'],
    [`${HOME}/Projects/demo/.superpowers/sdd/2026-01-01-x`, 'demo'],
    [`${HOME}/Projects/clients/acme`, 'clients/acme'],
    [`${HOME}/notes`, 'notes'],
    [HOME, '~'],
    ['/srv/data/site', '/srv/data/site'],
    ['/home/uther/x', '/home/uther/x'], // home is only a prefix of this name
    [undefined, '(unknown)'],
  ]

  for (const [cwd, expected] of cases) assert.equal(projectOf(cwd, HOME), expected, String(cwd))
})

test('the project and the entry point are the first ones seen; the title is the last', () => {
  const summary = scanLines(
    [
      title({ session: S, text: 'First' }),
      prompt({ session: S, at: at('10:00:00'), cwd: `${HOME}/Projects/alpha`, entrypoint: 'claude-desktop' }),
      reply({ id: 'm1', session: S, at: at('10:00:01'), cwd: `${HOME}/Projects/beta`, entrypoint: 'cli' }),
      title({ session: S, text: 'Second' }),
    ],
    main(),
  )

  assert.equal(summary.project, 'alpha')
  assert.equal(summary.entrypoint, 'claude-desktop')
  assert.equal(summary.title, 'Second')
})

test("the person's own title wins over the one Claude Code made up, which is the fallback", () => {
  const named = scanLines(
    [
      aiTitle({ session: S, text: 'Auto' }),
      title({ session: S, text: 'Mine' }),
      aiTitle({ session: S, text: 'Auto again' }),
      prompt({ session: S, at: at('10:00:00') }),
    ],
    main(),
  )
  assert.equal(named.title, 'Mine')

  const unnamed = scanLines(
    [aiTitle({ session: S, text: 'Auto' }), aiTitle({ session: S, text: 'Auto again' }), prompt({ session: S, at: at('10:00:00') })],
    main(),
  )
  assert.equal(unnamed.title, 'Auto again')
})

test('a record with no believable time, or that is not a record at all, is skipped and counted', () => {
  const summary = scanLines(
    [
      reply({ id: 'm1', session: S, at: 'never', out: 100 }),
      reply({ id: 'm2', session: S, at: '1970-01-01T00:00:00.000Z', out: 100 }),
      prompt({ session: S, at: '2500-01-01T00:00:00.000Z' }),
      JSON.stringify([{ type: 'assistant' }]),
      reply({ id: 'm3', session: S, at: at('10:00:00'), out: 4 }),
    ],
    main(),
  )

  assert.equal(summary.bad, 4)
  assert.deepEqual(Object.keys(summary.days), [DAY])
  assert.equal(summary.days[DAY].out, 4)
})

test('a line that does not parse is counted and the rest still scanned', () => {
  const summary = scanLines(
    ['{"type":"assistant", broken', reply({ id: 'm1', session: S, at: at('10:00:00'), out: 4 })],
    main(),
  )

  assert.equal(summary.bad, 1)
  assert.equal(summary.days[DAY].out, 4)
})

test('effort levels are counted once per reply', () => {
  const summary = scanLines(
    [
      reply({ id: 'm1', session: S, at: at('10:00:00'), effort: 'high' }),
      reply({ id: 'm1', session: S, at: at('10:00:00'), effort: 'high' }),
      reply({ id: 'm2', session: S, at: at('10:00:01'), effort: 'max' }),
    ],
    main(),
  )

  assert.deepEqual(summary.days[DAY].efforts, { high: 1, max: 1 })
})

// Names come from the data. `map.constructor` is a function on every plain object.
test('a tool or a model named like an Object property is still just a name', () => {
  const summary = scanLines(
    [reply({ id: 'm1', session: S, at: at('10:00:00'), model: 'constructor', out: 9, blocks: [toolUse('t1', 'constructor')] })],
    main(),
  )
  const day = summary.days[DAY]

  assert.equal(day.tools.constructor, 1)
  assert.equal(day.models.constructor.out, 9)
})

test('a file with no usable record has no session and no days', () => {
  const summary = scanLines(['{"type":"system"}', ''], main())

  assert.deepEqual(summary.days, {})
  assert.equal(summary.session, undefined)
  assert.equal(summary.project, '(unknown)')
})
