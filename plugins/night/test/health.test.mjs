import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DEFAULTS } from '../engine/config.mjs'
import {
  pausePlan, parseMeminfo, parsePsi, parseSensors, runCommand, sampleHealth, verdict,
} from '../engine/health.mjs'
import { at } from './helpers.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const T = DEFAULTS.health
const GB = 1e9

// A sample with nothing wrong in it.
const calm = {
  at: at(),
  memTotal: 16 * GB,
  memAvailable: 9 * GB,
  swapTotal: 8 * GB,
  swapFree: 6 * GB,
  psiFullAvg10: 0.1,
  psiFullAvg60: 0.2,
  diskFreeBytes: 50 * GB,
  tmpUsedPct: 10,
  cpuC: 45,
  gpuJunctionC: 58,
}
const none = (change) => verdict({ ...calm, ...change }, T)
const codes = (list) => list.map((item) => item.code)

test('meminfo reads in bytes, from kilobytes', () => {
  assert.deepEqual(parseMeminfo(fixture('meminfo.txt')), {
    memTotal: 16384000 * 1024,
    memAvailable: 9216000 * 1024,
    swapTotal: 8388604 * 1024,
    swapFree: 2097148 * 1024,
  })
})

test('a meminfo with a line missing, or no text at all, gives null for what is missing', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 100 kB\nSwapTotal: 0 kB\n'), {
    memTotal: 100 * 1024, memAvailable: null, swapTotal: 0, swapFree: null,
  })
  assert.deepEqual(parseMeminfo(''), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null })
  assert.deepEqual(parseMeminfo(undefined), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null })
})

test('memory pressure reads some and full with their averages and total', () => {
  assert.deepEqual(parsePsi(fixture('pressure-memory.txt')), {
    some: { avg10: 1.5, avg60: 0.8, avg300: 0.4, total: 4200100 },
    full: { avg10: 0.9, avg60: 0.45, avg300: 0.2, total: 3100050 },
  })
})

test('a kernel without pressure files, or with a cut one, gives null for the line it lacks', () => {
  assert.deepEqual(parsePsi(''), { some: null, full: null })
  assert.deepEqual(parsePsi('some avg10=1.00 avg60=2.00 avg300=3.00 total=4\n').full, null)
  assert.equal(parsePsi('full avg10=1.00 avg60=2.00\n').full, null)
})

test('sensors give the CPU control temperature and the GPU junction and edge', () => {
  assert.deepEqual(parseSensors(fixture('sensors.json')), { cpuC: 52.5, gpuJunctionC: 61, gpuEdgeC: 55 })
  assert.deepEqual(parseSensors(JSON.parse(fixture('sensors.json'))), { cpuC: 52.5, gpuJunctionC: 61, gpuEdgeC: 55 })
})

test('an Intel machine reads its CPU from the package and has no GPU readings', () => {
  assert.deepEqual(parseSensors(fixture('sensors-intel.json')), { cpuC: 47, gpuJunctionC: null, gpuEdgeC: null })
})

test('sensors that are missing, empty or not JSON give null, never a throw', () => {
  const nothing = { cpuC: null, gpuJunctionC: null, gpuEdgeC: null }
  assert.deepEqual(parseSensors('{}'), nothing)
  assert.deepEqual(parseSensors(''), nothing)
  assert.deepEqual(parseSensors('No sensors found!'), nothing)
  assert.deepEqual(parseSensors(null), nothing)
  assert.deepEqual(parseSensors({ 'k10temp-pci-00c3': { Adapter: 'PCI adapter', Tctl: {} } }), nothing)
})

test('a sample puts together every reading, with the disk and /tmp from statfs', () => {
  const files = {
    '/proc/meminfo': fixture('meminfo.txt'),
    '/proc/pressure/memory': fixture('pressure-memory.txt'),
  }
  const asked = []
  const sample = sampleHealth({
    readFile: (path, enc) => {
      assert.equal(enc, 'utf8')
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    },
    statfs: (path) => {
      asked.push(path)
      return path === '/tmp'
        ? { bsize: 4096, blocks: 1000, bfree: 250, bavail: 250 }
        : { bsize: 4096, blocks: 5_000_000, bfree: 1_000_000, bavail: 900_000 }
    },
    run: (argv) => {
      assert.deepEqual(argv, ['sensors', '-j'])
      return fixture('sensors.json')
    },
    home: '/home/someone',
    now: at(),
  })
  assert.deepEqual(asked, ['/home/someone', '/tmp'])
  assert.deepEqual(sample, {
    at: at(),
    memTotal: 16384000 * 1024,
    memAvailable: 9216000 * 1024,
    swapTotal: 8388604 * 1024,
    swapFree: 2097148 * 1024,
    psiFullAvg10: 0.9,
    psiFullAvg60: 0.45,
    diskFreeBytes: 900_000 * 4096,
    tmpUsedPct: 75,
    cpuC: 52.5,
    gpuJunctionC: 61,
  })
})

test('every reader failing gives null fields and the time, never a throw', () => {
  const boom = () => { throw new Error('nope') }
  const sample = sampleHealth({ readFile: boom, statfs: boom, run: boom, home: '/h', now: at() })
  assert.deepEqual(sample, {
    at: at(),
    memTotal: null,
    memAvailable: null,
    swapTotal: null,
    swapFree: null,
    psiFullAvg10: null,
    psiFullAvg60: null,
    diskFreeBytes: null,
    tmpUsedPct: null,
    cpuC: null,
    gpuJunctionC: null,
  })
})

test('one reader failing leaves the other readings alone', () => {
  const sample = sampleHealth({
    readFile: (path) => {
      if (path === '/proc/meminfo') return fixture('meminfo.txt')
      throw new Error('no pressure files here')
    },
    statfs: () => ({ bsize: 1000, blocks: 100, bfree: 40, bavail: 30 }),
    run: () => { throw new Error('sensors is not installed') },
    home: '/h',
    now: at(),
  })
  assert.equal(sample.swapTotal, 8388604 * 1024)
  assert.equal(sample.psiFullAvg60, null)
  assert.equal(sample.diskFreeBytes, 30_000)
  assert.equal(sample.tmpUsedPct, 60)
  assert.equal(sample.cpuC, null)
})

test('a filesystem with no blocks gives no /tmp percentage rather than NaN', () => {
  const sample = sampleHealth({
    readFile: () => { throw new Error('x') },
    statfs: () => ({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }),
    run: () => { throw new Error('x') },
    home: '/h',
    now: at(),
  })
  assert.equal(sample.tmpUsedPct, null)
})

test('the default runner returns what a command printed and throws when it fails', () => {
  assert.equal(runCommand([process.execPath, '-e', 'process.stdout.write("hi")']), 'hi')
  assert.throws(() => runCommand([process.execPath, '-e', 'process.exit(3)']))
  assert.throws(() => runCommand(['night-no-such-command-anywhere']))
  assert.throws(() => runCommand([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 }))
})

test('a calm sample has nothing to say', () => {
  assert.deepEqual(none({}), { blockers: [], warnings: [], thrash: false, blockTests: false, hot: false, tight: false })
})

test('swap over 95 % used with little RAM left is a blocker, and says how full', () => {
  const v = none({ swapTotal: 8 * GB, swapFree: 0.24 * GB, memAvailable: 3 * GB })
  assert.deepEqual(v.blockers, [{ code: 'swap-full', text: 'Swap is 97 % full and only 3.0 GB of RAM is free.' }])
  assert.deepEqual(v.warnings, [])
  assert.equal(none({ swapTotal: 100, swapFree: 5, memAvailable: GB }).blockers.length, 0, 'exactly 95 % is not over')
  assert.equal(none({ swapTotal: 100, swapFree: 4, memAvailable: GB }).blockers.length, 1)
  assert.equal(none({ swapTotal: 100, swapFree: 4, memAvailable: null }).blockers.length, 1, 'unknown free RAM blocks')
})

test('full swap with plenty of RAM free lets the night go on with one worker', () => {
  const v = none({ swapTotal: 8 * GB, swapFree: 0, memAvailable: 9 * GB })
  assert.deepEqual(v.blockers, [])
  assert.equal(v.tight, true)
  assert.deepEqual(v.warnings, [{ code: 'swap-full', text: 'Swap is 100 % full, with 9.0 GB of RAM free: one worker at a time.' }])
})

test('a machine with no swap at all is not out of swap', () => {
  assert.deepEqual(none({ swapTotal: 0, swapFree: 0 }).blockers, [])
  assert.deepEqual(none({ swapTotal: null, swapFree: null }).blockers, [])
})

test('memory pressure full avg60 over 5 is thrash, with a warning and no blocker', () => {
  const v = none({ psiFullAvg60: 7.3 })
  assert.equal(v.thrash, true)
  assert.deepEqual(codes(v.warnings), ['thrash'])
  assert.match(v.warnings[0].text, /7\.3 %/)
  assert.deepEqual(v.blockers, [])
  assert.equal(none({ psiFullAvg60: 5 }).thrash, false, 'exactly 5 is not over')
})

test('under 8 GB free warns, under 3 GB blocks, and a disk gets one verdict not both', () => {
  assert.deepEqual(none({ diskFreeBytes: 8 * GB }), none({}), 'exactly 8 GB is not under')
  const low = none({ diskFreeBytes: 6.5 * GB })
  assert.deepEqual(codes(low.warnings), ['disk-low'])
  assert.deepEqual(low.blockers, [])
  assert.match(low.warnings[0].text, /6\.5 GB/)
  const full = none({ diskFreeBytes: 2.1 * GB })
  assert.deepEqual(codes(full.blockers), ['disk-full'])
  assert.deepEqual(full.warnings, [])
  assert.match(full.blockers[0].text, /2\.1 GB/)
  assert.deepEqual(none({ diskFreeBytes: 3 * GB }).blockers, [], 'exactly 3 GB is not under')
})

test('/tmp over 75 % blocks heavy tests and warns, but blocks no item', () => {
  const v = none({ tmpUsedPct: 80 })
  assert.equal(v.blockTests, true)
  assert.deepEqual(codes(v.warnings), ['tmp-full'])
  assert.match(v.warnings[0].text, /80 %/)
  assert.deepEqual(v.blockers, [])
  assert.equal(none({ tmpUsedPct: 75 }).blockTests, false, 'exactly 75 % is not over')
})

test('a CPU over 85 or a GPU junction over 100 is hot', () => {
  const cpu = none({ cpuC: 88 })
  assert.equal(cpu.hot, true)
  assert.deepEqual(codes(cpu.warnings), ['hot'])
  assert.match(cpu.warnings[0].text, /CPU.*88/)
  const gpu = none({ gpuJunctionC: 101 })
  assert.equal(gpu.hot, true)
  assert.match(gpu.warnings[0].text, /GPU.*101/)
  const both = none({ cpuC: 90, gpuJunctionC: 105 })
  assert.deepEqual(codes(both.warnings), ['hot'], 'one warning, not two')
  assert.match(both.warnings[0].text, /CPU.*90.*GPU.*105/)
  assert.equal(none({ cpuC: 85, gpuJunctionC: 100 }).hot, false, 'exactly on the line is not over')
})

test('a sample of nothing but nulls is calm: no reading, no complaint', () => {
  const blank = Object.fromEntries(Object.keys(calm).map((key) => [key, null]))
  assert.deepEqual(verdict(blank, T), { blockers: [], warnings: [], thrash: false, blockTests: false, hot: false, tight: false })
})

test('everything wrong at once lists every blocker and warning', () => {
  const v = none({
    swapFree: 0, memAvailable: 1 * GB, psiFullAvg60: 9, diskFreeBytes: 1 * GB, tmpUsedPct: 99, cpuC: 99, gpuJunctionC: 120,
  })
  assert.deepEqual(codes(v.blockers), ['swap-full', 'disk-full'])
  assert.deepEqual(codes(v.warnings), ['thrash', 'tmp-full', 'hot'])
  assert.deepEqual([v.thrash, v.blockTests, v.hot], [true, true, true])
})

test('the thresholds come from the config and can be changed', () => {
  const strict = { ...T, swapBlockPct: 20, memAvailBlockGb: 12, diskWarnGb: 80, cpuHotC: 40 }
  const v = verdict(calm, strict)
  assert.deepEqual(codes(v.blockers), ['swap-full'])
  assert.deepEqual(codes(v.warnings), ['disk-low', 'hot'])
  assert.deepEqual(verdict(calm), verdict(calm, T), 'the defaults apply when none are given')
})

// ---- pausePlan ----

const bad = { blockers: [{ code: 'swap-full', text: 'Swap is 97 % full.' }], warnings: [], thrash: false, blockTests: false, hot: false }
const thrashing = { blockers: [], warnings: [{ code: 'thrash', text: 'x' }], thrash: true, blockTests: false, hot: false }
const fine = { blockers: [], warnings: [], thrash: false, blockTests: false, hot: false }
const MIN2 = 120_000
const ago = (ms) => at() - ms
const plan = (change) => pausePlan({
  verdict: bad, workers: [], paused: [], lastActionAt: null, clearSince: null, now: at(), ...change,
})

test('under a blocker the most recently started worker is paused first', () => {
  const workers = [{ slot: 1, bytes: ago(5000) }, { slot: 2, bytes: ago(1000) }, { slot: 3, bytes: ago(3000) }]
  assert.deepEqual(plan({ workers }), { action: 'pause', slot: 2 })
})

test('thrash pauses too, even with no blocker', () => {
  assert.deepEqual(plan({ verdict: thrashing, workers: [{ slot: 4, bytes: ago(10) }] }), { action: 'pause', slot: 4 })
})

test('a warning alone, such as disk-low or hot, pauses nothing', () => {
  const warned = { ...fine, warnings: [{ code: 'hot', text: 'x' }], hot: true }
  assert.equal(plan({ verdict: warned, workers: [{ slot: 1, bytes: ago(10) }] }).action, 'none')
})

test('only one pause every two minutes', () => {
  const workers = [{ slot: 1, bytes: ago(9000) }, { slot: 2, bytes: ago(8000) }]
  assert.deepEqual(plan({ workers, lastActionAt: ago(MIN2 - 1) }), { action: 'none', slot: null })
  assert.deepEqual(plan({ workers, lastActionAt: ago(MIN2) }), { action: 'pause', slot: 2 })
})

test('while it lasts it pauses down to the last worker, then there is nothing left to pause', () => {
  const one = [{ slot: 1, bytes: ago(9000) }]
  assert.deepEqual(plan({ workers: one, lastActionAt: ago(MIN2 * 3) }), { action: 'pause', slot: 1 })
  assert.deepEqual(plan({ workers: [], paused: [{ slot: 1, pausedAt: ago(5) }], lastActionAt: ago(MIN2 * 3) }), { action: 'none', slot: null })
})

test('a paused worker is not resumed while the verdict is bad', () => {
  const paused = [{ slot: 2, pausedAt: ago(MIN2 * 5) }]
  assert.equal(plan({ workers: [], paused, lastActionAt: ago(MIN2 * 5), clearSince: ago(MIN2 * 5) }).action, 'none')
})

test('after two clear minutes the most recently paused worker resumes first', () => {
  const paused = [{ slot: 1, pausedAt: ago(MIN2 * 4) }, { slot: 3, pausedAt: ago(MIN2 * 2) }, { slot: 2, pausedAt: ago(MIN2 * 3) }]
  const clear = { verdict: fine, paused, lastActionAt: ago(MIN2 * 2), clearSince: ago(MIN2) }
  assert.deepEqual(plan(clear), { action: 'resume', slot: 3 })
})

test('a verdict clear for less than two minutes, or of unknown age, resumes nothing', () => {
  const clear = { verdict: fine, paused: [{ slot: 1, pausedAt: ago(MIN2 * 9) }], lastActionAt: ago(MIN2 * 9) }
  assert.equal(plan({ ...clear, clearSince: ago(MIN2 - 1) }).action, 'none')
  assert.equal(plan({ ...clear, clearSince: null }).action, 'none')
})

test('resuming is one worker every two minutes too', () => {
  const clear = { verdict: fine, paused: [{ slot: 1, pausedAt: ago(MIN2 * 9) }], clearSince: ago(MIN2 * 4) }
  assert.deepEqual(plan({ ...clear, lastActionAt: ago(MIN2 - 1) }), { action: 'none', slot: null })
  assert.deepEqual(plan({ ...clear, lastActionAt: ago(MIN2) }), { action: 'resume', slot: 1 })
})

test('with nothing running, nothing paused and a calm verdict there is nothing to do', () => {
  assert.deepEqual(plan({ verdict: fine, clearSince: ago(MIN2 * 9) }), { action: 'none', slot: null })
})
