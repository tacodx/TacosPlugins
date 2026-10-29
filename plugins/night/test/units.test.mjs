import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  TIMER_NAMES, UNIT_NAMES, buildTimers, buildUnits, removeUnits, workerUnits, writeUnits,
} from '../engine/units.mjs'
import { tempDir } from './helpers.mjs'

const base = {
  node: '/usr/bin/node',
  cli: '/opt/tacos/plugins/night/bin/night.mjs',
  sessions: 2,
  memoryHigh: '5G',
  memoryMax: '6G',
  pathEnv: '/usr/local/bin:/usr/bin:/bin',
}

const LONG = ['conductor', 'health', 'logs', 'usage', 'medic']

/** The value of the first `key=` line, or undefined. */
function value(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`))
  return line === undefined ? undefined : line.slice(key.length + 1)
}

test('the units are exactly the static names, and each opens with the marker line', () => {
  const units = buildUnits(base)
  assert.deepEqual(Object.keys(units).sort(), [...UNIT_NAMES].sort())
  for (const [name, text] of Object.entries(units)) {
    const first = text.split('\n')[0]
    assert.match(first, /^# night: .+Written by `night install`/, name)
    assert.ok(text.endsWith('\n'), name)
  }
})

test('the target wants the five services and exactly N workers, for N of 1 and 4', () => {
  for (const sessions of [1, 4]) {
    const target = buildUnits({ ...base, sessions })['night.target']
    const wants = value(target, 'Wants').split(' ')
    const workers = wants.filter((w) => w.startsWith('night-worker@'))
    assert.deepEqual(workers, workerUnits(sessions))
    assert.equal(workers.length, sessions)
    for (const name of LONG) assert.ok(wants.includes(`night-${name}.service`), name)
    assert.equal(wants.length, 5 + sessions)
    assert.equal(value(target, 'After'), value(target, 'Wants'))
    assert.ok(!target.includes('[Install]'))
  }
})

test('workerUnits counts from 1 and refuses a nonsense count', () => {
  assert.deepEqual(workerUnits(3), ['night-worker@1.service', 'night-worker@2.service', 'night-worker@3.service'])
  assert.throws(() => workerUnits(0), /sessions/)
  assert.throws(() => workerUnits(1.5), /sessions/)
})

test('every long-running service restarts for ever and belongs to the target', () => {
  const units = buildUnits(base)
  for (const name of LONG) {
    const text = units[`night-${name}.service`]
    assert.equal(value(text, 'Type'), 'simple', name)
    assert.equal(value(text, 'Restart'), 'always', name)
    assert.equal(value(text, 'RestartSec'), '5', name)
    assert.equal(value(text, 'StartLimitIntervalSec'), '0', name)
    assert.equal(value(text, 'PartOf'), 'night.target', name)
    assert.equal(value(text, 'WorkingDirectory'), '%h', name)
    assert.equal(value(text, 'Environment'), `PATH=${base.pathEnv}`, name)
    assert.equal(value(text, 'ExecStart'), `${base.node} ${base.cli} run ${name}`, name)
  }
})

test('the worker template caps memory, kills the whole group and never gives up', () => {
  const worker = buildUnits({ ...base, memoryHigh: '3G', memoryMax: '4G' })['night-worker@.service']
  assert.equal(value(worker, 'ExecStart'), `${base.node} ${base.cli} worker %i`)
  assert.equal(value(worker, 'Restart'), 'always')
  assert.equal(value(worker, 'RestartSec'), '10')
  assert.equal(value(worker, 'StartLimitIntervalSec'), '0')
  assert.equal(value(worker, 'PartOf'), 'night.target')
  assert.equal(value(worker, 'MemoryHigh'), '3G')
  assert.equal(value(worker, 'MemoryMax'), '4G')
  assert.equal(value(worker, 'KillMode'), 'control-group')
  assert.equal(value(worker, 'TimeoutStopSec'), '60')
  assert.equal(value(worker, 'Nice'), '5')
  assert.equal(value(worker, 'WorkingDirectory'), '%h')
})

test('power and inhibit are started by dusk, not by the target', () => {
  const units = buildUnits(base)
  const power = units['night-power.service']
  assert.equal(
    value(power, 'ExecStart'),
    '/usr/bin/powerprofilesctl launch -p power-saver -r night -- /usr/bin/sleep infinity',
  )
  assert.equal(value(power, 'Restart'), 'on-failure')
  assert.equal(value(power, 'RestartSec'), '30')
  assert.equal(value(power, 'StartLimitIntervalSec'), '0')
  const inhibit = units['night-inhibit.service']
  assert.match(value(inhibit, 'ExecStart'), /^\/usr\/bin\/systemd-inhibit --what=sleep --who=night --why=\S+ --mode=block \/usr\/bin\/sleep infinity$/)
  assert.equal(value(inhibit, 'Restart'), 'always')
  assert.equal(value(inhibit, 'RestartSec'), '10')
  assert.equal(value(inhibit, 'StartLimitIntervalSec'), '0')
  for (const text of [power, inhibit]) assert.equal(value(text, 'PartOf'), undefined)
  assert.ok(!value(units['night.target'], 'Wants').includes('night-power'))
  assert.ok(!value(units['night.target'], 'Wants').includes('night-inhibit'))
})

test('dusk and dawn are oneshots the medic retries, the keeper runs on a timer', () => {
  const units = buildUnits(base)
  for (const step of ['dusk', 'dawn']) {
    const text = units[`night-${step}.service`]
    assert.equal(value(text, 'Type'), 'oneshot')
    assert.equal(value(text, 'ExecStart'), `${base.node} ${base.cli} ${step}`)
    assert.equal(value(text, 'TimeoutStartSec'), '15min')
    assert.equal(value(text, 'Restart'), undefined)
  }
  const keeper = units['night-keeper.service']
  assert.equal(value(keeper, 'Type'), 'oneshot')
  assert.equal(value(keeper, 'ExecStart'), `${base.node} ${base.cli} keep`)
  assert.equal(value(keeper, 'TimeoutStartSec'), '5min')
  const timer = units['night-keeper.timer']
  assert.equal(value(timer, 'OnBootSec'), '1min')
  assert.equal(value(timer, 'OnUnitActiveSec'), '2min')
  assert.equal(value(timer, 'AccuracySec'), '10s')
  assert.equal(value(timer, 'WantedBy'), 'timers.target')
})

test('no ExecStart uses a home shortcut, and every program path is absolute', () => {
  const units = buildUnits({ ...base, nightHome: '/srv/night home' })
  for (const [name, text] of Object.entries(units)) {
    const starts = text.split('\n').filter((l) => l.startsWith('ExecStart='))
    for (const line of starts) {
      assert.ok(!line.includes('$HOME'), name)
      assert.ok(!line.includes('~'), name)
      assert.ok(!line.includes('%h'), name)
      assert.ok(isAbsolute(line.slice('ExecStart='.length).split(' ')[0]), name)
    }
    if (name.endsWith('.service')) assert.equal(starts.length, 1, name)
  }
  const worker = units['night-worker@.service']
  assert.ok(isAbsolute(value(worker, 'ExecStart').split(' ')[1]))
})

test('a relative or home-relative path is refused, and so is a newline', () => {
  assert.throws(() => buildUnits({ ...base, node: 'node' }), /absolute/)
  assert.throws(() => buildUnits({ ...base, cli: '~/night.mjs' }), /absolute/)
  assert.throws(() => buildUnits({ ...base, pathEnv: '/bin\n[Service]' }), /line break/)
  assert.throws(() => buildUnits({ ...base, sessions: 0 }), /sessions/)
})

test('a path with a space is quoted for systemd, and a percent or dollar is doubled', () => {
  const units = buildUnits({ ...base, cli: '/opt/my plugins/50%/$x/night.mjs' })
  assert.equal(
    value(units['night-conductor.service'], 'ExecStart'),
    '/usr/bin/node "/opt/my plugins/50%%/$$x/night.mjs" run conductor',
  )
  const spaced = buildUnits({ ...base, pathEnv: '/a b:/bin' })
  assert.equal(value(spaced['night-conductor.service'], 'Environment'), '"PATH=/a b:/bin"')
})

test('NIGHT_HOME is set on every service only when given', () => {
  const without = buildUnits(base)
  for (const text of Object.values(without)) assert.ok(!text.includes('NIGHT_HOME'))
  const withHome = buildUnits({ ...base, nightHome: '/tmp/night-test' })
  for (const [name, text] of Object.entries(withHome)) {
    if (!name.endsWith('.service')) {
      assert.ok(!text.includes('NIGHT_HOME'), name)
      continue
    }
    const envs = text.split('\n').filter((l) => l.startsWith('Environment='))
    assert.ok(envs.includes('Environment=NIGHT_HOME=/tmp/night-test'), name)
  }
})

test('the timers carry the exact instant, persist, and install into timers.target', () => {
  const timers = buildTimers({ dusk: '2026-10-29 22:30:00 UTC', dawn: '2026-10-30 05:00:00 UTC' })
  assert.deepEqual(Object.keys(timers).sort(), [...TIMER_NAMES].sort())
  const cases = [['night-dusk.timer', '2026-10-29 22:30:00 UTC'], ['night-dawn.timer', '2026-10-30 05:00:00 UTC']]
  for (const [name, when] of cases) {
    const text = timers[name]
    assert.match(text.split('\n')[0], /^# night: .+Written by `night install`/)
    assert.equal(value(text, 'OnCalendar'), when)
    assert.equal(value(text, 'Persistent'), 'true')
    assert.equal(value(text, 'AccuracySec'), '1s')
    assert.equal(value(text, 'RemainAfterElapse'), 'false')
    assert.equal(value(text, 'WantedBy'), 'timers.target')
  }
  assert.throws(() => buildTimers({ dusk: '', dawn: 'x' }), /dusk/)
  assert.throws(() => buildTimers({ dusk: 'x\ny', dawn: 'x' }), /line break/)
})

test('writing twice changes nothing the second time and leaves no temporary file', (t) => {
  const dir = join(tempDir(t), 'systemd', 'user')
  const files = { ...buildUnits(base), ...buildTimers({ dusk: '2026-10-29 22:30:00 UTC', dawn: '2026-10-30 05:00:00 UTC' }) }
  const first = writeUnits(dir, files)
  assert.deepEqual([...first].sort(), Object.keys(files).sort())
  assert.deepEqual(writeUnits(dir, files), [])
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort())
  assert.equal(readFileSync(join(dir, 'night.target'), 'utf8'), files['night.target'])
  assert.equal(statSync(join(dir, 'night.target')).mode & 0o777, 0o644)
  const edited = { ...files, 'night-dusk.timer': files['night-dusk.timer'].replace('22:30', '23:00') }
  assert.deepEqual(writeUnits(dir, edited), ['night-dusk.timer'])
})

test('a name that climbs out of the folder is refused', (t) => {
  const dir = tempDir(t)
  assert.throws(() => writeUnits(dir, { '../evil.service': 'x' }), /unit name/)
  assert.throws(() => removeUnits(dir, ['../evil.service']), /unit name/)
})

test('removing deletes only night\'s own files and skips a missing one', (t) => {
  const dir = tempDir(t)
  const files = buildUnits(base)
  writeUnits(dir, files)
  writeFileSync(join(dir, 'night-health.service'), '[Unit]\nDescription=somebody else\'s\n')
  writeFileSync(join(dir, 'night-logs.service'), '# my own notes\n' + files['night-logs.service'])
  const removed = removeUnits(dir, [...UNIT_NAMES, ...TIMER_NAMES])
  assert.ok(removed.includes('night.target'))
  assert.ok(removed.includes('night-conductor.service'))
  assert.ok(!removed.includes('night-health.service'))
  assert.ok(!removed.includes('night-logs.service'))
  assert.ok(!removed.includes('night-dusk.timer'))
  assert.deepEqual(readdirSync(dir).sort(), ['night-health.service', 'night-logs.service'])
  assert.equal(readFileSync(join(dir, 'night-health.service'), 'utf8'), '[Unit]\nDescription=somebody else\'s\n')
  assert.deepEqual(removeUnits(dir, ['night.target']), [])
})

test('removal goes through the injected fs', () => {
  const marked = buildUnits(base)['night.target']
  const store = new Map([['/u/night.target', marked], ['/u/night-health.service', 'no marker\n']])
  const deleted = []
  const fs = {
    readFileSync: (path) => {
      if (!store.has(path)) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return store.get(path)
    },
    unlinkSync: (path) => { deleted.push(path) },
  }
  assert.deepEqual(removeUnits('/u', ['night.target', 'night-health.service', 'night-logs.service'], { fs }), ['night.target'])
  assert.deepEqual(deleted, ['/u/night.target'])
})

test('writing creates the unit folder when it is missing', (t) => {
  const dir = join(tempDir(t), 'a', 'b')
  assert.deepEqual(writeUnits(dir, { 'night.target': buildUnits(base)['night.target'] }), ['night.target'])
  mkdirSync(dir, { recursive: true })
  assert.deepEqual(readdirSync(dir), ['night.target'])
})

test('workers run in one slice with a shared ceiling, and neither the slice nor a worker may swap', () => {
  const units = buildUnits({ node: '/usr/bin/node', cli: '/p/bin/night.mjs', sessions: 2, memoryHigh: '5G', memoryMax: '6G' })
  assert.match(units['night.slice'], /^MemoryMax=18G$/m)
  assert.match(units['night.slice'], /^MemorySwapMax=0$/m)
  assert.match(units['night-worker@.service'], /^Slice=night\.slice$/m)
  assert.match(units['night-worker@.service'], /^MemorySwapMax=0$/m)
})

test('a test install can move the night\'s state and share folders', () => {
  const units = buildUnits({ node: '/usr/bin/node', cli: '/p/bin/night.mjs', sessions: 1, memoryHigh: '5G', memoryMax: '6G', nightHome: '/t/n', nightShare: '/t/s' })
  assert.match(units['night-medic.service'], /^Environment=NIGHT_SHARE=\/t\/s$/m)
  assert.match(units['night-worker@.service'], /^Environment=NIGHT_HOME=\/t\/n$/m)
})
