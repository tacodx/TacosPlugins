// Screens: blanked at dusk, woken at dawn. The defaults are KDE Plasma's: powerdevil's
// "Turn Off Screen" shortcut, because `kscreen-doctor --dpms off` exits 0 and leaves
// the screens on, and `kscreen-doctor --dpms on` to wake them. Another desktop sets
// both commands in config.json.
import { DEFAULTS } from '../config.mjs'
import { isArgv, lastLine, runCommand } from './run.mjs'

async function screens(which, ctx = {}) {
  const argv = { ...DEFAULTS.hardware.screens, ...ctx.config?.hardware?.screens }[which]
  if (argv === null || argv === undefined) return { ok: true, skipped: true, detail: 'no screens command set' }
  if (!isArgv(argv)) return { ok: false, detail: `hardware.screens.${which} is not a list of words` }
  const run = ctx.run ?? runCommand
  const { code, stderr } = await run(argv, { timeoutMs: 30_000 })
  const why = lastLine(stderr)
  return {
    ok: code === 0,
    code,
    stderr,
    detail: `The screens ${which} command (${argv[0]}) exited ${code}${why ? `: ${why}` : ''}.`,
  }
}

/** Dusk: runs `hardware.screens.off`. */
export const night = (ctx) => screens('off', ctx)

/** Dawn: runs `hardware.screens.on`. */
export const day = (ctx) => screens('on', ctx)
