// The night in progress: its phase, its events and every service's heartbeat.
//
// Phases, in order: armed (timers set), dusk (the hardware going dark), night
// (services running), day (dawn ran, workers go on), stopped. `idle` means no
// night is armed.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { nightFiles } from './config.mjs'
import { appendJsonl, readJson, writeJson } from './fsx.mjs'

export const PHASES = ['idle', 'armed', 'dusk', 'night', 'day', 'stopped']

/** Phases in which the night's services should be running. */
export const RUNNING = new Set(['dusk', 'night', 'day'])

export function readCurrent(paths) {
  const current = readJson(paths.current, null)
  if (!current || !PHASES.includes(current.phase)) return { phase: 'idle' }
  return current
}

export function writeCurrent(paths, current) {
  writeJson(paths.current, current)
  return current
}

/** Changes the current night with `fn` and saves it. */
export function updateCurrent(paths, fn) {
  return writeCurrent(paths, fn(readCurrent(paths)))
}

/** The files of the night in progress, or null when none is. */
export function currentFiles(paths) {
  const current = readCurrent(paths)
  return current.date ? nightFiles(paths, current.date) : null
}

/** Records one thing that happened, stamped with the time. */
export function addEvent(files, kind, details = {}, now = Date.now()) {
  if (!files) return
  appendJsonl(files.events, { at: new Date(now).toISOString(), kind, ...details })
}

/** A service says it is alive. */
export function beat(files, name, details = {}, now = Date.now()) {
  if (!files) return
  writeJson(join(files.beats, `${name}.json`), { name, at: now, pid: process.pid, ...details })
}

/** Every heartbeat of the night, by service name. */
export function readBeats(files) {
  const beats = {}
  let names = []
  try { names = readdirSync(files.beats) } catch { return beats }
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    const value = readJson(join(files.beats, file))
    if (value?.name) beats[value.name] = value
  }
  return beats
}

/** Heartbeat names older than `maxAgeMs`, or missing, among `names`. */
export function staleBeats(beats, names, now, maxAgeMs) {
  return names.filter((name) => !beats[name] || now - beats[name].at > maxAgeMs)
}
