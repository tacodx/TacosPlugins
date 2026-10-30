// How a night worker's Claude Code session is started, and how its output is read.
// Pure: argv, environment, settings and prompts are built here; worker.mjs spawns.
//
// Three walls sit under the guard hook (spec section 8.1): Claude's Bash sandbox
// keeps every write inside the worktree, the scratch folder and the caches given
// with --add-dir; git itself rewrites every push URL to a host that does not
// exist; and the hook command fails closed.

export const WORKER_RULES = `You are a night worker. The owner of this project is asleep until morning and will not answer anything.

- Never ask a question. When a choice is the owner's to make, take the most conservative option, write the choice and the reason as one line to the file named in $NIGHT_DECISIONS, and keep going. If the item cannot be done without him, stop and say so in your result line.
- Work only in this git worktree, on the branch you are on. Never switch branches, push, merge into another branch, open pull requests, deploy, publish, send messages or change accounts or settings. These are blocked anyway; do not look for ways around a block.
- Commit after every finished unit with a plain message that says what changed and why. No AI attribution, no Co-Authored-By lines, no em dashes. Never use --no-verify; if a pre-commit hook refuses a commit, fix the cause.
- If the plan file has a checkbox for the step you finished, tick it in the same commit.
- Heavy commands (tests, builds) are wrapped in a lock so only one runs at a time across all workers; if a command seems to wait, that is why. Never run anything in watch mode or start a server you do not stop.
- Keep private notes out of the repository: write them to $NIGHT_DECISIONS.
- When the item is done, or you cannot go further, end your final message with exactly one line:
NIGHT-RESULT: done|partial|needs-owner · <one plain sentence on what you did, or what the owner must decide>`

/**
 * The settings file every worker runs with: the sandbox, the guard hook, no
 * attribution. Given with --settings, it outranks a project's own settings, so a
 * worker that writes .claude/settings.local.json cannot switch the hook off or
 * change the push block. The hook gets two minutes: under memory pressure even
 * starting node can be slow, and a hook that times out must not let a call through.
 */
export function workerSettings({ node, guard, env = {} }) {
  return {
    includeCoAuthoredBy: false,
    disableAllHooks: false,
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
    env: pick(env, (key) => key.startsWith('GIT_CONFIG_') || ['GH_TOKEN', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT'].includes(key)),
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${node}" "${guard}" || exit 2`, timeout: 120 }] }],
    },
  }
}

const pick = (env, keep) => Object.fromEntries(Object.entries(env).filter(([key]) => keep(key)))

/**
 * Empty files Claude's Bash sandbox leaves in the working folder as mount points for
 * paths it protects. They are not work: workers' git ignores them, and a commit of
 * leftovers never takes them.
 */
export const SANDBOX_PLACEHOLDERS = [
  '.bash_profile', '.bashrc', '.profile', '.zprofile', '.zshrc', '.gitconfig', '.gitmodules', '.ripgreprc', '.mcp.json',
  '.idea', '.vscode', '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/launch.json', '.claude/loop.md',
  '.claude/output-styles', '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json', '.claude/skills',
  '.claude/workflows',
]

/** The worker's git excludes: the owner's own global ignore file, then the placeholders. */
export function excludesText(globalIgnore = '') {
  return `${globalIgnore.trimEnd()}\n# night: the empty mount points Claude's sandbox leaves behind\n${SANDBOX_PLACEHOLDERS.map((p) => `/${p}`).join('\n')}\n`.trimStart()
}

const PUSH_BLOCK = ['https://', 'http://', 'git@', 'ssh://', 'git://']
// After the push rewrites: an empty credential.helper clears every helper, so https has no credentials either.
const EXTRA_CONFIG = [['credential.helper', '']]

/** The environment of a worker's Claude session. */
export function workerEnv(base, { slot, worktree, scratch, protectedBranches, testLock, events, decisions, secrets = [], excludesFile }) {
  const env = { ...base }
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK', 'GIT_DIR', 'GIT_WORK_TREE', 'CLAUDECODE', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) delete env[key]
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  Object.assign(env, {
    NIGHT_WORKER: '1',
    NIGHT_SLOT: String(slot),
    NIGHT_WORKTREE: worktree,
    NIGHT_SCRATCH: scratch,
    NIGHT_PROTECTED: protectedBranches.join(','),
    NIGHT_TEST_LOCK: testLock,
    NIGHT_EVENTS: events,
    NIGHT_DECISIONS: decisions,
    NIGHT_SECRETS: secrets.join(':'),
    TMPDIR: `${scratch}/tmp`,
    CI: '1',
    PW_TEST_HTML_REPORT_OPEN: 'never',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    EDITOR: 'true',
    VISUAL: 'true',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    SSH_ASKPASS_REQUIRE: 'never',
    // No ssh at all: a remote with its own pushurl ignores pushInsteadOf, and a key without a passphrase would push.
    GIT_SSH_COMMAND: 'false',
    BROWSER: 'true',
    npm_config_yes: 'true',
    GH_TOKEN: 'night-blocked',
    GIT_CONFIG_COUNT: String(PUSH_BLOCK.length + EXTRA_CONFIG.length),
  })
  PUSH_BLOCK.forEach((prefix, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = 'url.night-blocked:.pushInsteadOf'
    env[`GIT_CONFIG_VALUE_${i}`] = prefix
  })
  const extra = excludesFile ? [...EXTRA_CONFIG, ['core.excludesFile', excludesFile]] : EXTRA_CONFIG
  env.GIT_CONFIG_COUNT = String(PUSH_BLOCK.length + extra.length)
  extra.forEach(([key, value], j) => {
    env[`GIT_CONFIG_KEY_${PUSH_BLOCK.length + j}`] = key
    env[`GIT_CONFIG_VALUE_${PUSH_BLOCK.length + j}`] = value
  })
  return env
}

/** argv for one run of a worker's Claude session. */
export function workerArgs({ prompt, sessionId, resume, model, settingsPath, addDirs = [], name }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--setting-sources', 'project,local', '--settings', settingsPath, '--strict-mcp-config', '--disable-slash-commands',
    '--no-chrome', '--append-system-prompt', WORKER_RULES]
  for (const dir of addDirs) args.push('--add-dir', dir)
  args.push(resume ? '--resume' : '--session-id', sessionId)
  if (name) args.push('--name', name)
  if (model) args.push('--model', model)
  return args
}

/** The message that hands a worker one item. */
export function itemPrompt(item, { branch, resumed, continuing }) {
  if (continuing) {
    return `Continue the item you were working on ("${item.title}"). You were interrupted (${continuing}). Check git status and git log first, then finish it. End with the NIGHT-RESULT line.`
  }
  return [
    resumed ? 'Next item on the same project. Check git status first.' : `You are on the branch ${branch}, cut from ${item.base}.`,
    '',
    `Item: ${item.title}`,
    `Why: ${item.why}`,
    `Done when: ${item.doneWhen}`,
    item.source ? `Source: ${item.source}` : '',
    '',
    'Work until it is done, committing as you go. End with the NIGHT-RESULT line.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n')
}

const RESULT = /NIGHT-RESULT:\s*(done|partial|needs-owner)\s*[·:\-|]?\s*(.*)$/im

/** The NIGHT-RESULT line in a worker's final text, or null. */
export function parseResultLine(text) {
  const matches = [...String(text ?? '').matchAll(new RegExp(RESULT.source, 'gim'))]
  const last = matches.at(-1)
  return last ? { outcome: last[1].toLowerCase(), line: last[2].trim().slice(0, 300) } : null
}

const LOGIN = /(\/login|not logged in|invalid api key|oauth token (has )?expired|authentication[_ ]error|401\b)/i
const TRANSIENT = /(overloaded|529|5\d\d\b|api error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed)/i

/**
 * What a finished run said, from its stream-json lines: the result text, the
 * session id, and why it stopped (`result`, `limit`, `login`, `transient`, `crash`).
 */
export function readRun(lines, { exitCode, signal } = {}) {
  let result = null
  let sessionId = null
  let limit = null
  const texts = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    if (line.session_id) sessionId = line.session_id
    if (line.type === 'result') result = line
    if (line.type === 'assistant') {
      const info = line.message?.apiErrorParams?.rate_limit_info ?? line.apiErrorParams?.rate_limit_info
      if (line.error === 'rate_limit' || line.message?.error === 'rate_limit' || info) {
        const at = Number(info?.resetsAt)
        limit = { resetsAt: Number.isFinite(at) && at > 0 ? at * 1000 : null }
      }
      for (const block of line.message?.content ?? []) if (block?.type === 'text') texts.push(block.text)
    }
  }
  const finalText = result?.result ?? texts.at(-1) ?? ''
  const parsed = parseResultLine(finalText) ?? parseResultLine(texts.join('\n'))
  const said = `${finalText} ${result?.subtype ?? ''}`
  let stop = 'crash'
  // A successful result wins: its text may well mention a usage limit in passing.
  if (result && !result.is_error && !limit) stop = 'result'
  else if (limit || /hit your (session |weekly )?limit|usage limit|rate_limit/i.test(said)) stop = 'limit'
  else if (LOGIN.test(said)) stop = 'login'
  else if (TRANSIENT.test(said)) stop = 'transient'
  else if (result?.is_error && result?.subtype === 'error_max_turns') stop = 'result'
  if (signal) stop = stop === 'result' ? 'result' : 'killed'
  return { stop, sessionId, parsed, limit, text: finalText.slice(-2000), exitCode, cost: result?.total_cost_usd ?? null }
}

/** How long to wait before the next try after a transient failure: 1, 5, then 15 minutes. */
export const backoffMs = (step) => [60_000, 5 * 60_000, 15 * 60_000][Math.min(step, 2)]
