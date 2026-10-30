// The text of every systemd user unit night installs, and the install and uninstall
// of those files. The builders are pure: paths, counts and instants come in as
// arguments and text comes out, so tests read the units without touching systemd.
// writeUnits and removeUnits touch the disk; removal reads and deletes through an
// injected fs, writing always goes through the atomic writeText of fsx.mjs.
//
// Every program path in an ExecStart is absolute. systemd expands $HOME to nothing
// in some contexts, and that once broke a night, so no shortcut is ever used there.
import { readFileSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { writeText } from './fsx.mjs'

const WRITTEN = 'Written by `night install`; `night uninstall` removes only files that open with this line.'
const LONG_RUNNING = ['conductor', 'health', 'logs', 'usage', 'medic']

/** Every static unit file, in the order they are listed. The two dusk and dawn timers are in TIMER_NAMES. */
export const UNIT_NAMES = Object.freeze([
  'night.target',
  'night.slice',
  ...LONG_RUNNING.map((name) => `night-${name}.service`),
  'night-worker@.service',
  'night-power.service',
  'night-inhibit.service',
  'night-dusk.service',
  'night-dawn.service',
  'night-stop.service',
  'night-keeper.service',
  'night-keeper.timer',
])

/** The timers `night arm` writes with the exact instants of one night. */
export const TIMER_NAMES = Object.freeze(['night-dusk.timer', 'night-dawn.timer'])

function sessionCount(sessions) {
  if (!Number.isInteger(sessions) || sessions < 1) throw new Error(`sessions is not a whole number from 1: ${sessions}`)
  return sessions
}

/** The worker instances for `sessions` workers: night-worker@1.service and on. */
export function workerUnits(sessions) {
  return Array.from({ length: sessionCount(sessions) }, (_, i) => `night-worker@${i + 1}.service`)
}

/** `text` when it is a one-line string, else a throw: a line break would write a second unit setting. */
function oneLine(text, label) {
  if (typeof text !== 'string' || text === '') throw new Error(`${label} is missing`)
  if (/[\r\n]/.test(text)) throw new Error(`${label} has a line break`)
  return text
}

function absolutePath(path, label) {
  if (!isAbsolute(oneLine(path, label))) throw new Error(`${label} is not an absolute path: ${path}`)
  return path
}

/** One word of an ExecStart line: quoted when it holds a space or quote, with % and $ doubled. */
function execWord(text) {
  const escaped = text.replaceAll('%', '%%').replaceAll('$', () => '$$')
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : escaped
}

/** An Environment= line; systemd expands % there but not $. */
function envLine(name, value) {
  const assignment = `${name}=${value}`.replaceAll('%', '%%')
  return `Environment=${/[\s"'\\]/.test(assignment) ? `"${assignment.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : assignment}`
}

/** The comment line, then each [Section] with its lines (empty entries dropped), as a unit file. */
function render(what, sections) {
  const body = Object.entries(sections).map(([title, lines]) => `[${title}]\n${lines.filter(Boolean).join('\n')}`)
  return `# night: ${what}. ${WRITTEN}\n\n${body.join('\n\n')}\n`
}

/** The text of every static unit, by file name. `nightHome` is only for test installs. */
export function buildUnits({ node, cli, sessions, memoryHigh, memoryMax, pathEnv, nightHome, nightShare, sliceMax = '18G' }) {
  absolutePath(node, 'node')
  absolutePath(cli, 'cli')
  oneLine(memoryHigh, 'memoryHigh')
  oneLine(memoryMax, 'memoryMax')
  const environment = [
    pathEnv === undefined ? '' : envLine('PATH', oneLine(pathEnv, 'pathEnv')),
    nightHome === undefined ? '' : envLine('NIGHT_HOME', absolutePath(nightHome, 'nightHome')),
    nightShare === undefined ? '' : envLine('NIGHT_SHARE', absolutePath(nightShare, 'nightShare')),
  ]
  const night = (...words) => `ExecStart=${[execWord(node), execWord(cli), ...words].join(' ')}`
  const workers = workerUnits(sessions)
  const members = [...LONG_RUNNING.map((name) => `night-${name}.service`), ...workers].join(' ')
  const never = 'StartLimitIntervalSec=0'
  const units = {
    'night.target': render('the target that groups the night services', {
      Unit: ['Description=Night: everything that runs during the night', `Wants=${members}`, `After=${members}`],
    }),
  }
  for (const name of LONG_RUNNING) {
    units[`night-${name}.service`] = render(`the ${name} service`, {
      Unit: [`Description=Night ${name}`, 'PartOf=night.target', never],
      Service: ['Type=simple', night('run', name), 'Restart=always', 'RestartSec=5', 'WorkingDirectory=%h', ...environment],
    })
  }
  // All workers share one slice with a ceiling, and none may push its memory into swap: the
  // kernel ends a runaway test inside the night instead of letting the machine thrash.
  units['night.slice'] = render('the slice every worker runs in, with one memory ceiling for all of them', {
    Unit: ['Description=Night workers'],
    Slice: [`MemoryMax=${oneLine(sliceMax, 'sliceMax')}`, 'MemorySwapMax=0'],
  })
  units['night-worker@.service'] = render('the worker service, one instance per session', {
    Unit: ['Description=Night worker %i', 'PartOf=night.target', never],
    Service: [
      'Type=simple', night('worker', '%i'), 'Restart=always', 'RestartSec=10', 'Slice=night.slice',
      `MemoryHigh=${memoryHigh}`, `MemoryMax=${memoryMax}`, 'MemorySwapMax=0', 'OOMPolicy=continue', 'KillMode=control-group', 'TimeoutStopSec=60', 'Nice=5',
      'WorkingDirectory=%h', ...environment,
    ],
  })
  units['night-power.service'] = render('the service that holds the power-saver profile, started by dusk and stopped by dawn', {
    Unit: ['Description=Night power-saver profile', never],
    Service: [
      'Type=simple',
      'ExecStart=/usr/bin/powerprofilesctl launch -p power-saver -r night -- /usr/bin/sleep infinity',
      'Restart=on-failure', 'RestartSec=30', ...environment,
    ],
  })
  units['night-inhibit.service'] = render('the service that blocks sleep, started by dusk and stopped by dawn', {
    Unit: ['Description=Night sleep inhibitor', never],
    Service: [
      'Type=simple',
      'ExecStart=/usr/bin/systemd-inhibit --what=sleep --who=night --why=night-is-working --mode=block /usr/bin/sleep infinity',
      'Restart=always', 'RestartSec=10', ...environment,
    ],
  })
  for (const [step, what, verb] of [['dusk', 'starts the night', 'dusk'], ['dawn', 'ends the night', 'dawn'], ['stop', 'stops the night when the owner presses Stop', 'stop-now']]) {
    units[`night-${step}.service`] = render(`the one-shot that ${what}`, {
      Unit: [`Description=Night ${step}`],
      Service: ['Type=oneshot', night(verb), 'TimeoutStartSec=20min', 'WorkingDirectory=%h', ...environment],
    })
  }
  units['night-keeper.service'] = render('the one-shot that brings a night in progress back after a reboot or a crash', {
    Unit: ['Description=Night keeper'],
    Service: ['Type=oneshot', night('keep'), 'TimeoutStartSec=5min', 'WorkingDirectory=%h', ...environment],
  })
  units['night-keeper.timer'] = render('the timer that runs the keeper', {
    Unit: ['Description=Night keeper, every two minutes'],
    Timer: ['OnBootSec=1min', 'OnUnitActiveSec=2min', 'AccuracySec=10s'],
    Install: ['WantedBy=timers.target'],
  })
  return units
}

/** The dusk and dawn timers. Both values are OnCalendar text, e.g. '2026-10-29 22:30:00 UTC'. */
export function buildTimers({ dusk, dawn }) {
  const timer = (step, what, when) => render(`the timer that ${what}`, {
    Unit: [`Description=Night ${step} timer`],
    Timer: [`OnCalendar=${oneLine(when, step)}`, 'Persistent=true', 'AccuracySec=1s', 'RemainAfterElapse=false'],
    Install: ['WantedBy=timers.target'],
  })
  return {
    'night-dusk.timer': timer('dusk', 'starts the night at one exact instant', dusk),
    'night-dawn.timer': timer('dawn', 'ends the night at one exact instant', dawn),
  }
}

function unitPath(dir, name) {
  if (name !== basename(name) || name === '' || name === '.' || name === '..') throw new Error(`not a unit name: ${name}`)
  return join(dir, name)
}

function readOrNull(fs, path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Whether `text` opens with the comment line that `night install` writes. */
function isOurs(text) {
  const first = text.split('\n', 1)[0]
  return first.startsWith('# night: ') && first.includes('Written by `night install`')
}

/** Writes each file (name -> text) into `dir` atomically. Returns the names whose content changed. */
export function writeUnits(dir, files, { fs = { readFileSync } } = {}) {
  const changed = []
  for (const [name, text] of Object.entries(files)) {
    const path = unitPath(dir, name)
    if (readOrNull(fs, path) === text) continue
    writeText(path, text, { mode: 0o644 })
    changed.push(name)
  }
  return changed
}

/** Deletes the named files from `dir` that night wrote, and returns those it deleted. Anything else stays. */
export function removeUnits(dir, names, { fs = { readFileSync, unlinkSync } } = {}) {
  const removed = []
  for (const name of names) {
    const path = unitPath(dir, name)
    const text = readOrNull(fs, path)
    if (text === null || !isOurs(text)) continue
    fs.unlinkSync(path)
    removed.push(name)
  }
  return removed
}
