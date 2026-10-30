import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { DEFAULTS } from '../engine/config.mjs'
import * as fans from '../engine/hardware/fans.mjs'
import * as power from '../engine/hardware/power.mjs'
import * as rgb from '../engine/hardware/rgb.mjs'
import { expandHome, lastLine, runCommand } from '../engine/hardware/run.mjs'
import * as screens from '../engine/hardware/screens.mjs'
import { tempDir } from './helpers.mjs'

const { assertSafeRequest, pumpCheck, pumpDeviceUid, pumpRpm, setMode } = fans
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

// Everything here is made up, in the shape CoolerControl 5.1.1 answers with.
const MODES = fixture('cc-modes.json')
const PROFILES = fixture('cc-profiles.json')
const SENSORS = fixture('cc-sensors.json')
const DEVICES = fixture('cc-devices.json')
const TOKEN = 'cc_00000000-0000-4000-8000-00000000c0de'
const DAY = 'd0d0d0d0-0000-4000-8000-000000000001'
const NIGHT = 'e0e0e0e0-0000-4000-8000-000000000002'
const BOARD = MODES.modes[0].device_settings[0][0]
const GPU = MODES.modes[2].device_settings[0][0]
const CURVE = 'a0a0a0a0-0000-4000-8000-0000000000b1'
const FIXED_60 = 'c0c0c0c0-0000-4000-8000-0000000000c1'
const FIXED_40 = 'c0c0c0c0-0000-4000-8000-0000000000c2'
const MIX = 'c0c0c0c0-0000-4000-8000-0000000000c3'
const PUMP = { channel: 'fan1', minDuty: 50, profiles: PROFILES.profiles }

// Every request any fake CoolerControl in this file received, for the last test.
const everyRequest = []

/**
 * A fake CoolerControl on 127.0.0.1: GET /modes, GET /modes/<uid>, GET /profiles,
 * GET /devices and POST /modes-active/<uid>, behind the bearer token. Anything else is answered 405
 * and recorded, so a test can see that it was never sent.
 */
async function fakeCoolerControl(t, { modes = MODES, profiles = PROFILES, devices = DEVICES, detail = (mode) => mode } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const seen = { method: req.method, path: req.url, body, auth: req.headers.authorization }
      requests.push(seen)
      everyRequest.push(seen)
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(data === undefined ? '' : JSON.stringify(data))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'Invalid Credentials' })
      if (req.method === 'GET' && req.url === '/modes') return send(200, modes)
      if (req.method === 'GET' && req.url === '/profiles') return send(200, profiles)
      if (req.method === 'GET' && req.url === '/devices') return send(200, devices)
      const one = /^\/modes\/([^/]+)$/.exec(req.url)
      if (req.method === 'GET' && one) {
        const mode = (modes.modes ?? []).find((m) => m.uid === one[1])
        return mode ? send(200, detail(mode)) : send(404, { error: 'Mode not found' })
      }
      if (req.method === 'POST' && /^\/modes-active\/[^/]+$/.test(req.url)) return send(200)
      return send(405, { error: 'not served by the fake' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  return { url: `http://127.0.0.1:${server.address().port}`, requests }
}

const lines = (requests) => requests.map((r) => `${r.method} ${r.path}`)
const posts = (requests) => requests.filter((r) => r.method !== 'GET')

/** The context fans.mjs runs with: a token file under a temp home, a fake `sensors`, no waiting. */
function fansContext(t, cc, { sensors = SENSORS, token = TOKEN, tokenFile = '~/cc-token', sensorsCode = 0, pumpDevice = null } = {}) {
  const home = tempDir(t)
  if (token !== null) writeFileSync(join(home, 'cc-token'), `${token}\n`, { mode: 0o600 })
  const runs = []
  const sleeps = []
  const ctx = {
    config: { hardware: { fans: { ...DEFAULTS.hardware.fans, url: cc.url, tokenFile, pumpDevice } } },
    home,
    run: async (argv, options) => {
      runs.push({ argv, options })
      return { code: sensorsCode, stdout: typeof sensors === 'string' ? sensors : JSON.stringify(sensors), stderr: '' }
    },
    sleep: async (ms) => { sleeps.push(ms) },
  }
  return { ctx, runs, sleeps }
}

/** The modes with the pump setting of `name` replaced, or removed when `pump` is null. */
function modesWithPump(pump, name = 'Night') {
  const modes = structuredClone(MODES)
  const settings = modes.modes.find((m) => m.name === name).device_settings[0][1]
  const at = settings.findIndex((s) => s.channel_name === 'fan1')
  if (pump === null) settings.splice(at, 1)
  else settings[at] = { channel_name: 'fan1', ...pump }
  return modes
}

const modeOf = (modes, name) => modes.modes.find((m) => m.name === name)
const lowPump = (rpm) => {
  const sensors = structuredClone(SENSORS)
  sensors['nct6687-isa-0a20']['CPU Fan'].fan1_input = rpm
  return sensors
}

// pumpCheck

test('a mode with the pump at a fixed 50 % or more passes', () => {
  assert.equal(pumpCheck(modeOf(MODES, 'Night'), PUMP).ok, true)
  assert.equal(pumpCheck(modeOf(MODES, 'Day'), PUMP).ok, true)
  assert.equal(pumpCheck(modeOf(modesWithPump({ speed_fixed: 100 }), 'Night'), PUMP).ok, true)
})

test('a pump duty under the floor refuses, with the duty and the floor in the reason', () => {
  for (const duty of [49, 41, 40, 0]) {
    const check = pumpCheck(modeOf(modesWithPump({ speed_fixed: duty }), 'Night'), PUMP)
    assert.equal(check.ok, false)
    assert.match(check.reason, new RegExp(`${duty} %, under the pump's floor of 50 %`))
  }
})

test('the floor never goes under 50, whatever minDuty says, and a higher minDuty is kept', () => {
  const at45 = modeOf(modesWithPump({ speed_fixed: 45 }), 'Night')
  assert.equal(pumpCheck(at45, { ...PUMP, minDuty: 30 }).ok, false)
  assert.equal(pumpCheck(at45, { ...PUMP, minDuty: undefined }).ok, false)
  assert.equal(pumpCheck(at45, { ...PUMP, minDuty: Number.NaN }).ok, false)
  const at55 = modeOf(modesWithPump({ speed_fixed: 55 }), 'Night')
  assert.equal(pumpCheck(at55, { ...PUMP, minDuty: 60 }).ok, false)
  assert.equal(pumpCheck(at55, PUMP).ok, true)
})

test('a duty that is not a number from 0 to 100 refuses', () => {
  for (const duty of ['50', 101, true, [50], { duty: 50 }]) {
    const check = pumpCheck(modeOf(modesWithPump({ speed_fixed: duty }), 'Night'), PUMP)
    assert.equal(check.ok, false, JSON.stringify(duty))
    assert.match(check.reason, /does not understand/)
  }
})

test('the pump through a Fixed profile passes at 60 and refuses at 40', () => {
  assert.equal(pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_60 }), 'Night'), PUMP).ok, true)
  const forty = pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_40 }), 'Night'), PUMP)
  assert.equal(forty.ok, false)
  assert.match(forty.reason, /fixed profile "pumpForty" at 40 %/)
})

test('the pump on a curve, a mix, an overlay or the unmanaged default refuses', () => {
  const overlay = { uid: 'c0c0c0c0-0000-4000-8000-0000000000c4', name: 'pumpOverlay', p_type: 'Overlay', speed_fixed: 60 }
  const profiles = [...PROFILES.profiles, overlay]
  for (const [uid, type] of [[CURVE, 'Graph'], [MIX, 'Mix'], [overlay.uid, 'Overlay'], ['0', 'Default']]) {
    const check = pumpCheck(modeOf(modesWithPump({ profile_uid: uid }), 'Night'), { ...PUMP, profiles })
    assert.equal(check.ok, false, type)
    assert.match(check.reason, new RegExp(`the ${type} profile .* not a fixed duty`))
  }
})

test('a profile that is not listed, listed twice, or has no duty refuses', () => {
  const missing = pumpCheck(modeOf(modesWithPump({ profile_uid: 'nope' }), 'Night'), PUMP)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /does not list/)
  const twice = [...PROFILES.profiles, { ...PROFILES.profiles.find((p) => p.uid === FIXED_60) }]
  assert.match(pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_60 }), 'Night'), { ...PUMP, profiles: twice }).reason, /lists twice/)
  const empty = [{ uid: FIXED_60, name: 'pumpSixty', p_type: 'Fixed', speed_fixed: null }]
  assert.equal(pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_60 }), 'Night'), { ...PUMP, profiles: empty }).ok, false)
  assert.equal(pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_60 }), 'Night'), { ...PUMP, profiles: undefined }).ok, false)
  assert.equal(pumpCheck(modeOf(modesWithPump({ profile_uid: FIXED_60 }), 'Night'), { ...PUMP, profiles: 'all' }).ok, false)
})

test('a pump setting with both a duty and a profile, neither, a reset, or anything more refuses', () => {
  const cases = [
    { speed_fixed: 60, profile_uid: FIXED_60 },
    {},
    { speed_fixed: null, profile_uid: null },
    { speed_fixed: 60, reset_to_default: true },
    { reset_to_default: true },
    { speed_fixed: 60, pwm_mode: 0 },
    { speed_fixed: 60, lighting: { mode: 'fixed', colors: [] } },
    { speed_fixed: 60, curve: [[0, 20]] },
  ]
  for (const pump of cases) {
    const check = pumpCheck(modeOf(modesWithPump(pump), 'Night'), PUMP)
    assert.equal(check.ok, false, JSON.stringify(pump))
    assert.ok(check.reason.length > 10)
  }
  assert.equal(pumpCheck(modeOf(modesWithPump({ speed_fixed: 60, reset_to_default: false }), 'Night'), PUMP).ok, true)
})

test('a mode that does not set the pump refuses: it must be explicit', () => {
  const check = pumpCheck(modeOf(modesWithPump(null), 'Night'), PUMP)
  assert.equal(check.ok, false)
  assert.match(check.reason, /does not set fan1, the pump/)
  assert.equal(pumpCheck({ uid: NIGHT, name: 'Night', device_settings: [] }, PUMP).ok, false)
})

test('every device with the pump channel counts: one unsafe setting anywhere refuses', () => {
  assert.equal(pumpCheck(modeOf(MODES, 'Loud'), PUMP).ok, true)
  const gpuUnmanaged = {
    uid: NIGHT,
    name: 'Night',
    device_settings: [[GPU, [{ channel_name: 'fan1', profile_uid: '0' }]], [BOARD, [{ channel_name: 'fan1', speed_fixed: 50 }]]],
  }
  assert.equal(pumpCheck(gpuUnmanaged, PUMP).ok, false)
  const gpuLow = structuredClone(gpuUnmanaged)
  gpuLow.device_settings[0][1][0] = { channel_name: 'fan1', speed_fixed: 30 }
  assert.equal(pumpCheck(gpuLow, PUMP).ok, false)
})

test('a mode in any shape it does not know refuses, never passes', () => {
  const pump = { channel_name: 'fan1', speed_fixed: 60 }
  const shapes = [
    null,
    undefined,
    'Night',
    [],
    {},
    { uid: NIGHT, name: 'Night' },
    { device_settings: {} },
    { device_settings: { [BOARD]: [pump] } },
    { all_device_settings: { [BOARD]: { fan1: { speed_fixed: 60 } } } },
    { device_settings: [[BOARD]] },
    { device_settings: [[BOARD, [pump], 'extra']] },
    { device_settings: [[BOARD, { fan1: pump }]] },
    { device_settings: [[42, [pump]]] },
    { device_settings: [{ device_uid: BOARD, settings: [pump] }] },
    { device_settings: [[BOARD, [null]]] },
    { device_settings: [[BOARD, [pump, 'fan2']]] },
    { device_settings: [[BOARD, [{ name: 'fan1', speed_fixed: 60 }]]] },
    { device_settings: [[BOARD, [pump]], [GPU, [{ channel: 'fan2', speed_fixed: 30 }]]] },
  ]
  for (const mode of shapes) {
    const check = pumpCheck(mode, PUMP)
    assert.equal(check.ok, false, JSON.stringify(mode))
    assert.equal(typeof check.reason, 'string')
  }
})

test('without a pump channel nothing can be checked, so it refuses', () => {
  assert.equal(pumpCheck(modeOf(MODES, 'Night'), { ...PUMP, channel: '' }).ok, false)
  assert.equal(pumpCheck(modeOf(MODES, 'Night'), { ...PUMP, channel: undefined }).ok, false)
  assert.equal(pumpCheck(modeOf(MODES, 'Night')).ok, false)
})

// The pump scoped to its device

// The owner's case: the GPU's own fan1 left on the unmanaged default, the board's fan1 the pump.
const gpuAndBoard = (boardDuty) => ({
  uid: NIGHT,
  name: 'Night',
  device_settings: [
    [GPU, [{ channel_name: 'fan1', speed_fixed: null, profile_uid: '0' }]],
    [BOARD, [{ channel_name: 'fan1', speed_fixed: boardDuty }, { channel_name: 'fan2', profile_uid: CURVE }]],
  ],
})

test('with the pump device given, only that device\'s pump channel counts', () => {
  assert.equal(pumpCheck(gpuAndBoard(50), { ...PUMP, device: BOARD }).ok, true)
  assert.equal(pumpCheck(gpuAndBoard(50), PUMP).ok, false)
  assert.equal(pumpCheck(gpuAndBoard(50), { ...PUMP, device: null }).ok, false)
  const low = pumpCheck(gpuAndBoard(40), { ...PUMP, device: BOARD })
  assert.equal(low.ok, false)
  assert.match(low.reason, /fixed at 40 %/)
})

test('a pump device whose mode does not set the pump, or that is not a uid, refuses', () => {
  const gpuOnly = { uid: NIGHT, name: 'Night', device_settings: [[GPU, [{ channel_name: 'fan1', speed_fixed: 80 }]]] }
  assert.match(pumpCheck(gpuOnly, { ...PUMP, device: BOARD }).reason, /does not set fan1 on the pump's device/)
  assert.equal(pumpCheck(gpuAndBoard(50), { ...PUMP, device: 42 }).ok, false)
  assert.equal(pumpCheck(gpuAndBoard(50), { ...PUMP, device: '' }).ok, false)
  const broken = gpuAndBoard(50)
  broken.device_settings.push([GPU, { fan1: { speed_fixed: 50 } }])
  assert.equal(pumpCheck(broken, { ...PUMP, device: BOARD }).ok, false)
})

test('the pump device is the one device whose name, type, model or driver holds the text', () => {
  assert.deepEqual(pumpDeviceUid(DEVICES, 'nct6687'), { uid: BOARD })
  assert.deepEqual(pumpDeviceUid(DEVICES, 'NCT6687'), { uid: BOARD })
  assert.deepEqual(pumpDeviceUid(DEVICES, 'radeon'), { uid: GPU })
  assert.match(pumpDeviceUid(DEVICES, 'nct6798').reason, /matches no CoolerControl device/)
  assert.match(pumpDeviceUid(DEVICES, 'm').reason, /matches 3 CoolerControl devices/)
  assert.match(pumpDeviceUid(DEVICES, '').reason, /not a device name/)
  assert.match(pumpDeviceUid(DEVICES, 6687).reason, /not a device name/)
  assert.match(pumpDeviceUid(DEVICES.devices, 'nct6687').reason, /shape night does not know/)
  assert.match(pumpDeviceUid({ devices: [{ name: 'nct6687' }] }, 'nct6687').reason, /has no uid/)
})

// pumpRpm

test('the pump RPM is the channel input on the nct6687 chip', () => {
  assert.equal(pumpRpm(SENSORS, 'fan1'), 1650)
  assert.equal(pumpRpm(JSON.stringify(SENSORS), 'fan1'), 1650)
  assert.equal(pumpRpm(SENSORS, 'fan2'), 900)
})

test('another chip with the same channel name does not count, and what is missing is null', () => {
  const noPump = structuredClone(SENSORS)
  delete noPump['nct6687-isa-0a20']['CPU Fan']
  assert.equal(pumpRpm(noPump, 'fan1'), null)
  const noBoard = structuredClone(SENSORS)
  delete noBoard['nct6687-isa-0a20']
  assert.equal(pumpRpm(noBoard, 'fan1'), null)
  assert.equal(pumpRpm('No sensors found!', 'fan1'), null)
  assert.equal(pumpRpm('', 'fan1'), null)
  assert.equal(pumpRpm(null, 'fan1'), null)
  assert.equal(pumpRpm(SENSORS, ''), null)
  assert.equal(pumpRpm({ 'nct6687-isa-0a20': { 'CPU Fan': { fan1_input: 'fast' } } }, 'fan1'), null)
})

// assertSafeRequest

test('the request filter lets reads through and one activation with an empty body', () => {
  for (const req of [
    { method: 'GET', path: '/modes' },
    { method: 'GET', path: `/modes/${NIGHT}` },
    { method: 'GET', path: '/profiles' },
    { method: 'POST', path: `/modes-active/${NIGHT}`, body: '{}' },
    { method: 'POST', path: `/modes-active/${NIGHT}` },
    { method: 'POST', path: `/modes-active/${NIGHT}`, body: {} },
  ]) assert.doesNotThrow(() => assertSafeRequest(req), JSON.stringify(req))
})

test('the request filter throws for every write that is not one activation', () => {
  for (const req of [
    { method: 'POST', path: '/profiles', body: '{}' },
    { method: 'post', path: '/profiles' },
    { method: 'PUT', path: '/profiles', body: JSON.stringify({ uid: FIXED_40, speed_fixed: 30 }) },
    { method: 'PUT', path: `/settings/devices/${BOARD}/fan1/manual`, body: '{"speed_fixed":30}' },
    { method: 'PUT', path: `/settings/devices/${BOARD}/fan2/profile` },
    { method: 'PUT', path: '/settings' },
    { method: 'POST', path: `/devices/${BOARD}/settings/fan2/manual` },
    { method: 'POST', path: '/modes', body: '{"name":"Night"}' },
    { method: 'PUT', path: '/modes', body: '{}' },
    { method: 'PUT', path: `/modes/${NIGHT}/settings` },
    { method: 'POST', path: `/modes/${NIGHT}/duplicate` },
    { method: 'POST', path: '/modes/order' },
    { method: 'DELETE', path: `/modes/${NIGHT}` },
    { method: 'DELETE', path: `/modes-active/${NIGHT}` },
    { method: 'DELETE', path: '/profiles/0' },
    { method: 'DELETE', path: '/' },
    { method: 'PATCH', path: `/modes-active/${NIGHT}` },
    { method: 'POST', path: `/modes-active/${NIGHT}`, body: '{"channel_name":"fan1","speed_fixed":30}' },
    { method: 'POST', path: `/modes-active/${NIGHT}`, body: { speed_fixed: 30 } },
    { method: 'POST', path: '/modes-active/../profiles' },
    { method: 'POST', path: `/modes-active/${NIGHT}/x` },
    { method: 'POST', path: `/modes-active/${NIGHT}?speed=30` },
    { method: 'POST', path: '/modes-active/' },
    { method: 'POST', path: '/modes-active' },
    { method: 'GET', path: `/devices/${BOARD}/settings/fan1` },
    { method: 'GET', path: '/modes', body: '{"x":1}' },
    { method: 'GET', path: 'modes' },
    { path: '/modes' },
    {},
  ]) assert.throws(() => assertSafeRequest(req), /refused/, JSON.stringify(req))
})

// setMode against the fake CoolerControl

test('Night with the pump at a fixed 50 % is read, checked and activated, then the pump is read', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx, runs, sleeps } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, true, result.detail)
  assert.equal(result.rpm, 1650)
  assert.match(result.detail, /Night is active and the pump runs at 1650 rpm/)
  assert.deepEqual(lines(cc.requests), ['GET /modes', `GET /modes/${NIGHT}`, 'GET /profiles', `POST /modes-active/${NIGHT}`])
  assert.ok(cc.requests.every((r) => r.auth === `Bearer ${TOKEN}`))
  assert.equal(posts(cc.requests)[0].body, '{}')
  assert.deepEqual(sleeps, [8000])
  assert.deepEqual(runs.map((r) => r.argv), [['sensors', '-j']])
})

test('Day activates the Day mode by name', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc)
  const result = await fans.day(ctx)
  assert.equal(result.ok, true, result.detail)
  assert.deepEqual(lines(posts(cc.requests)), [`POST /modes-active/${DAY}`])
})

test('the pump at a fixed 40 % is refused and nothing is posted', async (t) => {
  const cc = await fakeCoolerControl(t, { modes: modesWithPump({ speed_fixed: 40 }) })
  const { ctx, runs, sleeps } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.skipped, undefined)
  assert.match(result.detail, /^Night was not activated: fan1 is fixed at 40 %, under the pump's floor of 50 %\.$/)
  assert.deepEqual(posts(cc.requests), [])
  assert.deepEqual(runs, [])
  assert.deepEqual(sleeps, [])
})

test('the pump on a curve profile is refused and nothing is posted', async (t) => {
  const cc = await fakeCoolerControl(t, { modes: modesWithPump({ profile_uid: CURVE }) })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /Graph profile "radNight", not a fixed duty/)
  assert.deepEqual(posts(cc.requests), [])
})

test('the pump through a Fixed profile at 60 % passes and is activated', async (t) => {
  const cc = await fakeCoolerControl(t, { modes: modesWithPump({ profile_uid: FIXED_60 }) })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, true, result.detail)
  assert.deepEqual(lines(posts(cc.requests)), [`POST /modes-active/${NIGHT}`])
})

test('a mode without the pump is refused and nothing is posted', async (t) => {
  const cc = await fakeCoolerControl(t, { modes: modesWithPump(null) })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /does not set fan1, the pump/)
  assert.deepEqual(posts(cc.requests), [])
})

test('a mode in an unknown shape is refused, and so is an unknown list or profile list', async (t) => {
  const oldShape = (mode) => ({ uid: mode.uid, name: mode.name, all_device_settings: { [BOARD]: { fan1: { speed_fixed: 50 } } } })
  const variants = [
    { detail: oldShape },
    { detail: (mode) => ({ ...mode, uid: DAY }) },
    { modes: MODES.modes },
    { modes: { modes: [{ ...modeOf(MODES, 'Night'), uid: '../profiles' }] } },
    { profiles: PROFILES.profiles },
  ]
  for (const variant of variants) {
    const cc = await fakeCoolerControl(t, variant)
    const { ctx } = fansContext(t, cc)
    const result = await fans.night(ctx)
    assert.equal(result.ok, false)
    assert.match(result.detail, /shape night does not know/)
    assert.deepEqual(posts(cc.requests), [])
  }
})

test('two modes with the same name are refused rather than guessed', async (t) => {
  const modes = structuredClone(MODES)
  modes.modes.push({ ...modeOf(MODES, 'Night'), uid: 'e0e0e0e0-0000-4000-8000-000000000009' })
  const cc = await fakeCoolerControl(t, { modes })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /2 modes named "Night"/)
  assert.deepEqual(posts(cc.requests), [])
})

test('a mode that does not exist is skipped with a reason', async (t) => {
  const modes = { modes: MODES.modes.filter((m) => m.name !== 'Night') }
  const cc = await fakeCoolerControl(t, { modes })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.deepEqual(result, { ok: false, skipped: true, detail: 'CoolerControl has no mode named "Night".' })
  assert.deepEqual(lines(cc.requests), ['GET /modes'])
})

test('without a token the step is skipped and no request is sent at all', async (t) => {
  const cc = await fakeCoolerControl(t)
  for (const options of [{ tokenFile: null }, { token: null }, { token: '' }, { token: '   ' }, { tokenFile: '~/missing' }]) {
    const { ctx, runs } = fansContext(t, cc, options)
    assert.deepEqual(await fans.night(ctx), { ok: false, skipped: true, detail: 'no CoolerControl token' })
    assert.deepEqual(runs, [])
  }
  assert.deepEqual(cc.requests, [])
})

test('the token file is read from the home given in ctx', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc, { token: null })
  writeFileSync(join(ctx.home, 'cc-token'), TOKEN, { mode: 0o600 })
  ctx.config.hardware.fans.tokenFile = join(ctx.home, 'cc-token')
  assert.equal((await fans.night(ctx)).ok, true)
  const { ctx: injected } = fansContext(t, cc, { token: null })
  const asked = []
  injected.readFile = async (path) => { asked.push(path); return `${TOKEN}\n` }
  assert.equal((await fans.night(injected)).ok, true)
  assert.deepEqual(asked, [join(injected.home, 'cc-token')])
})

test('a wrong token is refused by CoolerControl and the step fails without posting', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx, runs } = fansContext(t, cc, { token: 'cc_wrong' })
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.skipped, undefined)
  assert.match(result.detail, /refused the token \(HTTP 401\)/)
  assert.deepEqual(lines(cc.requests), ['GET /modes'])
  assert.deepEqual(runs, [])
})

test('CoolerControl not answering fails the step and never throws', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc)
  ctx.config.hardware.fans.url = 'http://127.0.0.1:1'
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /did not answer GET \/modes/)
  ctx.fetch = async () => { throw new Error('boom') }
  assert.match((await fans.night(ctx)).detail, /did not answer GET \/modes \(boom\)/)
})

test('a pump under its RPM floor after Night brings the Day mode back and fails the step', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc, { sensors: lowPump(600) })
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.fellBack, true)
  assert.equal(result.rpm, 600)
  assert.equal(result.detail, 'The pump ran at 600 rpm after Night, under 1300, so Day was activated again.')
  assert.deepEqual(lines(cc.requests), [
    'GET /modes', `GET /modes/${NIGHT}`, 'GET /profiles', `POST /modes-active/${NIGHT}`,
    'GET /modes', `GET /modes/${DAY}`, 'GET /profiles', `POST /modes-active/${DAY}`,
  ])
})

test('a pump whose speed cannot be read counts as low', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc, { sensors: '', sensorsCode: 127 })
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.rpm, null)
  assert.match(result.detail, /could not be read after Night, so Day was activated again/)
  assert.deepEqual(lines(posts(cc.requests)), [`POST /modes-active/${NIGHT}`, `POST /modes-active/${DAY}`])
  const { ctx: throwing } = fansContext(t, cc)
  throwing.run = async () => { throw new Error('no sensors') }
  assert.equal((await fans.night(throwing)).fellBack, true)
})

test('a low pump under Day itself fails without a second activation', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc, { sensors: lowPump(900) })
  const result = await fans.day(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.detail, 'The pump ran at 900 rpm after Day, under 1300.')
  assert.deepEqual(lines(posts(cc.requests)), [`POST /modes-active/${DAY}`])
})

test('a low pump with an unsafe Day mode leaves Day unactivated and says why', async (t) => {
  const cc = await fakeCoolerControl(t, { modes: modesWithPump({ speed_fixed: 30 }, 'Day') })
  const { ctx } = fansContext(t, cc, { sensors: lowPump(500) })
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.fellBack, false)
  assert.match(result.detail, /^The pump ran at 500 rpm after Night, under 1300, and Day was not activated: fan1 is fixed at 30 %/)
  assert.deepEqual(lines(posts(cc.requests)), [`POST /modes-active/${NIGHT}`])
})

test('with pumpDevice set, the GPU fan1 on the default profile no longer blocks a safe board pump', async (t) => {
  const modes = { modes: [{ ...gpuAndBoard(50), name: 'Night' }, modeOf(MODES, 'Day')] }
  const cc = await fakeCoolerControl(t, { modes })
  const { ctx } = fansContext(t, cc, { pumpDevice: 'nct6687' })
  const result = await fans.night(ctx)
  assert.equal(result.ok, true, result.detail)
  assert.deepEqual(lines(cc.requests), [
    'GET /modes', `GET /modes/${NIGHT}`, 'GET /profiles', 'GET /devices', `POST /modes-active/${NIGHT}`,
  ])
})

test('the same mode refuses without pumpDevice, and never asks for the devices', async (t) => {
  const modes = { modes: [{ ...gpuAndBoard(50), name: 'Night' }, modeOf(MODES, 'Day')] }
  const cc = await fakeCoolerControl(t, { modes })
  const { ctx } = fansContext(t, cc)
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /the Default profile "Unmanaged", not a fixed duty/)
  assert.deepEqual(posts(cc.requests), [])
  assert.ok(!lines(cc.requests).includes('GET /devices'))
})

test('a pumpDevice that matches no device, or several, refuses and posts nothing', async (t) => {
  const modes = { modes: [{ ...gpuAndBoard(50), name: 'Night' }, modeOf(MODES, 'Day')] }
  for (const [pumpDevice, said] of [['nct6798', /matches no CoolerControl device/], ['m', /matches 3 CoolerControl devices/]]) {
    const cc = await fakeCoolerControl(t, { modes })
    const { ctx } = fansContext(t, cc, { pumpDevice })
    const result = await fans.night(ctx)
    assert.equal(result.ok, false)
    assert.match(result.detail, said)
    assert.deepEqual(posts(cc.requests), [])
  }
  const cc = await fakeCoolerControl(t, { modes, devices: DEVICES.devices })
  const { ctx } = fansContext(t, cc, { pumpDevice: 'nct6687' })
  assert.match((await fans.night(ctx)).detail, /devices in a shape night does not know/)
  assert.deepEqual(posts(cc.requests), [])
})

test('with pumpDevice set, the board pump at 40 % still refuses', async (t) => {
  const modes = { modes: [{ ...gpuAndBoard(40), name: 'Night' }, modeOf(MODES, 'Day')] }
  const cc = await fakeCoolerControl(t, { modes })
  const { ctx } = fansContext(t, cc, { pumpDevice: 'nct6687' })
  const result = await fans.night(ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /fan1 is fixed at 40 %, under the pump's floor of 50 %/)
  assert.deepEqual(posts(cc.requests), [])
})

test('a mode name is required', async (t) => {
  const cc = await fakeCoolerControl(t)
  const { ctx } = fansContext(t, cc)
  assert.deepEqual(await setMode('', ctx), { ok: false, skipped: true, detail: 'no CoolerControl mode name set' })
  assert.deepEqual(cc.requests, [])
})

// rgb, screens, power with a fake runner

function fakeRun(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = []
  const run = async (argv, options) => {
    calls.push({ argv, options })
    return result
  }
  return { run, calls }
}

test('RGB without a command is skipped and runs nothing', async () => {
  const { run, calls } = fakeRun()
  for (const config of [{ hardware: DEFAULTS.hardware }, {}, undefined]) {
    assert.deepEqual(await rgb.night({ config, run }), { ok: true, skipped: true, detail: 'no RGB command set' })
    assert.deepEqual(await rgb.day({ config, run }), { ok: true, skipped: true, detail: 'no RGB command set' })
  }
  assert.deepEqual(calls, [])
})

test('RGB off runs the owner command with ~ expanded and six minutes to finish', async () => {
  const { run, calls } = fakeRun()
  const config = { hardware: { rgb: { off: ['~/bin/lights', 'off'], on: ['~/bin/lights', 'on'] } } }
  const result = await rgb.night({ config, run, home: '/home/someone' })
  assert.deepEqual(calls, [{ argv: ['/home/someone/bin/lights', 'off'], options: { timeoutMs: 360_000 } }])
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.match(result.detail, /exited 0, which does not prove the lights changed/)
  await rgb.day({ config, run, home: '/home/someone' })
  assert.deepEqual(calls[1].argv, ['/home/someone/bin/lights', 'on'])
})

test('RGB that fails reports its exit code and the last line it wrote', async () => {
  const { run } = fakeRun({ code: 3, stdout: '', stderr: 'starting\nno device found\n' })
  const result = await rgb.night({ config: { hardware: { rgb: { off: ['/opt/rgb', 'off'] } } }, run })
  assert.deepEqual(result, { ok: false, code: 3, detail: 'The RGB off command exited 3: no device found.' })
  const broken = await rgb.night({ config: { hardware: { rgb: { off: '/opt/rgb off' } } }, run })
  assert.equal(broken.ok, false)
  assert.match(broken.detail, /not a list of words/)
})

test('screens use the KDE commands by default: the powerdevil shortcut off, kscreen-doctor on', async () => {
  const { run, calls } = fakeRun()
  const off = await screens.night({ config: {}, run })
  const on = await screens.day({ run })
  assert.deepEqual(calls.map((c) => c.argv), [DEFAULTS.hardware.screens.off, ['kscreen-doctor', '--dpms', 'on']])
  assert.equal(calls[0].argv[4], 'Turn Off Screen')
  assert.equal(off.ok, true)
  assert.equal(off.code, 0)
  assert.equal(on.ok, true)
})

test('screens report the code and stderr of a failure, and follow the config', async () => {
  const { run, calls } = fakeRun({ code: 1, stdout: '', stderr: 'Cannot find the service\n' })
  const config = { hardware: { screens: { off: ['xset', 'dpms', 'force', 'off'], on: null } } }
  const off = await screens.night({ config, run })
  assert.deepEqual(calls[0].argv, ['xset', 'dpms', 'force', 'off'])
  assert.equal(off.ok, false)
  assert.equal(off.code, 1)
  assert.equal(off.stderr, 'Cannot find the service\n')
  assert.equal(off.detail, 'The screens off command (xset) exited 1: Cannot find the service.')
  assert.deepEqual(await screens.day({ config, run }), { ok: true, skipped: true, detail: 'no screens command set' })
})

test('power starts and stops the night services through systemctl --user', async () => {
  const { run, calls } = fakeRun()
  const results = [await power.night({ run }), await power.day({ run }), await power.inhibit({ run }), await power.release({ run })]
  assert.deepEqual(calls.map((c) => c.argv), [
    ['systemctl', '--user', 'start', 'night-power.service'],
    ['systemctl', '--user', 'stop', 'night-power.service'],
    ['systemctl', '--user', 'start', 'night-inhibit.service'],
    ['systemctl', '--user', 'stop', 'night-inhibit.service'],
  ])
  assert.ok(results.every((r) => r.ok && r.code === 0))
})

test('a power step that fails says which unit and why', async () => {
  const { run } = fakeRun({ code: 5, stdout: '', stderr: 'Unit night-power.service not found.\n' })
  assert.deepEqual(await power.night({ run }), {
    ok: false, code: 5, detail: 'systemctl --user start night-power.service exited 5: Unit night-power.service not found.',
  })
})

// runCommand

test('runCommand gives the exit code and both streams', async () => {
  const r = await runCommand([process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])
  assert.deepEqual(r, { code: 3, stdout: 'out', stderr: 'err' })
})

test('runCommand turns a program that cannot start into exit 127, never a rejection', async () => {
  const r = await runCommand(['/nonexistent/night-test-binary', 'x'])
  assert.equal(r.code, 127)
  assert.match(r.stderr, /ENOENT/)
  assert.equal((await runCommand([])).code, 127)
  assert.equal((await runCommand(null)).code, 127)
  assert.equal((await runCommand(['', 'x'])).code, 127)
})

test('runCommand kills a command that runs past its time and says so', async () => {
  const started = Date.now()
  const r = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 })
  assert.equal(r.code, 124)
  assert.match(r.stderr, /timed out after 0.3 s/)
  assert.ok(Date.now() - started < 10_000)
})

test('runCommand passes the env it is given and stdin is empty', async () => {
  const env = { ...process.env, NIGHT_TEST_VALUE: 'dusk' }
  const r = await runCommand([process.execPath, '-e', 'process.stdout.write(process.env.NIGHT_TEST_VALUE)'], { env })
  assert.equal(r.stdout, 'dusk')
  const read = await runCommand([process.execPath, '-e', 'let n = 0; process.stdin.on("data", (d) => { n += d.length }).on("end", () => process.stdout.write(String(n)))'])
  assert.deepEqual(read, { code: 0, stdout: '0', stderr: '' })
})

test('a leading ~ is read as the home, and lastLine finds the last line with words', () => {
  assert.equal(expandHome('~/bin/x', '/home/a'), '/home/a/bin/x')
  assert.equal(expandHome('~', '/home/a'), '/home/a')
  assert.equal(expandHome('/usr/bin/x', '/home/a'), '/usr/bin/x')
  assert.equal(expandHome('~other/x', '/home/a'), '~other/x')
  assert.equal(lastLine('a\nb.\n\n  '), 'b')
  assert.equal(lastLine(undefined), '')
})

// Runs last: what every fake CoolerControl above received.
test('no fake CoolerControl ever received a write other than an empty activation', () => {
  assert.ok(everyRequest.length > 20)
  const writes = everyRequest.filter((r) => r.method !== 'GET')
  assert.ok(writes.length > 0)
  for (const r of writes) {
    assert.equal(r.method, 'POST')
    assert.match(r.path, /^\/modes-active\/[0-9a-f-]+$/)
    assert.equal(r.body, '{}')
  }
})
