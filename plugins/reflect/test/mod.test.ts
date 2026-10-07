// Engine tests: run with `claude plugin test plugins/reflect`, not with node.
// They drive the mod's hooks through Claude Code's own engine. The indexer is
// never run: a hook beneath the plugin answers `process.run` with a canned View,
// so no test reads anyone's history.
import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Reflect', isFocused: false, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 48 }, view: {} } as const
const SVG_LIMIT = 131072
const TABS = ['overview', 'activity', 'projects', 'models', 'tools', 'work', 'tips'] as const
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 }

/** Thirty days ending 10 March 2026, with something on every second day. Entirely made up. */
function view(over: Record<string, unknown> = {}) {
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 1, 9 + i, 12)).toISOString().slice(0, 10)
    const busy = i % 2 === 0
    return { day, prompts: busy ? 10 : 0, out: busy ? 50_000 : 0, sessions: busy ? 2 : 0, models: busy ? { 'claude-opus-5-5': 40_000, 'claude-sonnet-5': 10_000 } : {} }
  })
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0))
  hours[0][16] = 60
  hours[4][23] = 40
  return {
    version: 1,
    generatedAt: '2026-03-10T12:00:00.000Z',
    range: { id: '30d', from: '2026-02-09', to: '2026-03-10', days: 30 },
    coverage: { transcriptsFrom: '2026-02-09', historyFrom: '2025-11-01', workFrom: '2025-12-01' },
    totals: {
      prompts: 1234, activeDays: 15, sessions: 30, desktopSessions: 25, cliSessions: 5, toolCalls: 4321, projects: 2,
      activeMs: 36_000_000, out: 750_000, inp: 1000, cacheR: 970_000, cacheW: 29_000, msgs: 400, subMsgs: 1200,
      cacheHitRate: 0.97, currentStreak: 4, bestStreak: 9,
    },
    days,
    hours,
    projects: [
      { name: 'alpha-site', prompts: 800, out: 500_000, sessions: 20 },
      { name: 'beta-tool', prompts: 434, out: 250_000, sessions: 10 },
    ],
    models: [
      { name: 'claude-opus-5-5', msgs: 1000, out: 600_000, inp: 800, cacheR: 900_000, cacheW: 20_000 },
      { name: 'claude-sonnet-5', msgs: 600, out: 150_000, inp: 200, cacheR: 70_000, cacheW: 9000 },
    ],
    tools: [{ name: 'Bash', n: 3000 }, { name: 'Read', n: 1321 }],
    skills: [{ name: 'superpowers:brainstorming', n: 7 }],
    mcp: [{ name: 'github', n: 12 }],
    efforts: [{ name: 'high', n: 900 }, { name: 'max', n: 700 }],
    sessions: {
      longest: [{ title: 'The long one', project: 'alpha-site', start: 1_773_000_000_000, activeMs: 7_200_000, prompts: 12 }],
      mostPrompts: [{ title: null, project: 'beta-tool', start: 1_773_000_000_000, activeMs: 600_000, prompts: 40 }],
    },
    work: {
      types: [{ name: 'feature', n: 30 }, { name: 'bugfix', n: 12 }],
      byMonth: [{ month: '2026-02', types: { feature: 20, bugfix: 2 } }, { month: '2026-03', types: { feature: 10, bugfix: 10 } }],
      byProject: [{ name: 'alpha-site', n: 42, types: { feature: 30, bugfix: 12 } }],
    },
    previous: { prompts: 1000, sessions: 20, out: 500_000, activeMs: 1000 },
    notes: [],
    ...over,
  }
}

const ran = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const printed = (over?: Record<string, unknown>) => ran(JSON.stringify(view(over)))
const moment = () => new Promise((resolve) => setTimeout(resolve, 30))
const mounted = ($: any, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'reflect', surface, component: 'Pane', requestId: 'reflect', props: PANE })

test('/reflect opens the pane and asks the indexer for thirty days', async ($, on) => {
  const opened: unknown[] = []
  const runs: any[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('process.run', async (_$, e) => {
    runs.push(e)
    return printed()
  })

  const answer = await $.command.run({ command: 'reflect' })
  await moment()

  expect(answer.text).toBe('Reflect is open.')
  expect(opened).toEqual([{ id: 'reflect', title: 'Reflect' }])
  expect(runs.length).toBe(1)
  expect(runs[0].argv[0]).toBe('node')
  expect(runs[0].argv[1]).toMatch(/\/indexer\/cli\.mjs$/)
  expect(runs[0].argv.slice(2)).toEqual(['view', '--range', '30d'])
  expect(runs[0].init).toEqual({ timeoutMs: 180000 })
})

test('before anything is loaded the pane says it is reading', async ($) => {
  const ui = await mounted($)

  expect((await ui.find({ key: 'loading' }))?.text).toMatch(/Reading your history/)
  expect(await ui.find({ key: 'tabs' })).toBeUndefined()
})

test('the overview shows the numbers of the view, with a drawing for each chart', async ($, on) => {
  on('process.run', async () => printed())
  const ui = await mounted($)

  await ui.press({ key: 'range-30d' })

  expect((await ui.find({ key: 'tile-prompts' }))?.text).toMatch(/1,234/)
  expect((await ui.find({ key: 'tile-prompts' }))?.text).toMatch(/\+23% on the 30 days before/)
  expect((await ui.find({ key: 'tile-out' }))?.text).toMatch(/750K/)
  expect((await ui.find({ key: 'tile-out' }))?.text).toMatch(/Opus 5\.5 wrote 80%/)
  expect((await ui.find({ key: 'tile-subagents' }))?.text).toMatch(/75%/)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
  expect((await ui.find({ key: 'footnotes' }))?.text).toMatch(/Prompts since 2025-11-01/)
})

test('every tab draws on the desktop, each drawing within what an Svg may hold', async ($, on) => {
  on('process.run', async () => printed())
  mock.store(on)
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })
  const marker = { overview: 'tile-prompts', activity: 'chart-calendar', projects: 'projects-count', models: 'chart-per-day', tools: 'chart-tools', work: 'chart-types', tips: 'lines-observations' }

  for (const tab of TABS) {
    await ui.press({ key: `tab-${tab}` })

    expect((await ui.find({ key: `tab-${tab}` }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: marker[tab] })).toBeDefined()
    for (const svg of await ui.findAll({ type: 'Svg' })) {
      const source = svg.props.source as string
      expect(source.startsWith('<svg ')).toBe(true)
      expect(source.length <= SVG_LIMIT).toBe(true)
      expect((svg.props.alt as string).length > 10).toBe(true)
      expect(svg.props.isInteractive).toBe(true)
    }
  }
  expect((await ui.find({ key: 'tab-overview' }))?.props.variant).toBe('secondary')
})

test('on a terminal there are no drawings, only the totals and where the charts are', async ($, on) => {
  on('process.run', async () => printed())
  const desktop = await mounted($)
  await desktop.press({ key: 'range-30d' })

  const ui = await mounted($, 'terminal')

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /1,234 prompts, 30 sessions and 750K output tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /desktop app/ })).toBeDefined()
})

test('a range button asks for that range and becomes the chosen one', async ($, on) => {
  const asked: string[] = []
  on('process.run', async (_$, e) => {
    asked.push(e.argv.at(-1) as string)
    return printed({ range: { id: e.argv.at(-1), from: '2026-03-04', to: '2026-03-10', days: 7 } })
  })
  const ui = await mounted($)

  await ui.press({ key: 'range-7d' })

  expect(asked).toEqual(['7d'])
  expect((await ui.find({ key: 'range-7d' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'range-30d' }))?.props.variant).toBe('secondary')
})

test('without claude-mem the Work tab says why it is empty', async ($, on) => {
  on('process.run', async () => printed({ work: null }))
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })

  await ui.press({ key: 'tab-work' })

  expect((await ui.find({ key: 'work-missing' }))?.text).toMatch(/claude-mem is not installed/)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('a failed run shows the reason and a way to try again', async ($, on) => {
  let works = false
  on('process.run', async () => (works ? printed() : ran('', 1, 'reflect: the transcripts folder is missing: /nowhere\n')))
  const ui = await mounted($)

  await ui.press({ key: 'range-30d' })
  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/could not be read: the transcripts folder is missing: \/nowhere/)
  expect(await ui.find({ key: 'loading' })).toBeUndefined()

  works = true
  await ui.press({ key: 'retry' })
  expect(await ui.find({ key: 'problem' })).toBeUndefined()
  expect(await ui.find({ key: 'tile-prompts' })).toBeDefined()
})

test('output that is not a view is a failure, not a blank pane', async ($, on) => {
  let stdout = 'Segmentation fault'
  on('process.run', async () => ran(stdout))
  const ui = await mounted($)

  await ui.press({ key: 'range-30d' })
  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/did not print a view/)

  stdout = JSON.stringify({ version: 2 })
  await ui.press({ key: 'retry' })
  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/this version does not understand/)
})

test('when Node cannot be started the pane says what Reflect needs', async ($, on) => {
  on('process.run', async () => ({ deny: 'spawn node ENOENT' }))
  const ui = await mounted($)

  await ui.press({ key: 'range-30d' })

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/needs Node 22 or newer/)
})

test('a failed refresh keeps the last good view on screen', async ($, on) => {
  let works = true
  on('process.run', async () => (works ? printed() : ran('', 1, 'reflect: boom\n')))
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })

  works = false
  await ui.press({ key: 'range-7d' })

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/boom/)
  expect(await ui.find({ key: 'tile-prompts' })).toBeDefined()
})

test('an older refresh that finishes last does not replace a newer one', async ($, on) => {
  let finishSlow: (value: unknown) => void = () => {}
  on('process.run', async (_$, e) => {
    const id = e.argv.at(-1)
    if (id === '7d') return new Promise((resolve) => (finishSlow = resolve))
    return printed({ range: { id, from: '2025-12-11', to: '2026-03-10', days: 90 }, totals: { ...view().totals, prompts: 9000 } })
  })
  const ui = await mounted($)

  const slow = ui.press({ key: 'range-7d' })
  await moment()
  await ui.press({ key: 'range-90d' })
  finishSlow(printed({ totals: { ...view().totals, prompts: 7 } }))
  await slow

  expect((await ui.find({ key: 'tile-prompts' }))?.text).toMatch(/9,000/)
  expect((await ui.find({ key: 'range-90d' }))?.props.variant).toBe('primary')
})

test('suggestions are asked for with placeholders and shown with the real names', async ($, on) => {
  const asked: any[] = []
  on('process.run', async () => printed())
  on('model.complete', async (_$, e) => {
    asked.push(e)
    return { value: { isAnswered: true, text: '- project-1 takes most of your output; project-2 the rest.', usage: USAGE } }
  })
  mock.store(on)
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })
  await ui.press({ key: 'tab-tips' })
  expect(await ui.find({ key: 'tips-text' })).toBeUndefined()

  await ui.press({ key: 'tips-write' })

  expect(asked.length).toBe(1)
  expect(asked[0].model).toBe('haiku')
  expect(asked[0].maxTokens).toBe(700)
  expect(asked[0].prompt.includes('alpha-site')).toBe(false)
  expect(asked[0].prompt.includes('The long one')).toBe(false)
  expect(asked[0].prompt.includes('project-1')).toBe(true)
  const shown = (await ui.find({ key: 'tips-text' }))?.text
  expect(shown).toMatch(/alpha-site takes most of your output; beta-tool the rest\./)
  expect(shown).toMatch(/Written with 1,234 tokens\./)
})

test('suggestions written earlier for the same range and day are shown without asking again', async ($, on) => {
  let asked = 0
  on('process.run', async () => printed())
  on('model.complete', async () => {
    asked += 1
    return { value: { isAnswered: true, text: '- new', usage: USAGE } }
  })
  mock.store(on, { 'tips:30d:2026-03-10': '- saved this morning', 'tips:7d:2026-03-10': '- for another range' })
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })

  await ui.press({ key: 'tab-tips' })

  expect((await ui.find({ key: 'tips-text' }))?.text).toMatch(/saved this morning/)
  expect(asked).toBe(0)
})

test('suggestions written for one range are not shown for another', async ($, on) => {
  on('process.run', async (_$, e) => {
    const id = e.argv.at(-1)
    return id === '7d' ? printed({ range: { id, from: '2026-03-04', to: '2026-03-10', days: 7 } }) : printed()
  })
  on('model.complete', async () => ({ value: { isAnswered: true, text: '- about thirty days', usage: USAGE } }))
  mock.store(on)
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })
  await ui.press({ key: 'tab-tips' })
  await ui.press({ key: 'tips-write' })
  expect((await ui.find({ key: 'tips-text' }))?.text).toMatch(/about thirty days/)

  await ui.press({ key: 'range-7d' })
  await ui.press({ key: 'tab-tips' })

  expect(await ui.find({ key: 'tips-text' })).toBeUndefined()
  expect((await ui.find({ key: 'tips-write' }))?.props.label).toBe('Write suggestions')
})

test('a model call that is not answered says so', async ($, on) => {
  on('process.run', async () => printed())
  on('model.complete', async () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE } }))
  mock.store(on)
  const ui = await mounted($)
  await ui.press({ key: 'range-30d' })
  await ui.press({ key: 'tab-tips' })

  await ui.press({ key: 'tips-write' })

  expect((await ui.find({ key: 'tips-error' }))?.text).toMatch(/the request failed \(529\)/)
  expect(await ui.find({ key: 'tips-text' })).toBeUndefined()
})
