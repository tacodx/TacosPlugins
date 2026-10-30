// Fans: activates the owner's CoolerControl modes by name, and nothing else.
//
// The AIO pump is a CoolerControl channel (`fan1` on the owner's nct6687 board). Under
// about 41 % it stalls, and a stalled pump takes the CPU from 39 to 76 °C in 45 s. So
// this file has three walls, each tested against a fake CoolerControl:
//
// - `assertSafeRequest` is the only way out to the API. It lets GET through, and POST
//   /modes-active/<uid> with an empty body; anything else throws before it is sent.
//   Nothing here builds, edits or deletes a mode, a profile or a channel setting.
// - `pumpCheck` reads the mode before it is activated and refuses it unless every
//   setting of the pump channel is a fixed duty of at least pumpMinDuty (never under
//   50), directly or through a Fixed profile. With pumpDevice set, only the channel
//   on the one device GET /devices names that way counts; without it, the channel on
//   every device does. A shape it does not know refuses; it never passes.
// - After activating, the pump's RPM is read from `sensors -j`. Under pumpMinRpm, or
//   unreadable, the Day mode is activated again and the step fails.
//
// The owner makes "Day" and "Night" once in CoolerControl's own UI. CoolerControl 5.1.1
// answers GET /modes with `{ modes: [mode] }` and GET /modes/<uid> with one mode:
// `{ uid, name, device_settings: [[deviceUid, [{ channel_name, speed_fixed,
// profile_uid, lighting, lcd, pwm_mode, reset_to_default }]]] }`. GET /profiles is
// `{ profiles: [{ uid, name, p_type, speed_fixed, ... }] }`, p_type one of Default,
// Fixed, Graph, Mix and Overlay.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import { DEFAULTS } from '../config.mjs'
import { expandHome, runCommand } from './run.mjs'

// The hard floor for the pump, whatever the config says.
const PUMP_FLOOR = 50
const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/
const ACTIVATE = /^\/modes-active\/([^/]+)$/
const UNKNOWN_SHAPE = 'the mode is in a shape night does not know, so its pump cannot be checked'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const fansConfig = (ctx = {}) => ({ ...DEFAULTS.hardware.fans, ...ctx.config?.hardware?.fans })

const emptyBody = (body) => (
  body === undefined || body === null || (typeof body === 'string' && ['', '{}'].includes(body.trim()))
  || (isObject(body) && Object.keys(body).length === 0)
)

/**
 * Throws unless the request only reads, or activates one mode by its uid with an
 * empty body. A request whose path names the pump channel is refused too.
 */
export function assertSafeRequest({ method, path, body } = {}, { channel = DEFAULTS.hardware.fans.pumpChannel } = {}) {
  const verb = String(method ?? '').toUpperCase()
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`refused: ${verb} without an API path`)
  if (channel && path.includes(channel)) throw new Error(`refused: ${verb} ${path} names the pump channel`)
  if (verb === 'GET') {
    if (!emptyBody(body)) throw new Error(`refused: GET ${path} with a body`)
    return
  }
  const uid = ACTIVATE.exec(path)?.[1]
  if (verb !== 'POST' || uid === undefined || !SAFE_UID.test(uid)) {
    throw new Error(`refused: night never sends ${verb} ${path}`)
  }
  if (!emptyBody(body)) throw new Error(`refused: activating a mode carries no body`)
}

// Why a duty is not safe for the pump, or null when it is.
function dutyProblem(duty, what, floor) {
  if (typeof duty !== 'number' || !Number.isFinite(duty) || duty > 100) {
    return `${what} a duty night does not understand (${JSON.stringify(duty)})`
  }
  return duty < floor ? `${what} ${duty} %, under the pump's floor of ${floor} %` : null
}

// Why one setting of the pump channel is not safe, or null when it is.
function settingProblem(setting, channel, floor, profiles) {
  const present = Object.keys(setting).filter((key) => (
    setting[key] !== null && setting[key] !== undefined && !(key === 'reset_to_default' && setting[key] === false)
  ))
  const extra = present.filter((key) => !['channel_name', 'speed_fixed', 'profile_uid'].includes(key))
  if (extra.length) return `${channel} also carries ${extra.join(', ')}, which night does not check`
  const fixed = present.includes('speed_fixed')
  const profiled = present.includes('profile_uid')
  if (fixed && profiled) return `${channel} has both a fixed duty and a profile`
  if (fixed) return dutyProblem(setting.speed_fixed, `${channel} is fixed at`, floor)
  if (!profiled) return `${channel} has neither a fixed duty nor a profile`

  const uid = setting.profile_uid
  const matches = (Array.isArray(profiles) ? profiles : []).filter((p) => isObject(p) && p.uid === uid)
  if (matches.length !== 1) {
    return `${channel} uses profile ${JSON.stringify(uid)}, which CoolerControl ${matches.length ? 'lists twice' : 'does not list'}`
  }
  const [profile] = matches
  const label = JSON.stringify(String(profile.name ?? uid))
  if (profile.p_type !== 'Fixed') {
    return `${channel} uses the ${String(profile.p_type ?? 'untyped')} profile ${label}, not a fixed duty`
  }
  return dutyProblem(profile.speed_fixed, `${channel} uses the fixed profile ${label} at`, floor)
}

/**
 * Whether `mode` keeps the pump safe: every setting of `channel` is a fixed duty of
 * at least `minDuty` (never under 50), set directly or through a Fixed profile from
 * `profiles` (GET /profiles). With `device` (a device uid) only that device's
 * `channel` counts; without it, `channel` on every device does. A curve, a missing
 * setting, or anything this does not recognise refuses. Returns `{ ok, reason }`.
 */
export function pumpCheck(mode, { channel, minDuty = PUMP_FLOOR, profiles = [], device = null } = {}) {
  const refuse = (reason) => ({ ok: false, reason })
  const floor = Math.max(PUMP_FLOOR, Number.isFinite(minDuty) ? minDuty : PUMP_FLOOR)
  if (typeof channel !== 'string' || channel === '') return refuse('no pump channel is configured, so no mode can be checked')
  if (device !== null && device !== undefined && (typeof device !== 'string' || device === '')) {
    return refuse('the pump device is not a device uid, so no mode can be checked')
  }
  if (!isObject(mode) || !Array.isArray(mode.device_settings)) return refuse(UNKNOWN_SHAPE)

  const found = []
  for (const entry of mode.device_settings) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      return refuse(UNKNOWN_SHAPE)
    }
    for (const setting of entry[1]) {
      if (!isObject(setting) || typeof setting.channel_name !== 'string') return refuse(UNKNOWN_SHAPE)
      if (setting.channel_name === channel && (!device || entry[0] === device)) found.push(setting)
    }
  }
  if (found.length === 0) {
    const where = device ? ' on the pump\'s device' : ''
    return refuse(`the mode does not set ${channel}${where}, the pump, and it must set it explicitly`)
  }

  for (const setting of found) {
    const problem = settingProblem(setting, channel, floor, profiles)
    if (problem) return refuse(problem)
  }
  return { ok: true, reason: `${channel} runs at a fixed duty of at least ${floor} % wherever the mode sets it` }
}

const matchesText = (device, text) => [device.name, device.type, device.info?.model, device.info?.driver_info?.name]
  .some((field) => typeof field === 'string' && field.toLowerCase().includes(text))

/**
 * The uid of the one device in GET /devices whose name, type, model or driver
 * contains `text` (any case), or `{ reason }` when none or several do.
 */
export function pumpDeviceUid(devices, text) {
  if (typeof text !== 'string' || text.trim() === '') return { reason: 'hardware.fans.pumpDevice is not a device name' }
  if (!isObject(devices) || !Array.isArray(devices.devices)) {
    return { reason: 'CoolerControl listed its devices in a shape night does not know' }
  }
  const wanted = text.trim().toLowerCase()
  const found = devices.devices.filter((device) => isObject(device) && matchesText(device, wanted))
  if (found.length !== 1) {
    return { reason: `the pump device "${text}" matches ${found.length ? `${found.length} CoolerControl devices` : 'no CoolerControl device'}` }
  }
  const { uid } = found[0]
  return typeof uid === 'string' && uid !== '' ? { uid } : { reason: `the pump device "${text}" has no uid` }
}

/** The RPM of `<channel>_input` on the nct6687 chip in `sensors -j` output, else null. */
export function pumpRpm(sensorsJson, channel) {
  let sensors = sensorsJson
  if (typeof sensors === 'string') {
    try { sensors = JSON.parse(sensors) } catch { return null }
  }
  if (!isObject(sensors) || typeof channel !== 'string' || channel === '') return null
  const key = `${channel}_input`
  for (const [chip, features] of Object.entries(sensors)) {
    if (!chip.startsWith('nct6687') || !isObject(features)) continue
    for (const feature of Object.values(features)) {
      if (isObject(feature) && typeof feature[key] === 'number' && Number.isFinite(feature[key])) return feature[key]
    }
  }
  return null
}

const timedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })

function context(ctx) {
  const fans = fansConfig(ctx)
  return {
    fans,
    base: String(fans.url ?? '').replace(/\/+$/, ''),
    home: ctx.home ?? process.env.HOME ?? homedir(),
    fetch: ctx.fetch ?? timedFetch,
    run: ctx.run ?? runCommand,
    sleep: ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    readFile: ctx.readFile ?? readFile,
    settleMs: ctx.settleMs ?? 8_000,
    token: null,
  }
}

async function readToken(c) {
  if (typeof c.fans.tokenFile !== 'string' || c.fans.tokenFile === '') return null
  try {
    const token = String(await c.readFile(expandHome(c.fans.tokenFile, c.home), 'utf8')).trim()
    return token !== '' && !/\s/.test(token) ? token : null
  } catch {
    return null
  }
}

// One request, through the filter. Throws a sentence when it fails.
async function call(c, method, path) {
  const body = method === 'GET' ? undefined : '{}'
  assertSafeRequest({ method, path, body }, { channel: c.fans.pumpChannel })
  const headers = { Authorization: `Bearer ${c.token}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await c.fetch(`${c.base}${path}`, { method, headers, body })
  } catch (err) {
    throw new Error(`CoolerControl did not answer ${method} ${path} (${err?.message ?? err})`)
  }
  if (res.status === 401 || res.status === 403) throw new Error(`CoolerControl refused the token (HTTP ${res.status})`)
  if (!res.ok) throw new Error(`CoolerControl answered HTTP ${res.status} to ${method} ${path}`)
  if (method !== 'GET') return null
  try {
    return await res.json()
  } catch {
    throw new Error(`CoolerControl's answer to GET ${path} is not JSON`)
  }
}

// Finds the mode called `name`, checks the pump in it, and activates it. `posted`
// says whether the activation went out, so the caller knows to look at the pump.
async function activate(name, c) {
  let posted = false
  try {
    const list = await call(c, 'GET', '/modes')
    if (!isObject(list) || !Array.isArray(list.modes)) {
      return { ok: false, posted, detail: `${name} was not activated: CoolerControl listed its modes in a shape night does not know` }
    }
    const found = list.modes.filter((mode) => isObject(mode) && mode.name === name)
    if (found.length === 0) return { ok: false, skipped: true, posted, detail: `CoolerControl has no mode named "${name}"` }
    if (found.length > 1) return { ok: false, posted, detail: `CoolerControl has ${found.length} modes named "${name}", so night does not pick one` }
    const { uid } = found[0]
    if (typeof uid !== 'string' || !SAFE_UID.test(uid)) return { ok: false, posted, detail: `${name} was not activated: ${UNKNOWN_SHAPE}` }

    const mode = await call(c, 'GET', `/modes/${uid}`)
    if (!isObject(mode) || mode.uid !== uid) return { ok: false, posted, detail: `${name} was not activated: ${UNKNOWN_SHAPE}` }
    const listed = await call(c, 'GET', '/profiles')
    if (!isObject(listed) || !Array.isArray(listed.profiles)) {
      return { ok: false, posted, detail: `${name} was not activated: CoolerControl listed its profiles in a shape night does not know` }
    }
    let device = null
    if (c.fans.pumpDevice !== null && c.fans.pumpDevice !== undefined) {
      const found = pumpDeviceUid(await call(c, 'GET', '/devices'), c.fans.pumpDevice)
      if (!found.uid) return { ok: false, posted, detail: `${name} was not activated: ${found.reason}` }
      device = found.uid
    }
    const check = pumpCheck(mode, { channel: c.fans.pumpChannel, minDuty: c.fans.pumpMinDuty, profiles: listed.profiles, device })
    if (!check.ok) return { ok: false, posted, detail: `${name} was not activated: ${check.reason}` }

    posted = true
    await call(c, 'POST', `/modes-active/${uid}`)
    return { ok: true, posted, detail: `${name} is active` }
  } catch (err) {
    return { ok: false, posted, detail: `${name} ${posted ? 'may not be active' : 'was not activated'}: ${err.message}` }
  }
}

async function readPumpRpm(c) {
  try {
    const { stdout } = await c.run(['sensors', '-j'], { timeoutMs: 10_000 })
    return pumpRpm(stdout, c.fans.pumpChannel)
  } catch {
    return null
  }
}

/**
 * Activates the CoolerControl mode called `name` after checking its pump, then reads
 * the pump's RPM; under the floor the Day mode comes back. Returns `{ ok, detail }`,
 * with `skipped` when there is no token or no such mode. Never throws.
 * ctx: { config, home, fetch, run, sleep, readFile, settleMs }.
 */
export async function setMode(name, ctx = {}) {
  const c = context(ctx)
  const token = await readToken(c)
  if (!token) return { ok: false, skipped: true, detail: 'no CoolerControl token' }
  if (typeof name !== 'string' || name === '') return { ok: false, skipped: true, detail: 'no CoolerControl mode name set' }
  c.token = token

  const done = await activate(name, c)
  if (!done.posted) return { ok: false, ...(done.skipped ? { skipped: true } : {}), detail: `${done.detail}.` }

  await c.sleep(c.settleMs)
  const rpm = await readPumpRpm(c)
  const floor = c.fans.pumpMinRpm
  if (rpm !== null && rpm >= floor) {
    return { ok: done.ok, rpm, detail: done.ok ? `${name} is active and the pump runs at ${rpm} rpm.` : `${done.detail}; the pump runs at ${rpm} rpm.` }
  }

  const low = rpm === null
    ? `The pump's speed could not be read after ${name}`
    : `The pump ran at ${rpm} rpm after ${name}, under ${floor}`
  const day = c.fans.dayMode
  if (name === day) return { ok: false, rpm, detail: `${done.ok ? '' : `${done.detail}. `}${low}.` }
  const back = await activate(day, c)
  return {
    ok: false,
    rpm,
    fellBack: back.ok,
    detail: back.ok ? `${low}, so ${day} was activated again.` : `${low}, and ${back.detail}.`,
  }
}

/** Dusk: activates the Night mode. */
export const night = (ctx = {}) => setMode(fansConfig(ctx).nightMode, ctx)

/** Dawn, and whenever the pump or the heat asks for it: activates the Day mode. */
export const day = (ctx = {}) => setMode(fansConfig(ctx).dayMode, ctx)
