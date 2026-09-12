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
 *
 * deadlineMs is injectable (default 4500) purely so tests can exercise the
 * deadline path without the suite sitting for 4.5s; production call sites
 * never need to pass it.
 */
export function run(main, deadlineMs = 4500) {
  const finish = (output) => {
    try { if (output) process.stdout.write(JSON.stringify(output)) } catch { /* malformed output (e.g. BigInt, circular ref) must still allow */ }
    process.exit(0)
  }
  const guard = setTimeout(() => finish(null), deadlineMs)
  guard.unref() // the deadline is a safety net, not a reason to keep the process alive
  readStdin()
    .then((raw) => main(parseHookInput(raw)))
    .then((out) => { clearTimeout(guard); finish(out) })
    .catch(() => { clearTimeout(guard); finish(null) }) // any failure in reading stdin or running main must still allow
  // These two are NOT load-bearing for deny-safety: Node's own default handler for an
  // uncaught exception or rejection already exits with code 1, and Claude Code only
  // treats exit 2 as a deny — exit 1 already allows. No path through this file ever
  // produces exit 2. What these buy instead is stderr hygiene (no raw stack trace
  // printed past a hook's own timeout) and a clean, deliberate exit 0 in place of
  // Node's default exit 1, so a hook failure looks the same as a normal allow.
  process.on('uncaughtException', () => finish(null))
  process.on('unhandledRejection', () => finish(null))
}
