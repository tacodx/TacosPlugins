export function parseHookInput(raw) {
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch { return {} } // junk stdin (not JSON, or JSON scalar) parses to an empty object
}

export function allowOutput() { return null }

export function denyOutput(hookEventName, reason) {
  return { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason } }
}

export function contextOutput(hookEventName, text) {
  return { hookSpecificOutput: { hookEventName, additionalContext: text } }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * ALWAYS exits 0. exit 2 is the only code that blocks a tool call, so an
 * uncaught throw here would deny every matching call.
 */
export function run(main) {
  const finish = (output) => {
    try { if (output) process.stdout.write(JSON.stringify(output)) } catch { /* malformed output (e.g. BigInt, circular ref) must still allow */ }
    process.exit(0)
  }
  const guard = setTimeout(() => finish(null), 4500)
  guard.unref() // the deadline is a safety net, not a reason to keep the process alive
  readStdin()
    .then((raw) => main(parseHookInput(raw)))
    .then((out) => { clearTimeout(guard); finish(out) })
    .catch(() => { clearTimeout(guard); finish(null) }) // any failure in reading stdin or running main must still allow
  process.on('uncaughtException', () => finish(null)) // last-resort net: a bug here must allow, never deny
  process.on('unhandledRejection', () => finish(null)) // last-resort net: a bug here must allow, never deny
}
