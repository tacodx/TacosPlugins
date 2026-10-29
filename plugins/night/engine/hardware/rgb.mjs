// RGB lights: the owner's own commands, "off" at dusk and "on" at dawn. On the
// owner's machine the script takes about two minutes and its exit code proves
// nothing, so exit 0 is reported as "it ran", never as "the lights changed".
import { expandHome, isArgv, lastLine, runCommand } from './run.mjs'

const TIMEOUT_MS = 6 * 60_000

async function lights(which, ctx = {}) {
  const argv = ctx.config?.hardware?.rgb?.[which]
  if (argv === null || argv === undefined) return { ok: true, skipped: true, detail: 'no RGB command set' }
  if (!isArgv(argv)) return { ok: false, detail: `hardware.rgb.${which} is not a list of words` }
  const run = ctx.run ?? runCommand
  const { code, stderr } = await run([expandHome(argv[0], ctx.home), ...argv.slice(1)], { timeoutMs: TIMEOUT_MS })
  if (code === 0) {
    return { ok: true, code, detail: `The RGB ${which} command exited 0, which does not prove the lights changed.` }
  }
  const why = lastLine(stderr)
  return { ok: false, code, detail: `The RGB ${which} command exited ${code}${why ? `: ${why}` : ''}.` }
}

/** Dusk: runs `hardware.rgb.off`. */
export const night = (ctx) => lights('off', ctx)

/** Dawn: runs `hardware.rgb.on`. */
export const day = (ctx) => lights('on', ctx)
