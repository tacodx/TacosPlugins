// Engine tests: run with `claude plugin test plugins/night`, not with node.
// They drive the mod's hooks through Claude Code's own engine. `bin/night.mjs`
// is never run: a hook beneath the plugin answers `process.run` with a canned
// view, so no test touches the machine. Every name and path here is made up.
import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Night', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 48 }, view: {} } as const
const SVG_LIMIT = 131072

// A made-up night from 23:30 to 06:30 in this machine's own zone, as the pane reads it.
const START = new Date(2026, 9, 29, 23, 30).getTime()
const END = new Date(2026, 9, 30, 6, 30).getTime()
const LIMITED = new Date(2026, 9, 30, 2, 10).getTime()

function view(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    now: START - 3_600_000,
    phase: 'idle',
    date: '2026-10-29',
    window: { from: '23:30', to: '06:30' },
    armed: null,
    sessions: 2,
    workers: [],
    watchers: [],
    queue: { open: 0, taken: 0, done: 0, parked: 0, failed: 0 },
    usage: { fiveHour: 12, sevenDay: 30, resetsAt: null },
    health: { line: 'Memory and heat are fine', blockers: 0 },
    projects: [
      { name: 'alpha-site', status: 'Doing', on: true },
      { name: 'beta-tool', status: 'Planned', on: false },
    ],
    fans: { token: true, dayMode: true, nightMode: true, tokenPath: '/home/someone/.config/night/coolercontrol-token' },
    recap: null,
    problems: [],
    ...over,
  }
}

const RUNNING = {
  armed: { start: START, end: END },
  workers: [
    { slot: 1, state: 'working', project: 'alpha-site', item: 'Add the login form', since: START, limitedUntil: null },
    { slot: 2, state: 'limited', project: 'beta-tool', item: 'Split the parser', since: START, limitedUntil: LIMITED },
  ],
  watchers: [
    { name: 'health', ok: true, lastBeat: START },
    { name: 'medic', ok: false, lastBeat: START },
  ],
  queue: { open: 7, taken: 2, done: 3, parked: 1, failed: 0 },
}

const PHASES = {
  idle: view(),
  armed: view({ phase: 'armed', armed: { start: START, end: END } }),
  dusk: view({ phase: 'dusk', ...RUNNING, workers: [] }),
  night: view({ phase: 'night', ...RUNNING }),
  day: view({
    phase: 'day',
    ...RUNNING,
    recap: {
      headline: 'Two projects moved; one item parked',
      projects: [{ name: 'alpha-site', line: '40 % to 58 %, +18' }],
      artifactUrl: 'https://claude.ai/artifact/00000000-0000-0000-0000-000000000000',
    },
  }),
  stopped: view({ phase: 'stopped' }),
}

const SAID = {
  idle: 'Not armed',
  armed: 'Armed for 23:30 to 06:30',
  dusk: 'Night starting',
  night: 'Night running since 23:30',
  day: 'Morning: workers still going',
  stopped: 'Stopped',
} as const

/** `/night` as typed at the prompt. */
const NIGHT = { command: 'night', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const ran = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const printed = (shown: object) => ran(JSON.stringify(shown))
const did = (shown: object) => ran(JSON.stringify({ ok: true, view: shown }))
const mounted = ($: any, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'night', surface, component: 'Pane', requestId: 'night', props: PANE })
const card = async (ui: any) => ((await ui.find({ type: 'Svg' }))?.props.source as string | undefined) ?? ''

/** `/night`, as the person types it: the pane opens and reads the night once. */
async function open($: any, on: any) {
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: START })
  const answer = await $.command.run(NIGHT)
  await clock.settle()
  return { answer, clock }
}

/** A night that answers `view` with `shown()` and records what it was asked. */
function night(on: any, shown: () => object, actions: (args: string[]) => ReturnType<typeof ran> = (args) => did(shown())) {
  const asked: { args: string[]; init: unknown }[] = []
  on('process.run', async (_$: unknown, e: any) => {
    const args = e.argv.slice(2) as string[]
    asked.push({ args, init: e.init })
    return args[0] === 'view' ? printed(shown()) : actions(args)
  })
  return asked
}

const OPEN = { id: 'night', title: 'Night', isShown: true, isFocused: false, isPlaced: true, plugin: 'night' }

test('/night opens the pane, reads the night, and reads it again each minute until it closes', async ($, on) => {
  const opened: unknown[] = []
  const argv: unknown[] = []
  let isUp = true
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: isUp ? [OPEN] : [] }))
  on('process.run', async (_$, e) => {
    argv.push(e.argv)
    return printed(PHASES.idle)
  })
  const clock = mock.clock(on, { now: START })

  const answer = await $.command.run(NIGHT)
  await clock.settle()

  expect(answer.text).toBe('Night is open.')
  expect(opened).toEqual([{ id: 'night', title: 'Night' }])
  expect(argv.length).toBe(1)
  const first = argv[0] as string[]
  expect(first[0]).toBe('node')
  expect(first[1]).toMatch(/\/bin\/night\.mjs$/)
  expect(first.slice(2)).toEqual(['view'])

  await clock.advance(60_000)
  expect(argv.length).toBe(2)
  await clock.advance(60_000)
  expect(argv.length).toBe(3)

  // The person closes it; the next minute finds it gone and reading stops.
  isUp = false
  await clock.advance(180_000)
  expect(argv.length).toBe(3)
})

test('the session registers /night, and a pane still open after a reload is read each minute again', async ($, on) => {
  const registered: unknown[] = []
  const asked = night(on, () => PHASES.idle)
  on('command.register', async (_$, e) => {
    registered.push(e)
    return { value: { command: 'night' } }
  })
  on('ui.panes', async () => ({ value: [OPEN] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: START })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual([expect.objectContaining({ name: 'night', immediate: true })])
  expect(asked.length).toBe(0)

  await clock.advance(60_000)
  expect(asked.map((each) => each.args)).toEqual([['view']])
})

test('before the first answer the pane says it is reading', async ($) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mounted($, surface)
    expect((await ui.find({ key: 'loading' }))?.text).toMatch(/Reading tonight/)
    expect(await ui.find({ key: 'tabs' })).toBeUndefined()
    await ui.unmount()
  }
})

test('each phase is said in plain words: drawn on the desktop, written on the terminal', async ($, on) => {
  let shown: object = PHASES.idle
  night(on, () => shown)
  await open($, on)
  const desktop = await mounted($)
  const terminal = await mounted($, 'terminal')

  for (const phase of Object.keys(SAID) as (keyof typeof SAID)[]) {
    shown = PHASES[phase]
    await desktop.press({ key: 'refresh' })

    const source = await card(desktop)
    expect(source.startsWith('<svg ')).toBe(true)
    expect(source.length <= SVG_LIMIT).toBe(true)
    expect(source).toMatch(new RegExp(`>${SAID[phase]}<`))
    expect(((await desktop.find({ type: 'Svg' }))?.props.alt as string).startsWith(`${SAID[phase]}.`)).toBe(true)

    expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(await terminal.find({ type: 'Text', text: SAID[phase] })).toBeDefined()
  }
})

test('a running night shows each worker, the watchers, the queue and usage', async ($, on) => {
  night(on, () => PHASES.night)
  await open($, on)
  const until = '02:10'
  const terminal = await mounted($, 'terminal')
  const desktop = await mounted($)

  expect(await terminal.find({ type: 'Text', text: '1. alpha-site: Add the login form, working' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: `2. beta-tool: Split the parser, limited until ${until}` })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'Watchers: medic is late' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'Queue: 7 open, 3 done, 1 parked' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'Usage: 12 % of five hours, 30 % of the week' })).toBeDefined()

  const source = await card(desktop)
  expect(source).toMatch(/>alpha-site</)
  expect(source).toMatch(new RegExp(`>limited until ${until}<`))
  expect(source).toMatch(/class="late"[^>]*>medic is late</)
})

test('the morning shows the last recap, its project lines and the link to it', async ($, on) => {
  night(on, () => PHASES.day)
  await open($, on)

  const desktop = await mounted($)
  expect(await card(desktop)).toMatch(/>alpha-site, 40 % to 58 %, \+18</)
  expect((await desktop.find({ type: 'Link' }))?.props.href).toBe('https://claude.ai/artifact/00000000-0000-0000-0000-000000000000')

  const terminal = await mounted($, 'terminal')
  expect(await terminal.find({ type: 'Text', text: 'Last recap: Two projects moved; one item parked' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'alpha-site, 40 % to 58 %, +18' })).toBeDefined()
})

test('Arm sends arm, and the pane then offers Disarm', async ($, on) => {
  let shown: object = PHASES.idle
  const asked = night(on, () => shown, (args) => {
    shown = args[0] === 'arm' ? PHASES.armed : PHASES.idle
    return did(shown)
  })
  await open($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    shown = PHASES.idle
    const ui = await mounted($, surface)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: 'disarm' })).toBeUndefined()
    expect(await ui.find({ key: 'stop' })).toBeUndefined()

    await ui.press({ key: 'arm' })

    const sent = asked.at(-1)
    expect(sent?.args).toEqual(['arm'])
    expect(sent?.init).toEqual({ timeoutMs: 120000 })
    expect(await ui.find({ key: 'arm' })).toBeUndefined()
    expect(await ui.find({ key: 'disarm' })).toBeDefined()
    expect(await ui.find({ key: 'start' })).toBeDefined()
    await ui.unmount()
  }
})

test('Stop asks once, and only a second click stops the night', async ($, on) => {
  let shown: object = PHASES.night
  const asked = night(on, () => shown, (args) => {
    if (args[0] === 'stop') shown = PHASES.stopped
    return did(shown)
  })
  await open($, on)
  const ui = await mounted($)
  expect(await ui.find({ key: 'arm' })).toBeUndefined()
  expect(await ui.find({ key: 'start' })).toBeUndefined()

  await ui.press({ key: 'stop' })
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('Stop the night? Click again')
  expect(asked.some((each) => each.args[0] === 'stop')).toBe(false)

  // Anything else pressed takes the question back.
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('Stop')

  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(asked.filter((each) => each.args[0] === 'stop').map((each) => each.args)).toEqual([['stop']])
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'arm' })).toBeDefined()
  expect(await card(ui)).toMatch(/>Stopped</)
})

test('Settings saves From and To with set, on Save and on Enter', async ($, on) => {
  const asked = night(on, () => PHASES.idle)
  await open($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mounted($, surface)
    await ui.press({ key: 'tab-settings' })
    expect((await ui.find({ key: 'from' }))?.props.value).toBe('23:30')

    await ui.input({ key: 'from', text: '22:00', kind: 'change' })
    await ui.input({ key: 'to', text: '7:15', kind: 'change' })
    await ui.press({ key: 'save-window' })
    expect(asked.at(-1)?.args).toEqual(['set', '22:00', '07:15'])

    await ui.input({ key: 'to', text: '05:45' })
    expect(asked.at(-1)?.args).toEqual(['set', '23:30', '05:45'])

    await ui.press({ key: 'tab-tonight' })
    await ui.unmount()
  }
})

test('a time that is no time of day is not sent', async ($, on) => {
  const asked = night(on, () => PHASES.idle)
  await open($, on)
  const ui = await mounted($)
  await ui.press({ key: 'tab-settings' })
  const before = asked.length

  await ui.input({ key: 'from', text: '25:00' })

  expect(asked.length).toBe(before)
  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/times of day, like 23:30/)
  expect((await ui.find({ key: 'from' }))?.props.value).toBe('25:00')
})

test('Sessions and the project toggles send their commands', async ($, on) => {
  const asked = night(on, () => PHASES.idle)
  await open($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mounted($, surface)
    await ui.press({ key: 'tab-settings' })
    expect((await ui.find({ key: 'sessions' }))?.props.value).toBe('2')
    expect((await ui.find({ key: 'project-alpha-site' }))?.props.label).toBe('On')
    expect((await ui.find({ key: 'row-beta-tool' }))?.text).toMatch(/beta-tool.*Planned/)

    await ui.select({ key: 'sessions', value: '3' })
    expect(asked.at(-1)?.args).toEqual(['sessions', '3'])

    await ui.press({ key: 'project-beta-tool' })
    expect(asked.at(-1)?.args).toEqual(['project', 'beta-tool', 'on'])
    await ui.press({ key: 'project-alpha-site' })
    expect(asked.at(-1)?.args).toEqual(['project', 'alpha-site', 'off'])

    await ui.press({ key: 'tab-tonight' })
    await ui.unmount()
  }
})

test('the fans line guides to what is missing, and never asks for the token', async ($, on) => {
  let shown: object = view({ fans: { token: false, dayMode: false, nightMode: false, tokenPath: '/home/someone/.config/night/coolercontrol-token' } })
  night(on, () => shown)
  await open($, on)
  const ui = await mounted($, 'terminal')
  await ui.press({ key: 'tab-settings' })

  const fans = (await ui.find({ key: 'fans' }))?.text ?? ''
  expect(fans).toMatch(/no CoolerControl token, Day mode or Night mode found yet/)
  expect(fans).toMatch(/make a mode called Day from your current fans and one called Night/)
  expect(fans).toMatch(/save an access token to \/home\/someone\/\.config\/night\/coolercontrol-token/)
  expect((await ui.findAll({ type: 'Input' })).map((each: { key?: string }) => each.key)).toEqual(['from', 'to'])

  shown = view()
  await ui.press({ key: 'tab-tonight' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-settings' })
  expect((await ui.find({ key: 'fans' }))?.text).toMatch(/token and the Day and Night modes are there/)
})

test('a refused action keeps the view on screen and says why', async ($, on) => {
  night(on, () => PHASES.idle, () => ran(JSON.stringify({ ok: false, error: 'the systemd user manager is not running' }), 1))
  await open($, on)
  const ui = await mounted($)

  await ui.press({ key: 'arm' })

  expect((await ui.find({ key: 'problem' }))?.text).toBe('the systemd user manager is not running')
  expect(await card(ui)).toMatch(/>Not armed</)
  expect(await ui.find({ key: 'busy' })).toBeUndefined()
})

test('when night cannot be run the pane says what it needs, and Try again reads again', async ($, on) => {
  let works = false
  on('process.run', async () => (works ? printed(PHASES.idle) : { deny: 'spawn node ENOENT' }))
  await open($, on)
  const ui = await mounted($)

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/Tonight could not be read: night could not be run\. It needs Node 22/)
  expect(await ui.find({ key: 'loading' })).toBeUndefined()

  works = true
  await ui.press({ key: 'retry' })
  expect(await ui.find({ key: 'problem' })).toBeUndefined()
  expect(await card(ui)).toMatch(/>Not armed</)
})

test('output that is not a view is a failure, not a blank pane', async ($, on) => {
  on('process.run', async () => ran('Segmentation fault'))
  await open($, on)
  const ui = await mounted($)

  expect((await ui.find({ key: 'problem' }))?.text).toMatch(/did not print a view/)
})
