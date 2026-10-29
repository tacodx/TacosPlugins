// Engine tests: run with `claude plugin test plugins/board`, not with node.
// They drive the mod's hooks through Claude Code's own engine. The reader is
// never run: a hook beneath the plugin answers `process.run` with a canned View,
// so no test reads anyone's repos, sessions or plan.
import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Board', isFocused: false, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 48 }, view: {} } as const
const SVG_LIMIT = 131072
const NOW = Date.parse('2026-03-10T11:40:00Z')
const MIN = 60_000
const OPEN = [{ id: 'board', title: 'Board', isShown: true, isFocused: false, isPlaced: true }]

/** A board for 10 March 2026: three projects, two sessions at work, a plan of three rows. Entirely made up. */
function view(over: Record<string, unknown> = {}) {
  const hours = Array.from({ length: 30 }, (_, i) => {
    const start = NOW - 40 * MIN - (29 - i) * 60 * MIN
    const hour = (12 - 29 + i + 48) % 24
    return { start, day: i < 17 ? '2026-03-09' : '2026-03-10', hour, commits: i % 5 === 0 ? 0 : i % 4 }
  })
  const days = ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'].map((day, i) => ({
    day,
    total: i,
    projects: i === 0 ? {} : { alpha: i - 1, beta: 1 },
  }))
  return {
    version: 1,
    generatedAt: new Date(NOW).toISOString(),
    now: NOW,
    updated: '12:40',
    zone: 'Europe/Berlin',
    refreshMinutes: 3,
    today: '2026-03-10',
    totals: { commitsToday: 145, linesToday: 28028, commits7d: 382, projectsToday: 7, projects7d: 11 },
    hours,
    days,
    projects: [
      { name: 'alpha', commits: 15, slot: 2 },
      { name: 'beta', commits: 6, slot: 0 },
    ],
    sessions: {
      source: 'registry',
      working: [
        { name: 'Alpha · Build the thing', project: 'alpha', since: NOW - 72 * MIN },
        { name: 'Gamma · Write it up', project: 'gamma', since: NOW - 5 * MIN },
      ],
      idle: 3,
    },
    plan: {
      file: '/p/plan.md',
      done: 1,
      total: 3,
      rows: [
        { id: '1', name: 'Offer', done: true, note: 'Done 2026-03-01' },
        { id: '2', name: 'Design', done: false, note: 'Reopened 2026-03-08' },
        { id: 'B', name: 'Live board', done: false, note: '' },
      ],
    },
    repos: { count: 9, unreadable: [] },
    configFile: '~/.claude/tacos/board/config.json',
    notes: [],
    ...over,
  }
}

const ran = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const printed = (over?: Record<string, unknown>) => ran(JSON.stringify(view(over)))
const moment = () => new Promise((resolve) => setTimeout(resolve, 30))
const mounted = ($: any, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'board', surface, component: 'Pane', requestId: 'board', props: PANE })
/** The text of every drawing on screen: the numbers are inside the cards, not beside them. */
const drawn = async (ui: any) => ((await ui.findAll({ type: 'Svg' })) as any[]).map((svg) => svg.props.source as string).join('\n')
/** Opens the board as /board does and lets its first refresh finish. */
async function opened($: any, on: any, answer: () => unknown = () => printed()) {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('process.run', async () => answer())
  await $.command.run({ command: 'board' })
  await moment()
  return mounted($)
}

test('/board opens the pane and runs the reader', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: unknown[] = []
  const runs: any[] = []
  on('ui.open', async (_$, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('process.run', async (_$, e) => {
    runs.push(e)
    return printed()
  })

  const answer = await $.command.run({ command: 'board' })
  await moment()

  expect(answer.text).toBe('The board is open.')
  expect(opens).toEqual([{ id: 'board', title: 'Board' }])
  expect(runs.length).toBe(1)
  expect(runs[0].argv[0]).toBe('node')
  expect(runs[0].argv[1]).toMatch(/\/reader\/cli\.mjs$/)
  expect(runs[0].argv.slice(2)).toEqual(['view'])
  expect(runs[0].init).toEqual({ timeoutMs: 120000 })
})

test('a pane that cannot be placed says why', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('process.run', async () => printed())

  const answer = await $.command.run({ command: 'board' })
  await moment()

  expect(answer.text).toBe('The board could not be shown: no-surface')
})

test('before anything is read the pane says it is reading', async ($) => {
  const ui = await mounted($)

  expect((await ui.find({ key: 'loading' }))?.text).toMatch(/Reading your repos/)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('five cards in the order asked for, each a drawing within what an Svg may hold', async ($, on) => {
  const ui = await opened($, on)

  const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
  expect(svgs).toHaveLength(5)
  for (const id of ['kpis', 'hours', 'projects', 'sessions', 'plan']) {
    expect((await ui.find({ key: `card-${id}` }))?.children.length).toBe(1)
  }
  // In this order, top to bottom: each drawing says what it is.
  const alts = svgs.map((svg) => svg.props.alt as string)
  expect(alts[0]).toMatch(/commits and .* lines added today/)
  expect(alts[1]).toMatch(/in the last 30 hours/)
  expect(alts[2]).toBe('Commits per project in the last 7 days: alpha 15, beta 6')
  expect(alts[3]).toMatch(/^Working now: /)
  expect(alts[4]).toBe('1 of 3 done in the plan; open: 2 Design, B Live board')
  for (const svg of svgs) {
    const source = svg.props.source as string
    expect(source.startsWith('<svg ')).toBe(true)
    expect(source.length <= SVG_LIMIT).toBe(true)
    expect((svg.props.alt as string).length > 10).toBe(true)
    expect(svg.props.isInteractive).toBe(true)
  }
  expect(svgs[0].props.alt).toBe('145 commits and 28,028 lines added today; 382 commits in the last 7 days')
  expect(svgs[3].props.alt).toBe('Working now: Alpha · Build the thing, Gamma · Write it up')
})

test('the cards show the numbers, the sessions and the plan of the view', async ($, on) => {
  const ui = await opened($, on)

  const cards = await drawn(ui)
  expect(cards).toMatch(/<text class="figure stat"[^>]*>145<\/text>/)
  expect(cards).toMatch(/<text class="figure stat"[^>]*>28,028<\/text>/)
  expect(cards).toMatch(/<text class="figure stat"[^>]*>382<\/text>/)
  expect(cards).toMatch(/>COMMITS PER HOUR</)
  expect(cards).toMatch(/>alpha<title>alpha<\/title>/)
  expect(cards).toMatch(/>Alpha · Build the thing</)
  expect(cards).toMatch(/>alpha · working for 1 h 12 min</)
  expect(cards).toMatch(/>gamma · working for 5 min</)
  expect(cards).toMatch(/>2 OF 5 OPEN</)
  expect(cards).toMatch(/<text class="done"[^>]*>Offer<\/text>/)
  expect(cards).toMatch(/>Reopened 2026-03-08</)
  expect(cards).toMatch(/>1 OF 3 DONE</)
  expect((await ui.find({ key: 'footnotes' }))?.text).toMatch(/Updated 12:40\. While open it refreshes every 3 min\. Settings: ~\/\.claude\/tacos\/board\/config\.json/)
})

test('a project keeps the colour the reader gave it, in the stack and beside its session', async ($, on) => {
  const ui = await opened($, on)

  const cards = await drawn(ui)
  // Slot 2 is the third colour of the palette, slot 0 the first.
  expect(cards).toMatch(/fill="#199e70"><title>[^<]*, alpha: /)
  expect(cards).toMatch(/fill="#3987e5"><title>[^<]*, beta: /)
  expect(cards).toMatch(/<rect x="16" y="[\d.]+" width="8" height="8" rx="2" fill="#199e70"\/><text class="ink"[^>]*>Alpha · Build the thing/)
  // gamma has made no commit this week, so it has no colour of its own.
  expect(cards).toMatch(/fill="#6b685f"\/><text class="ink"[^>]*>Gamma · Write it up/)
})

test('with no plan set the plan card says where to set one', async ($, on) => {
  const ui = await opened($, on, () => printed({ plan: null }))

  const cards = await drawn(ui)
  expect(cards).toMatch(/>No plan is set\. Name a Markdown file with a table</)
  expect(cards).toMatch(/>under &quot;plan&quot; in ~\/\.claude\/tacos\/board\/config\.json\.</)
})

test('sessions known only from transcripts are said to be so', async ($, on) => {
  const ui = await opened($, on, () => printed({ sessions: { source: 'transcripts', working: [{ name: 'alpha', project: 'alpha', since: NOW - 2 * MIN }], idle: null } }))

  const cards = await drawn(ui)
  expect(cards).toMatch(/>ACTIVE IN THE LAST 10 MIN</)
  expect(cards).toMatch(/>FROM TRANSCRIPTS</)
  expect(cards).toMatch(/>alpha · last write 2 min ago</)
})

test('on a terminal there are no drawings, only the board in words', async ($, on) => {
  await opened($, on)

  const ui = await mounted($, 'terminal')

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Today: 145 commits, 28,028 lines added\. Last 7 days: 382 commits in 11 projects\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Working now: Alpha · Build the thing \(alpha\), Gamma · Write it up \(gamma\)\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Plan: 1 of 3 done\. Open: 2 Design, B Live board\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /desktop app/ })).toBeDefined()
})

test('a failed run shows the reason and a way to try again', async ($, on) => {
  let works = false
  const ui = await opened($, on, () => (works ? printed() : ran('', 1, 'board: /c/config.json is not valid JSON: Unexpected end\n')))

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/could not be read: \/c\/config\.json is not valid JSON/)
  expect(await ui.find({ key: 'loading' })).toBeUndefined()

  works = true
  await ui.press({ key: 'retry' })
  expect(await ui.find({ key: 'problem' })).toBeUndefined()
  expect(await ui.find({ key: 'card-kpis' })).toBeDefined()
})

test('output that is not a view is a failure, not a blank pane', async ($, on) => {
  let stdout = 'Segmentation fault'
  const ui = await opened($, on, () => ran(stdout))

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/did not print a view/)

  stdout = JSON.stringify({ version: 2 })
  await ui.press({ key: 'retry' })
  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/this version does not understand/)
})

test('when Node cannot be started the pane says what the board needs', async ($, on) => {
  const ui = await opened($, on, () => ({ deny: 'spawn node ENOENT' }))

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/needs Node 22 or newer/)
})

test('a failed refresh keeps the last good board on screen', async ($, on) => {
  let works = true
  const ui = await opened($, on, () => (works ? printed() : ran('', 1, 'board: boom\n')))

  works = false
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/boom/)
  expect(await ui.find({ key: 'card-kpis' })).toBeDefined()
})

test('an older refresh that finishes last does not replace a newer one', async ($, on) => {
  let finishSlow: (value: unknown) => void = () => {}
  let calls = 0
  const ui = await opened($, on, () => {
    calls += 1
    if (calls === 2) return new Promise((resolve) => (finishSlow = resolve))
    return printed({ totals: { ...view().totals, commitsToday: calls === 1 ? 145 : 900 } })
  })

  const slow = ui.press({ key: 'refresh' })
  await moment()
  await ui.press({ key: 'refresh' })
  finishSlow(printed({ totals: { ...view().totals, commitsToday: 7 } }))
  await slow

  expect(await drawn(ui)).toMatch(/<text class="figure stat"[^>]*>900<\/text>/)
})

test('while the pane is open it refreshes every few minutes, and not while it is closed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let isOpen = false
  let runs = 0
  on('command.register', () => ({ value: { command: 'board' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: isOpen ? OPEN : [] }))
  on('ui.open', async () => {
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('process.run', async () => {
    runs += 1
    return printed({ now: clock.now() })
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await clock.advance(10 * MIN)
  expect(runs).toBe(0)

  await $.command.run({ command: 'board' })
  await clock.settle()
  expect(runs).toBe(1)

  await clock.advance(2 * MIN)
  expect(runs).toBe(1)
  await clock.advance(MIN)
  expect(runs).toBe(2)
  await clock.advance(3 * MIN)
  expect(runs).toBe(3)

  isOpen = false
  await clock.advance(30 * MIN)
  expect(runs).toBe(3)
})

test('the settings say how often it refreshes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let runs = 0
  on('command.register', () => ({ value: { command: 'board' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: OPEN }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('process.run', async () => {
    runs += 1
    return printed({ refreshMinutes: 10 })
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'board' })
  await clock.settle()
  expect(runs).toBe(1)

  await clock.advance(9 * MIN)
  expect(runs).toBe(1)
  await clock.advance(MIN)
  expect(runs).toBe(2)
})
