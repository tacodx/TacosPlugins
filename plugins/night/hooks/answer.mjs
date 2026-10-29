// What one run of `bin/night.mjs` amounts to. Pure: no Node, no engine.
//
// `view` prints a View. Every action prints `{ ok: true, view }`, or
// `{ ok: false, error }` and exits 1, so stdout is read before the exit code.

const isObject = (value) => typeof value === 'object' && value !== null

/** Whether a value is a View this pane can draw: version 1. */
export const isView = (value) => isObject(value) && value.version === 1

/**
 * A View, or the reason there is none.
 * @param {{ exitCode: number, stdout: string, stderr: string, isStdoutTruncated: boolean }} ran
 * @returns {{ view: any } | { reason: string }}
 */
export function readRun(ran) {
  if (ran.isStdoutTruncated) return { reason: 'night printed more than this pane can read' }
  let parsed
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    parsed = undefined
  }
  if (isView(parsed)) return { view: parsed }
  if (isObject(parsed) && parsed.ok === true && isView(parsed.view)) return { view: parsed.view }
  if (isObject(parsed) && parsed.ok === false) {
    return { reason: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : 'night said no without saying why' }
  }
  if (ran.exitCode !== 0) {
    const said = ran.stderr.trim().replace(/^night: /, '')
    return { reason: said === '' ? `night stopped with exit code ${ran.exitCode}` : said.slice(0, 400) }
  }
  if (parsed === undefined) return { reason: 'night did not print a view' }
  return { reason: 'night printed a view this pane does not understand' }
}
