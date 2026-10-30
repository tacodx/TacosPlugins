// What the logs watcher makes of the journal: which lines matter and which are repeats.
//
// Pure: `journalctl -o json` objects in, events out. The watcher service owns the
// `journalctl -f` processes and the file the events land in. A line is an event when it
// reports a unit failing, an out-of-memory kill, a segfault, a core dump, or is any
// other error; everything else, and a short list of known harmless complaints, is noise.

const MAX_TEXT = 400

// Errors that mean nothing for a night. Add a pattern here, not a special case below.
const NOISE = [
  /\[i2c_smbus_linux\] Failed to read i2c device PCI device ID/,
]

// In order: an OOM kill also reads as a failed unit, so it is looked for first.
const BY_MESSAGE = [
  ['oom', /out of memory|oom-kill|killed process|invoked oom-killer|oom killer|memory\.max/i],
  ['segfault', /segfault at/i],
  ['coredump', /dumped core/i],
  ['unit-failed', /failed with result|main process exited, code=|scheduled restart job, restart counter is at/i],
]

// The journal writes a message with unprintable bytes as an array of byte values.
function decode(message) {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return Buffer.from(message).toString('utf8')
  return ''
}

const text = (v) => (typeof v === 'string' && v !== '' ? v : null)

/**
 * One `journalctl -o json` object as an event `{ kind, unit, text, at }`, or null when
 * it is noise. `kind` is unit-failed, oom, segfault, coredump or error; `at` is in ms.
 */
export function classify(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const message = decode(entry.MESSAGE).trim()
  if (!message || NOISE.some((pattern) => pattern.test(message))) return null

  let kind = BY_MESSAGE.find(([, pattern]) => pattern.test(message))?.[0] ?? null
  if (kind === null && entry.SYSLOG_IDENTIFIER === 'systemd-coredump') kind = 'coredump'
  if (kind === null && parseInt(entry.PRIORITY, 10) <= 3) kind = 'error'
  if (kind === null) return null

  const micros = Number(entry.__REALTIME_TIMESTAMP)
  return {
    kind,
    // UNIT and USER_UNIT name the unit a manager message is about; the _SYSTEMD ones, the unit that spoke.
    unit: text(entry.UNIT) ?? text(entry.USER_UNIT) ?? text(entry._SYSTEMD_USER_UNIT) ?? text(entry._SYSTEMD_UNIT),
    text: message.slice(0, MAX_TEXT),
    at: Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) : null,
  }
}

/**
 * Returns `(event, now) => boolean`: true when the event should be recorded. The same
 * kind, unit and text (digits ignored) is recorded once per window; the repeats held
 * back are counted onto the next one recorded, as `repeats`.
 */
export function createDeduper(windowMs = 600_000) {
  const seen = new Map()
  return (event, now = Date.now()) => {
    const key = `${event.kind}|${event.unit}|${String(event.text).replace(/\d+/g, '#')}`
    const last = seen.get(key)
    if (last && now - last.at < windowMs) {
      last.repeats += 1
      return false
    }
    if (last && last.repeats > 0) event.repeats = last.repeats
    seen.set(key, { at: now, repeats: 0 })
    return true
  }
}

/** The `journalctl` command that follows new lines only: night's units, or the system's errors. */
export function followArgs({ system = false } = {}) {
  return system
    ? ['journalctl', '-f', '-o', 'json', '-n', '0', '-p', 'err']
    : ['journalctl', '--user', '-f', '-o', 'json', '-n', '0', '-u', 'night-*']
}
