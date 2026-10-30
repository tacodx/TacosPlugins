// Power and sleep: two user services that `night install` writes do the holding.
// `night-power.service` keeps the power-saver profile for as long as it runs, and
// `night-inhibit.service` keeps the machine from sleeping. These steps only start
// and stop them, so running one twice changes nothing.
import { lastLine, runCommand } from './run.mjs'

async function systemctl(verb, unit, ctx = {}) {
  const run = ctx.run ?? runCommand
  const { code, stderr } = await run(['systemctl', '--user', verb, unit], { timeoutMs: 30_000 })
  const why = lastLine(stderr)
  return { ok: code === 0, code, detail: `systemctl --user ${verb} ${unit} exited ${code}${why ? `: ${why}` : ''}.` }
}

/** Dusk: holds the power-saver profile. */
export const night = (ctx) => systemctl('start', 'night-power.service', ctx)

/** Dawn: lets the profile go. */
export const day = (ctx) => systemctl('stop', 'night-power.service', ctx)

/** Dusk: keeps the machine awake until Stop. */
export const inhibit = (ctx) => systemctl('start', 'night-inhibit.service', ctx)

/** Stop: lets the machine sleep again. */
export const release = (ctx) => systemctl('stop', 'night-inhibit.service', ctx)
