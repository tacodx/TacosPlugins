import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { classify, createDeduper, followArgs } from '../engine/logs.mjs'
import { at } from './helpers.mjs'

const journal = readFileSync(new URL('./fixtures/journal.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))
const T0 = 1773176400000 // __REALTIME_TIMESTAMP of the first fixture line, in ms
const entry = (change) => ({ MESSAGE: 'x', PRIORITY: '6', __REALTIME_TIMESTAMP: String(T0 * 1000), ...change })

test('the journal fixture is classified line by line', () => {
  assert.deepEqual(journal.map((e) => classify(e)?.kind ?? null), [
    'unit-failed', // Failed with result
    'unit-failed', // Main process exited
    'unit-failed', // Scheduled restart job
    'oom', // Killed process, which also says out of memory
    'oom', // killed by the OOM killer
    'segfault',
    'coredump', // dumped core
    'coredump', // identifier alone
    null, // the i2c noise
    'error', // priority 3 and nothing more specific
    null, // Started night-health.service
    'unit-failed', // the same kind of line, sent as bytes
  ])
})

test('an event carries the unit, the message and the time in milliseconds', () => {
  assert.deepEqual(classify(journal[0]), {
    kind: 'unit-failed',
    unit: 'night-worker@1.service',
    text: "night-worker@1.service: Failed with result 'exit-code'.",
    at: T0,
  })
  assert.equal(classify(journal[1]).at, T0 + 1000)
})

test('a message sent as bytes is decoded', () => {
  assert.deepEqual(classify(journal[11]), {
    kind: 'unit-failed',
    unit: 'night-health.service',
    text: "night-health.service: Failed with result 'timeout'.",
    at: T0 + 11_000,
  })
  assert.equal(classify(entry({ MESSAGE: [...Buffer.from('Out of memory: café')] })).text, 'Out of memory: café')
})

test('the unit is the one the message is about, whoever said it', () => {
  assert.equal(classify(entry({ MESSAGE: 'Failed with result', USER_UNIT: 'a.service', _SYSTEMD_UNIT: 'user@1000.service' })).unit, 'a.service')
  assert.equal(classify(entry({ MESSAGE: 'Failed with result', _SYSTEMD_USER_UNIT: 'b.service', _SYSTEMD_UNIT: 'user@1000.service' })).unit, 'b.service')
  assert.equal(classify(entry({ MESSAGE: 'Failed with result', UNIT: 'c.service', _SYSTEMD_UNIT: 'init.scope' })).unit, 'c.service')
  assert.equal(classify(entry({ MESSAGE: 'Failed with result', _SYSTEMD_UNIT: 'd.service' })).unit, 'd.service')
  assert.equal(classify(entry({ MESSAGE: 'Failed with result' })).unit, null)
})

test('each kind has its messages', () => {
  const kind = (MESSAGE, extra) => classify(entry({ MESSAGE, ...extra }))?.kind ?? null
  for (const m of ['x.service: Failed with result \'exit-code\'.', 'Main process exited, code=killed, status=9/KILL', 'Scheduled restart job, restart counter is at 12.']) {
    assert.equal(kind(m), 'unit-failed', m)
  }
  for (const m of ['Out of memory: Killed process 1 (a)', 'oom-kill:constraint=CONSTRAINT_MEMCG', 'node invoked oom-killer: gfp_mask=0x1', 'x.service: Failed with result \'oom-kill\'.', 'Memory cgroup stats for /user.slice: memory.max 6442450944']) {
    assert.equal(kind(m), 'oom', m)
  }
  assert.equal(kind('a[2]: segfault at 8 ip 0 sp 0 error 4'), 'segfault')
  assert.equal(kind('Process 5 (a) of user 1000 dumped core.'), 'coredump')
  assert.equal(kind('anything at all', { SYSLOG_IDENTIFIER: 'systemd-coredump' }), 'coredump')
})

test('an oom kill wins over the unit failure it causes', () => {
  assert.equal(classify(entry({ MESSAGE: "x.service: Failed with result 'oom-kill'.", PRIORITY: '3' })).kind, 'oom')
})

test('priority 3 or lower with nothing more specific is an error; the rest is noise', () => {
  for (const p of ['0', '1', '2', '3', 3]) assert.equal(classify(entry({ MESSAGE: 'something broke', PRIORITY: p })).kind, 'error', String(p))
  for (const p of ['4', '5', '6', '7', '', null, undefined]) assert.equal(classify(entry({ MESSAGE: 'something happened', PRIORITY: p })), null, String(p))
})

test('the i2c complaint of the RGB tool is noise even at error priority', () => {
  assert.equal(classify(entry({ MESSAGE: '[i2c_smbus_linux] Failed to read i2c device PCI device ID', PRIORITY: '3' })), null)
})

test('an entry with no message, or no entry, is noise', () => {
  assert.equal(classify(entry({ MESSAGE: undefined, PRIORITY: '3' })), null)
  assert.equal(classify(entry({ MESSAGE: '', PRIORITY: '3' })), null)
  assert.equal(classify(entry({ MESSAGE: null, PRIORITY: '3' })), null)
  assert.equal(classify(null), null)
  assert.equal(classify(undefined), null)
})

test('a missing timestamp gives a null time, and a very long message is cut', () => {
  const e = classify({ MESSAGE: 'Failed with result', USER_UNIT: 'a.service' })
  assert.equal(e.at, null)
  assert.equal(classify({ MESSAGE: 'Failed with result', __REALTIME_TIMESTAMP: '' }).at, null)
  const long = classify(entry({ MESSAGE: `Out of memory ${'x'.repeat(5000)}` }))
  assert.ok(long.text.length <= 400)
  assert.ok(long.text.startsWith('Out of memory xxx'))
})

const ev = (change) => ({ kind: 'unit-failed', unit: 'night-worker@1.service', text: 'Scheduled restart job, restart counter is at 3.', ...change })

test('the same event is recorded once per window', () => {
  const dedupe = createDeduper()
  assert.equal(dedupe(ev(), at()), true)
  assert.equal(dedupe(ev(), at() + 1000), false)
  assert.equal(dedupe(ev(), at() + 599_999), false)
  assert.equal(dedupe(ev(), at() + 600_000), true)
})

test('counts that differ only in digits are the same event', () => {
  const dedupe = createDeduper()
  assert.equal(dedupe(ev({ text: 'restart counter is at 3' }), at()), true)
  assert.equal(dedupe(ev({ text: 'restart counter is at 12' }), at() + 10), false)
  assert.equal(dedupe(ev({ text: 'restart counter is at four' }), at() + 20), true)
})

test('a different kind, unit or text is a different event', () => {
  const dedupe = createDeduper()
  assert.equal(dedupe(ev(), at()), true)
  assert.equal(dedupe(ev({ kind: 'error' }), at() + 1), true)
  assert.equal(dedupe(ev({ unit: 'night-worker@2.service' }), at() + 2), true)
  assert.equal(dedupe(ev({ text: 'Failed with result' }), at() + 3), true)
  assert.equal(dedupe(ev({ unit: null }), at() + 4), true)
})

test('the repeats that were held back ride on the next recorded one', () => {
  const dedupe = createDeduper(60_000)
  const first = ev()
  assert.equal(dedupe(first, at()), true)
  assert.equal('repeats' in first, false, 'a first event has no repeats')
  for (let i = 1; i <= 4; i++) assert.equal(dedupe(ev(), at() + i * 1000), false)
  const next = ev()
  assert.equal(dedupe(next, at() + 60_000), true)
  assert.equal(next.repeats, 4)
  const after = ev()
  assert.equal(dedupe(after, at() + 120_000), true)
  assert.equal('repeats' in after, false, 'the count starts again after it was reported')
})

test('the window is as long as it was made', () => {
  const dedupe = createDeduper(1000)
  assert.equal(dedupe(ev(), at()), true)
  assert.equal(dedupe(ev(), at() + 999), false)
  assert.equal(dedupe(ev(), at() + 1000), true)
})

test('journalctl follows the night units in the user journal and errors in the system one', () => {
  assert.deepEqual(followArgs({ system: false }), ['journalctl', '--user', '-f', '-o', 'json', '-n', '0', '-u', 'night-*'])
  assert.deepEqual(followArgs({ system: true }), ['journalctl', '-f', '-o', 'json', '-n', '0', '-p', 'err'])
  assert.deepEqual(followArgs({}), followArgs({ system: false }))
})
