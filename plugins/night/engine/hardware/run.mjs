// How every hardware step starts a command. `runCommand` never throws and never
// rejects: a command that cannot start is exit 127 with the reason in stderr, and one
// that runs past its time is killed with everything it started and reported as exit
// 124. Stdin is /dev/null, so nothing waits on a terminal that is not there.
import { spawn } from 'node:child_process'
import { constants, homedir } from 'node:os'
import { join } from 'node:path'

// The tail of each stream that is kept; a chatty RGB script must not fill memory.
const KEEP = 64 * 1024

/** `path` with a leading `~` read as `home`. Anything else comes back as it was. */
export function expandHome(path, home = process.env.HOME || homedir()) {
  if (path === '~') return home
  if (typeof path === 'string' && path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** Whether `argv` is a command: a non-empty list of words with a program first. */
export const isArgv = (argv) => (
  Array.isArray(argv) && argv.length > 0 && argv[0] !== '' && argv.every((word) => typeof word === 'string')
)

/** The last line of `text` that says something, without its full stop, or ''. */
export function lastLine(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim().replace(/\.+$/, '')).filter(Boolean)
  return lines.at(-1) ?? ''
}

/** Runs `argv` and resolves with `{ code, stdout, stderr }`. Never rejects. */
export function runCommand(argv, { timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    if (!isArgv(argv)) {
      resolve({ code: 127, stdout: '', stderr: 'no command given' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (code, note = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const joined = note ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${note}` : stderr
      resolve({ code, stdout, stderr: joined })
    }

    let child
    try {
      // Its own process group, so a timeout ends the scripts it started as well.
      child = spawn(argv[0], argv.slice(1), { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (err) {
      finish(127, err.message)
      return
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = (stdout + chunk).slice(-KEEP) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-KEEP) })
    child.on('error', (err) => finish(127, err.message))
    child.on('close', (code, signal) => {
      if (code !== null) finish(code)
      else finish(128 + (constants.signals[signal] ?? 0), `ended by ${signal}`)
    })
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      finish(124, `timed out after ${timeoutMs / 1000} s`)
    }, timeoutMs)
  })
}
