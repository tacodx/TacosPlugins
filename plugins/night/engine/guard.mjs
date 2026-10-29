// The night guard's judgement on one tool call of a night worker: let it run,
// refuse it with a reason that says what to do instead, or let it run rewritten
// (a heavy test run waits for the shared test lock). Pure: no fs, no env, no
// clock; bin/guard.mjs builds the context from the worker's environment.
// Shell parsing is best effort. It reads what bash would run for the commands
// workers write, follows cd, variables, subshells, substitutions and `sh -c`,
// and refuses what it cannot read rather than guess.
import { posix } from 'node:path'

const { basename, dirname } = posix

// ---- reasons: one sentence each, saying what to do instead

const R = {
  push: 'Night workers never push: commit on your branch and the owner pushes in the morning.',
  send: 'Night workers never send mail: write it in your result line and the owner sends it in the morning.',
  worktree: 'Night workers stay in the worktree night gave them: do not add, move, remove or prune worktrees.',
  stash: 'The stash is shared with every other worktree: commit your work on your night branch instead.',
  noVerify: 'Hooks guard every commit (the owner\'s secret scan among them): never skip them with --no-verify, fix what they refuse.',
  config: 'Night workers do not change git config: pass -c key=value to the one command that needs it.',
  alias: 'A git alias or a "!" config value can run any command: run the git command itself instead.',
  remote: 'Night workers do not change remotes: note what you need in DECISIONS.md for the owner.',
  filter: 'Rewriting history is not night work: note it in DECISIONS.md for the owner.',
  previous: 'Switching to the previous branch may land on a protected one: name your night branch instead.',
  gh: 'gh is read-only at night (view, list, status, diff, checks, search and GET api calls): '
    + 'write what should be posted in DECISIONS.md.',
  ghWeb: 'Nobody is awake to look at a browser: drop --web and read the output here.',
  publish: 'Night workers never publish packages: note the release in DECISIONS.md for the owner.',
  registry: 'Night workers do not touch registry accounts or tokens: note it in DECISIONS.md for the owner.',
  docker: 'Night workers do not push images or log in to registries: build locally and note the push for the owner.',
  systemctl: 'systemctl is limited to --user reads at night (status, show, list-units, list-timers, is-active, is-enabled, cat): '
    + 'leave services to night itself.',
  claude: 'Night workers do not start nested Claude sessions: do the work in this session.',
  dynamicCmd: 'The guard cannot read a command built at run time: write the command out plainly.',
  pipeShell: 'Piping text into a shell hides the commands from the guard: run them directly.',
  parse: 'The guard could not read this command (an unclosed quote, bracket or heredoc): write it more simply.',
  cwdUnknown: 'After a cd the guard cannot follow, relative paths are unknown: use absolute paths inside your worktree.',
  settings: 'Night workers do not change Claude Code settings: note the change in DECISIONS.md for the owner.',
  noCommand: 'The guard got no command to check: send the command as a string.',
  noPath: 'The guard got no file path to check: give an absolute path inside your worktree.',
  noTool: 'The guard got no tool name to check: retry the call.',
  rewrite: 'Heavy tests run one at a time across night workers: this command waits for the shared test lock.',
  mcp: 'Night workers run without MCP servers: do the work with the local tools.',
  shellAlias: 'Night workers do not define shell aliases: run the command itself.',
  gitInternal: 'Night workers change git state through git commands only: leave the .git entry of the worktree alone.',
}

const say = {
  deploy: (name) => `${name} reaches live services: night work stays local, so note the deploy in DECISIONS.md for the owner.`,
  cloud: (name) => `${name} talks to live cloud accounts: night work stays local, so note what is needed in DECISIONS.md.`,
  privilege: (name) =>
    `${name} runs as another user: night workers never raise privileges, so note what needs root in DECISIONS.md.`,
  machine: (name) => `${name} changes the machine itself: leave that to the owner and note it in DECISIONS.md.`,
  kill: (name) => `${name} can stop other sessions' processes: kill only your own process by its PID.`,
  remoteShell: (name) => `${name} reaches another machine: night work stays on this one, so note it in DECISIONS.md.`,
  mailer: (name) => `${name} sends mail: nobody is awake, so write it in your result line instead.`,
  opener: (name) => `${name} opens windows on a sleeping desktop: write the path or URL in your result line instead.`,
  protectedBranch: (name) => `Branch ${name} is protected: stay on your night branch (merging ${name} into it is fine).`,
  protectedEdit: (name) => `Branch ${name} is protected: leave it as it is and work on your night branch.`,
  gitOutside: (dir) =>
    `git here works on ${dir ?? 'a folder the guard cannot follow'}, outside your worktree: run git in your worktree only.`,
  outside: (path) => `${path} is outside your worktree: night workers write only in their worktree, their scratch folder and /tmp.`,
  unknownPath: (word) => `The guard cannot tell where ${word} points: write the path out, inside your worktree.`,
  secret: (path) => `${path} holds credentials: night workers never touch it, so work without it.`,
  search: (path) => `Searching ${path} would read credential files: search a narrower folder.`,
  bulk: (name, path) => `${name} over ${path} would carry credential files along: name a narrower folder.`,
  send: (host) =>
    `Sending data to ${host} is not allowed at night: only local servers may receive it, so note the request in DECISIONS.md.`,
  lockMix: (lock) =>
    `Tests take the night test lock by themselves: run the test command without flock on ${lock} and the guard wraps it.`,
}

// ---- tools

const TOOL_REASONS = new Map([
  ...['Artifact', 'ArtifactComments', 'ArtifactData'].map((t) => [t,
    'Night workers do not publish artifacts: night publishes the recap at dawn, so put what you made in your result line.']),
  ...['CronCreate', 'CronDelete', 'ScheduleWakeup'].map((t) => [t,
    'Night workers do not schedule anything: the night services decide what runs when, so finish your item now.']),
  ...['RemoteTrigger', 'Workflow'].map((t) => [t,
    'Night workers do not start other sessions or workflows: do the work in this session.']),
  ...['PushNotification', 'SendUserFile'].map((t) => [t,
    'Nobody is awake to receive it: put it in your result line and the morning recap carries it.']),
  ...['EnterWorktree', 'ExitWorktree'].map((t) => [t,
    'Stay in the worktree night gave you: it already has your own branch.']),
  ['AskUserQuestion', 'Nobody is awake to answer: take the most conservative option, write it in DECISIONS.md and keep going.'],
  ['ExitPlanMode', 'Nobody is awake to approve a plan: write it in DECISIONS.md and start on its most conservative step.'],
])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** Credential files and folders under home that no worker may touch. */
export const DEFAULT_SECRETS = [
  '.ssh', '.gnupg', '.aws', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.claude/.credentials.json', '.config/gh/hosts.yml', '.docker/config.json',
]

const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const SETTINGS_FILE = /\/\.claude\/settings[^/]*\.json$/

const allow = () => ({ decision: 'allow' })
const deny = (reason) => ({ decision: 'deny', reason })

/**
 * Judges one tool call. ctx: { worktree, scratch, home, protected, testLock,
 * secrets, cwd? } with absolute paths; cwd is the folder the hook reports, and
 * relative paths start there (the worktree when it is missing). Throws when
 * ctx.worktree is not an absolute path.
 */
export function decide(tool, input, ctx) {
  const env = prepare(ctx)
  const args = input && typeof input === 'object' ? input : {}
  if (typeof tool !== 'string' || tool === '') return deny(R.noTool)
  if (tool.startsWith('mcp__')) return deny(R.mcp)
  if (TOOL_REASONS.has(tool)) return deny(TOOL_REASONS.get(tool))
  if (WRITE_TOOLS.has(tool)) return judgeFileWrite(args, env)
  if (READ_TOOLS.has(tool)) return judgeFileRead(tool, args, env)
  if (tool === 'Bash') return judgeBash(args, env, true)
  if (tool === 'Monitor' && args.command !== undefined) return judgeBash(args, env, false)
  return allow()
}

function prepare(ctx) {
  if (typeof ctx?.worktree !== 'string' || !ctx.worktree.startsWith('/')) {
    throw new Error('the guard needs ctx.worktree as an absolute path')
  }
  const home = typeof ctx.home === 'string' && ctx.home.startsWith('/') ? posix.resolve(ctx.home) : null
  const abs = (p) => (typeof p === 'string' && p !== '' ? resolvePath(p, { base: '/', home }) : null)
  const worktree = posix.resolve(ctx.worktree)
  const names = ['main', 'master', ...(Array.isArray(ctx.protected) ? ctx.protected : [])]
    .filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim())
  const patterns = names.map((n) => new RegExp(`^${n.split('*').map(escapeRegExp).join('.*')}$`))
  return {
    worktree,
    scratch: abs(ctx.scratch),
    home,
    base: typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/') ? posix.resolve(ctx.cwd) : worktree,
    secrets: [
      ...(home ? DEFAULT_SECRETS.map((s) => `${home}/${s}`) : []),
      ...(Array.isArray(ctx.secrets) ? ctx.secrets : []).map(abs),
    ].filter(Boolean),
    testLock: abs(ctx.testLock),
    protect: (name) => patterns.some((rx) => rx.test(String(name).replace(/^(refs\/)?heads\//, ''))),
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- paths

/**
 * The absolute, normalised form of `path`: `~` and a leading `$HOME` become
 * `home`, `..` is followed, a relative path starts at `base`. Null when it is
 * relative and there is no base, or names home and there is no home.
 */
export function resolvePath(path, { base = null, home = null } = {}) {
  let p = String(path)
  const homeVar = /^\$(HOME|\{HOME\})(?=\/|$)/.exec(p)
  if (homeVar) {
    if (!home) return null
    p = home + p.slice(homeVar[0].length)
  } else if (p === '~' || p.startsWith('~/')) {
    if (!home) return null
    p = home + p.slice(1)
  } else if (p.startsWith('~')) {
    const slash = p.indexOf('/')
    const user = slash < 0 ? p.slice(1) : p.slice(1, slash)
    p = `${home ? dirname(home) : '/home'}/${user}${slash < 0 ? '' : p.slice(slash)}`
  }
  if (!p.startsWith('/')) {
    if (typeof base !== 'string' || !base.startsWith('/')) return null
    p = `${base}/${p}`
  }
  return posix.resolve(p)
}

const within = (p, root) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)
const under = (p, root) => p !== root && within(p, root)
const shown = (path, env) => (env.home && within(path, env.home) ? `~${path.slice(env.home.length)}` : path)

// path: that exact path. dir: everything in that folder. prefix: any path that
// starts with that text, so it must sit strictly inside a root.
function writable(abs, env, mode) {
  if (typeof abs !== 'string') return false
  const roots = [env.worktree, env.scratch].filter(Boolean)
  if (mode === 'prefix') return roots.some((r) => under(abs, r)) || under(abs, '/tmp')
  return roots.some((r) => within(abs, r)) || under(abs, '/tmp')
}

const secretAt = (abs, env) => env.secrets.find((s) => within(abs, s))
const gitInternal = (abs, env) => under(abs, env.worktree) && /\/\.git(\/|$)/.test(abs.slice(env.worktree.length))

// ---- file tools

function judgeFileWrite(input, env) {
  const raw = input.file_path ?? input.notebook_path
  if (typeof raw !== 'string' || raw === '') return deny(R.noPath)
  const abs = resolvePath(raw, { base: env.base, home: env.home })
  if (abs === null) return deny(say.outside(raw))
  const secret = secretAt(abs, env)
  if (secret) return deny(say.secret(shown(secret, env)))
  if (SETTINGS_FILE.test(abs)) return deny(R.settings)
  if (gitInternal(abs, env)) return deny(R.gitInternal)
  return writable(abs, env, 'path') ? allow() : deny(say.outside(shown(abs, env)))
}

function judgeFileRead(tool, input, env) {
  const raw = input.file_path ?? input.notebook_path ?? input.path
  const target = (typeof raw === 'string' && raw !== '' && resolvePath(raw, { base: env.base, home: env.home })) || env.base
  const secret = secretAt(target, env)
  if (secret) return deny(say.secret(shown(secret, env)))
  if (tool === 'Grep' && !within(target, env.worktree) && env.secrets.some((s) => under(s, target))) {
    return deny(say.search(shown(target, env)))
  }
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    const prefix = input.pattern.split(/[*?[{]/)[0]
    const abs = prefix && resolvePath(prefix, { base: target, home: env.home })
    const open = prefix !== input.pattern && !prefix.endsWith('/')
    const hit = abs && env.secrets.find((s) => within(abs, s) || (open && s.startsWith(abs)))
    if (hit) return deny(say.secret(shown(hit, env)))
  }
  return allow()
}

// ---- the shell parser

class ParseError extends Error {}

/**
 * The simple commands of a shell command line, depth first: each as its words
 * with quotes removed, a substitution's commands before the command that holds
 * it. Throws on an unclosed quote, bracket or heredoc.
 */
export function splitShell(command) {
  const out = []
  const visit = (items) => {
    for (const item of items) {
      if (item.type === 'group') { visit(item.items); continue }
      for (const sub of item.subs) visit(sub)
      out.push(item.words.map((w) => w.text))
    }
  }
  visit(parseScript(command))
  return out
}

const parseScript = (src) => parseSeq({ s: String(src), i: 0 }, false)

// A list of items: { type: 'cmd', words, redirects, subs, pipeIn, heredoc } or
// { type: 'group', items } for a ( ) subshell. Inside $( ) it stops at the ).
function parseSeq(p, inParen) {
  const { s } = p
  const items = []
  const heredocs = []
  let cmd = null
  let piped = false
  const current = () => (cmd ??= { type: 'cmd', words: [], redirects: [], subs: [], pipeIn: piped, heredoc: false })
  const finish = (pipe) => {
    if (cmd) items.push(cmd)
    cmd = null
    piped = pipe
  }
  while (p.i < s.length) {
    const c = s[p.i]
    if (c === ' ' || c === '\t' || c === '\r') { p.i++; continue }
    if (c === '\\' && s[p.i + 1] === '\n') { p.i += 2; continue }
    if (c === '\n') {
      finish(false)
      p.i++
      if (heredocs.length) skipHeredocs(p, heredocs.splice(0))
      continue
    }
    if (c === '#') {
      while (p.i < s.length && s[p.i] !== '\n') p.i++
      continue
    }
    if (c === ';') {
      finish(false)
      p.i += s[p.i + 1] === ';' ? 2 : 1
      if (s[p.i] === '&') p.i++
      continue
    }
    if (c === '|') {
      if (s[p.i + 1] === '|') { finish(false); p.i += 2; continue }
      finish(true)
      p.i += s[p.i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (s[p.i + 1] === '&') { finish(false); p.i += 2; continue }
      if (s[p.i + 1] === '>') { readRedirect(p, current(), '', heredocs); continue }
      finish(false)
      p.i++
      continue
    }
    if (c === '(') {
      finish(false)
      if (s[p.i + 1] === '(') { p.i = skipArithmetic(s, p.i + 2); continue }
      p.i++
      items.push({ type: 'group', items: parseSeq(p, true) })
      continue
    }
    if (c === ')') {
      finish(false)
      p.i++
      if (inParen) return items
      continue // a case pattern's ), or a stray one
    }
    if ((c === '<' || c === '>') && s[p.i + 1] === '(') {
      const w = newWord()
      const start = p.i
      p.i += 2
      w.subs.push(parseSeq(p, true))
      part(w, { k: 'sub', v: s.slice(start, p.i) })
      const word = endWord(w)
      current().words.push(word)
      current().subs.push(...word.subs)
      continue
    }
    if (c === '<' || c === '>') { readRedirect(p, current(), '', heredocs); continue }
    const word = readWord(p)
    if (/^\d+$/.test(word.text) && word.parts.length === 1 && (s[p.i] === '<' || s[p.i] === '>')) {
      readRedirect(p, current(), word.text, heredocs)
      continue
    }
    current().words.push(word)
    current().subs.push(...word.subs)
  }
  if (inParen) throw new ParseError('unclosed (')
  finish(false)
  return items
}

function skipArithmetic(s, i) {
  let depth = 2
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') depth++
    else if (s[j] === ')' && --depth === 0) return j + 1
  }
  throw new ParseError('unclosed ((')
}

function skipHeredocs(p, docs) {
  const { s } = p
  for (const doc of docs) {
    for (;;) {
      if (p.i >= s.length) throw new ParseError('unclosed heredoc')
      let end = s.indexOf('\n', p.i)
      if (end < 0) end = s.length
      let line = s.slice(p.i, end)
      p.i = Math.min(end + 1, s.length)
      if (doc.strip) line = line.replace(/^\t+/, '')
      if (line === doc.delim) break
    }
  }
}

function readRedirect(p, cmd, fd, heredocs) {
  const { s } = p
  const op = /^(&>>|&>|<<<|<<-|<<|<>|<&|>>|>\||>&|<|>)/.exec(s.slice(p.i, p.i + 3))[1]
  p.i += op.length
  while (s[p.i] === ' ' || s[p.i] === '\t') p.i++
  if (p.i >= s.length || /[\n;&|()<>]/.test(s[p.i])) throw new ParseError('a redirect without a target')
  const word = readWord(p)
  if (op === '<<' || op === '<<-') {
    cmd.heredoc = true
    heredocs.push({ delim: word.text, strip: op === '<<-' })
    return
  }
  cmd.redirects.push({ op: fd + op, word })
  cmd.subs.push(...word.subs)
}

// A word is parts: lit (quoted or plain text), glob (* ? [), brace ({ , }),
// var ($x, ${x...}, $((...))) and sub ($( ), backticks, <( )). Its text is
// the parts joined, quotes removed, expansions as written.
const newWord = () => ({ parts: [], subs: [], buf: '' })
const lit = (w, text) => { w.buf += text }
function part(w, piece) {
  if (w.buf) { w.parts.push({ k: 'lit', v: w.buf }); w.buf = '' }
  w.parts.push(piece)
}
function endWord(w) {
  if (w.buf) { w.parts.push({ k: 'lit', v: w.buf }); w.buf = '' }
  return { parts: w.parts, subs: w.subs, text: w.parts.map((x) => x.v).join('') }
}

function readWord(p) {
  const { s } = p
  const w = newWord()
  while (p.i < s.length) {
    const c = s[p.i]
    if (' \t\r\n;&|<>)'.includes(c)) break
    if (c === '(') {
      // name=(a b): an array assignment keeps its parentheses
      if (w.parts.length === 0 && /^[A-Za-z_]\w*\+?=$/.test(w.buf)) {
        const close = s.indexOf(')', p.i)
        if (close < 0) throw new ParseError('unclosed (')
        lit(w, s.slice(p.i, close + 1))
        p.i = close + 1
        continue
      }
      break
    }
    if (c === "'") {
      const close = s.indexOf("'", p.i + 1)
      if (close < 0) throw new ParseError('unclosed quote')
      lit(w, s.slice(p.i + 1, close))
      p.i = close + 1
      continue
    }
    if (c === '"') { readDouble(p, w); continue }
    if (c === '\\') {
      if (s[p.i + 1] !== '\n' && p.i + 1 < s.length) lit(w, s[p.i + 1])
      p.i += 2
      continue
    }
    if (c === '$') { readDollar(p, w, false); continue }
    if (c === '`') { readBacktick(p, w); continue }
    if (c === '*' || c === '?' || c === '[') { part(w, { k: 'glob', v: c }); p.i++; continue }
    if (c === '{' || c === ',' || c === '}') { part(w, { k: 'brace', v: c }); p.i++; continue }
    lit(w, c)
    p.i++
  }
  return endWord(w)
}

function readDouble(p, w) {
  const { s } = p
  p.i++
  while (p.i < s.length) {
    const c = s[p.i]
    if (c === '"') { p.i++; return }
    if (c === '\\') {
      const n = s[p.i + 1]
      if (n === '\n') { p.i += 2; continue }
      if (n === '$' || n === '`' || n === '"' || n === '\\') { lit(w, n); p.i += 2; continue }
      lit(w, '\\')
      p.i++
      continue
    }
    if (c === '$') { readDollar(p, w, true); continue }
    if (c === '`') { readBacktick(p, w); continue }
    lit(w, c)
    p.i++
  }
  throw new ParseError('unclosed double quote')
}

const ANSI = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
}

function readDollar(p, w, quoted) {
  const { s } = p
  const start = p.i
  const n = s[p.i + 1]
  if (n === '(') {
    if (s[p.i + 2] === '(') {
      p.i = skipArithmetic(s, p.i + 3)
      part(w, { k: 'var', name: '', op: '', v: s.slice(start, p.i) })
      return
    }
    p.i += 2
    w.subs.push(parseSeq(p, true))
    part(w, { k: 'sub', v: s.slice(start, p.i) })
    return
  }
  if (n === '{') {
    p.i += 2
    readParameter(p, w)
    const raw = s.slice(start, p.i)
    const m = /^\$\{([A-Za-z_]\w*)([\s\S]*)\}$/.exec(raw)
    part(w, { k: 'var', name: m ? m[1] : '', op: m ? m[2] : '?', v: raw })
    return
  }
  if (!quoted && n === "'") {
    p.i += 2
    let out = ''
    while (p.i < s.length && s[p.i] !== "'") {
      if (s[p.i] !== '\\' || p.i + 1 >= s.length) { out += s[p.i++]; continue }
      const e = s[p.i + 1]
      const hex = /^x([0-9A-Fa-f]{1,2})/.exec(s.slice(p.i + 1, p.i + 4))
      const oct = /^[0-7]{1,3}/.exec(s.slice(p.i + 1, p.i + 4))
      if (Object.hasOwn(ANSI, e)) { out += ANSI[e]; p.i += 2 }
      else if (hex) { out += String.fromCharCode(parseInt(hex[1], 16)); p.i += 1 + hex[0].length }
      else if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); p.i += 1 + oct[0].length }
      else { out += `\\${e}`; p.i += 2 }
    }
    if (p.i >= s.length) throw new ParseError('unclosed quote')
    p.i++
    lit(w, out)
    return
  }
  if (!quoted && n === '"') { p.i++; return } // $"..." reads as "..."
  if (n !== undefined && /[A-Za-z_]/.test(n)) {
    let j = p.i + 1
    while (j < s.length && /\w/.test(s[j])) j++
    part(w, { k: 'var', name: s.slice(p.i + 1, j), op: '', v: s.slice(start, j) })
    p.i = j
    return
  }
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
    part(w, { k: 'var', name: '', op: '', v: s.slice(start, start + 2) })
    p.i += 2
    return
  }
  lit(w, '$')
  p.i++
}

// ${...}: read to its }, opening any $( ) inside it.
function readParameter(p, w) {
  const { s } = p
  let depth = 1
  while (p.i < s.length) {
    const c = s[p.i]
    if (c === '\\') { p.i += 2; continue }
    if (c === "'") {
      const close = s.indexOf("'", p.i + 1)
      if (close < 0) throw new ParseError('unclosed quote')
      p.i = close + 1
      continue
    }
    if (c === '$' && s[p.i + 1] === '(' && s[p.i + 2] !== '(') {
      p.i += 2
      w.subs.push(parseSeq(p, true))
      continue
    }
    if (c === '$' && s[p.i + 1] === '{') { depth++; p.i += 2; continue }
    if (c === '}' && --depth === 0) { p.i++; return }
    p.i++
  }
  throw new ParseError('unclosed ${')
}

function readBacktick(p, w) {
  const { s } = p
  const start = p.i
  p.i++
  let inner = ''
  while (p.i < s.length && s[p.i] !== '`') {
    if (s[p.i] === '\\' && p.i + 1 < s.length && '$`\\'.includes(s[p.i + 1])) {
      inner += s[p.i + 1]
      p.i += 2
      continue
    }
    inner += s[p.i++]
  }
  if (p.i >= s.length) throw new ParseError('unclosed backquote')
  p.i++
  w.subs.push(parseScript(inner))
  part(w, { k: 'sub', v: s.slice(start, p.i) })
}

// ---- words as paths

const UNKNOWN = Object.freeze({ text: '', exact: false })

function varValue(name, st, env) {
  if (st.vars.has(name)) return st.vars.get(name)
  if (name === 'HOME') return env.home ? { text: env.home, exact: true } : null
  if (name === 'TMPDIR') return { text: '/tmp', exact: true }
  if (name === 'PWD') return st.cwd ? { text: st.cwd, exact: true } : null
  if (name === 'OLDPWD') return st.oldpwd ? { text: st.oldpwd, exact: true } : null
  return null
}

// The word's text up to its first part the guard cannot know (a glob, an
// unknown variable, a substitution), with known variables filled in.
function literal(word, st, env) {
  let text = ''
  for (const x of word.parts) {
    if (x.k === 'lit' || x.k === 'brace') { text += x.v; continue }
    if (x.k === 'var' && x.name && (x.op === '' || /^%/.test(x.op))) {
      const value = varValue(x.name, st, env)
      if (value) {
        text += value.text
        if (!value.exact || x.op) return { text, exact: false, kind: 'var' }
        continue
      }
    }
    return { text, exact: false, kind: x.k }
  }
  return { text, exact: true, kind: null }
}

// The word once per alternative of its unquoted {a,b} lists (at most 64).
function variants(word) {
  const { parts } = word
  const open = parts.findIndex((x) => x.k === 'brace' && x.v === '{')
  if (open < 0) return [word]
  let depth = 0
  let close = -1
  const commas = []
  for (let k = open; k < parts.length && close < 0; k++) {
    const x = parts[k]
    if (x.k !== 'brace') continue
    if (x.v === '{') depth++
    else if (x.v === '}' && --depth === 0) close = k
    else if (x.v === ',' && depth === 1) commas.push(k)
  }
  if (close < 0 || commas.length === 0) {
    return variants({ ...word, parts: parts.map((x, k) => (k === open ? { k: 'lit', v: x.v } : x)) })
  }
  const cuts = [open, ...commas, close]
  const out = []
  for (let k = 0; k + 1 < cuts.length && out.length < 64; k++) {
    const alt = [...parts.slice(0, open), ...parts.slice(cuts[k] + 1, cuts[k + 1]), ...parts.slice(close + 1)]
    out.push(...variants({ ...word, parts: alt }))
  }
  return out.slice(0, 64)
}

// The value of name=value or --flag=value, as a word, when the = is plain text.
function valueAfterEq(word) {
  const k = word.parts.findIndex((x) => x.k === 'lit' && x.v.includes('='))
  if (k < 0 || word.parts.slice(0, k).some((x) => x.k !== 'lit' && x.k !== 'brace')) return null
  const head = word.parts[k].v
  const rest = head.slice(head.indexOf('=') + 1)
  const parts = [...(rest ? [{ k: 'lit', v: rest }] : []), ...word.parts.slice(k + 1)]
  return { parts, subs: word.subs, text: parts.map((x) => x.v).join('') }
}

const plainWord = (text) => ({ parts: [{ k: 'lit', v: text }], subs: [], text })

function writeReason(word, st, env) {
  for (const one of variants(word)) {
    const reason = writeReasonOne(one, st, env)
    if (reason) return reason
  }
  return null
}

function writeReasonOne(word, st, env) {
  const { text, exact, kind } = literal(word, st, env)
  if (exact && SINKS.has(text)) return null
  if (!exact && text === '' && kind !== 'glob') return say.unknownPath(word.text)
  const abs = resolvePath(text === '' ? '.' : text, { base: st.cwd, home: env.home })
  if (abs === null) return R.cwdUnknown
  const secret = secretAt(abs, env)
  if (secret) return say.secret(shown(secret, env))
  if (exact ? SETTINGS_FILE.test(abs) : /\/\.claude(\/settings[^/]*)?$/.test(abs)) return R.settings
  if (gitInternal(abs, env)) return R.gitInternal
  const mode = exact ? 'path' : text === '' || text.endsWith('/') ? 'dir' : 'prefix'
  return writable(abs, env, mode) ? null : say.outside(exact ? shown(abs, env) : word.text)
}

// A secret this word names: as a path, as the value after an =, or written
// anywhere inside it.
function secretIn(word, st, env) {
  for (const one of variants(word)) {
    const { text, exact } = literal(one, st, env)
    const after = text.indexOf('=')
    for (const cand of after >= 0 ? [text, text.slice(after + 1)] : [text]) {
      if (!cand) continue
      const abs = resolvePath(cand, { base: st.cwd, home: env.home })
      if (!abs) continue
      const open = !exact && cand === text && !text.endsWith('/')
      const hit = env.secrets.find((s) => within(abs, s) || (open && s.startsWith(abs)))
      if (hit) return hit
    }
  }
  if (!env.home) return null
  const raw = word.text.replace(/\$\{HOME\}|\$HOME\b/g, env.home).replaceAll('~/', `${env.home}/`)
  return env.secrets.find((s) => mentions(raw, s)) ?? null
}

function mentions(text, path) {
  for (let k = text.indexOf(path); k >= 0; k = text.indexOf(path, k + 1)) {
    const next = text[k + path.length]
    if (next === undefined || !/[\w.-]/.test(next)) return true
  }
  return false
}

// ---- Bash

function judgeBash(input, env, rewrite) {
  const { command } = input
  if (typeof command !== 'string' || command.trim() === '') return deny(R.noCommand)
  const st = { cwd: env.base, oldpwd: env.base, dirs: [], vars: new Map(), locked: false, depth: 0 }
  const out = { reason: null, test: false, ownLock: false }
  runCode(command, st, env, out)
  if (out.reason) return deny(out.reason)
  if (!rewrite || !out.test || !env.testLock) return allow()
  if (out.ownLock) return deny(say.lockMix(env.testLock))
  const quoted = /^[\w./-]+$/.test(env.testLock) ? env.testLock : `'${env.testLock.replaceAll("'", "'\\''")}'`
  return {
    decision: 'rewrite',
    input: { ...input, command: `flock ${quoted} sh -c '${command.replaceAll("'", "'\\''")}'` },
    reason: R.rewrite,
  }
}

const clone = (st) => ({ ...st, vars: new Map(st.vars), dirs: [...st.dirs] })
const fail = (out, reason) => { out.reason ??= reason }

function runCode(code, st, env, out) {
  if (st.depth > 12) return fail(out, R.parse)
  let items
  try {
    items = parseScript(code)
  } catch (err) {
    if (err instanceof ParseError) return fail(out, R.parse)
    throw err
  }
  walk(items, { ...clone(st), depth: st.depth + 1 }, env, out)
}

function walk(items, st, env, out) {
  for (const item of items) {
    if (out.reason) return
    if (item.type === 'group') walk(item.items, clone(st), env, out)
    else judgeCommand(item, st, env, out)
  }
}

function judgeCommand(cmd, st, env, out) {
  for (const sub of cmd.subs) {
    walk(sub, clone(st), env, out)
    if (out.reason) return
  }
  for (const word of [...cmd.words, ...cmd.redirects.map((r) => r.word)]) {
    const secret = secretIn(word, st, env)
    if (secret) return fail(out, say.secret(shown(secret, env)))
  }
  for (const { op, word } of cmd.redirects) {
    if (!op.includes('>')) continue
    if (op.endsWith('&') && /^(\d+|-)$/.test(word.text)) continue
    const reason = writeReason(word, st, env)
    if (reason) return fail(out, reason)
  }
  const stdin = cmd.heredoc || cmd.redirects.some((r) => /^\d*<(?!&|>)/.test(r.op))
  judgeWords(cmd.words, st, env, out, { pipeIn: cmd.pipeIn, stdin })
}

// Leading words that are not the command: reserved words and wrappers whose own
// options come first. [options that take a value, words after the options].
const RESERVED = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done', 'esac'])
const WRAPPERS = new Map([
  ['builtin', [[], 0]],
  ['exec', [['-a'], 0]],
  ['nohup', [[], 0]],
  ['setsid', [[], 0]],
  ['time', [['-f', '--format', '-o', '--output'], 0]],
  ['timeout', [['-s', '--signal', '-k', '--kill-after'], 1]],
  ['nice', [['-n', '--adjustment'], 0]],
  ['xargs', [['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs',
    '--max-chars', '--max-lines', '--process-slot-var'], 0]],
  ['stdbuf', [['-i', '-o', '-e', '--input', '--output', '--error'], 0]],
  ['ionice', [['-c', '-n', '--class', '--classdata'], 0]],
])
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx'])
const RUNNER_VERBS = {
  npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'], uv: ['run'], poetry: ['run'], pipx: ['run'],
}
const RUNNER_VALUES = new Set(['-p', '--package', '--with', '--python', '--directory', '--project', '--from', '--extra', '--group',
  '--spec', '-w', '--workspace'])
const FLOCK_VALUES = new Set(['-w', '--timeout', '--wait', '-E', '--conflict-exit-code'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
// Commands that read whole folders: given home, they carry ~/.ssh along.
const BULK_READERS = new Set(['cp', 'rsync', 'tar', 'zip', '7z', 'grep', 'egrep', 'rg', 'ag'])
const TAR_VALUES = new Set(['-C', '--directory', '-f', '--file', '-T', '--files-from', '-X', '--exclude-from'])
const PACKAGE_BINS = { 'netlify-cli': 'netlify', 'firebase-tools': 'firebase', 'claude-code': 'claude' }

const isAssignment = (word) => word.parts[0]?.k === 'lit' && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(word.parts[0].v)

// The word with known variables filled into its text, and whether any part of
// it stays unknown until run time.
function expand(word, st, env) {
  let text = ''
  let dynamic = false
  for (const x of word.parts) {
    if (x.k === 'var' && x.name && !x.op) {
      const value = varValue(x.name, st, env)
      if (value?.exact) { text += value.text; continue }
    }
    if (x.k === 'var' || x.k === 'sub') dynamic = true
    text += x.v
  }
  return { ...word, text, dynamic }
}

// Judges one simple command given as words; returns the command's name.
function judgeWords(words, st, env, out, io = {}) {
  const argv = words.map((w) => expand(w, st, env))
  let i = 0
  while (i < argv.length && isAssignment(argv[i])) i++
  if (i === argv.length) {
    for (const w of argv) setVar(st, w, env)
    return null
  }
  const local = { ...st, vars: new Map(st.vars) }
  for (const w of argv.slice(0, i)) setVar(local, w, env)
  let runner = false
  for (;;) {
    if (i >= argv.length) return null
    const t = argv[i].text
    const n = basename(t)
    if (RESERVED.has(t)) { i++; continue }
    if (t === 'for' || t === 'select') { loopVar(argv.slice(i + 1), st, env); return null }
    if (t === 'case' || t === 'function') return null
    if (n === 'command') {
      i++
      while (argv[i]?.text.startsWith('-')) {
        if (/^-[pvV]*[vV]/.test(argv[i].text)) return null // command -v only looks the name up
        i++
      }
      continue
    }
    if (n === 'env') {
      i++
      while (i < argv.length) {
        const o = argv[i].text
        if (o === '--') { i++; break }
        if (o === '-u' || o === '--unset') { i += 2; continue }
        if (o === '-C' || o === '--chdir' || o.startsWith('--chdir=')) {
          const dir = o.startsWith('--chdir=') ? valueAfterEq(argv[i]) : argv[i + 1]
          const { text, exact } = dir ? literal(dir, local, env) : UNKNOWN
          local.cwd = exact ? resolvePath(text, { base: local.cwd, home: env.home }) : null
          i += o.startsWith('--chdir=') ? 1 : 2
          continue
        }
        if (o === '-S' || o === '--split-string') {
          runCode(argv.slice(i + 1).map((w) => w.text).join(' '), local, env, out)
          return null
        }
        if (isAssignment(argv[i])) setVar(local, argv[i], env)
        if (o.startsWith('-') || isAssignment(argv[i])) { i++; continue }
        break
      }
      continue
    }
    if (n === 'flock') {
      i++
      while (i < argv.length && argv[i].text.startsWith('-') && !['-c', '--command'].includes(argv[i].text)) {
        i += FLOCK_VALUES.has(argv[i].text) ? 2 : 1
      }
      const lock = argv[i]
      if (!lock) return null
      const { text, exact } = literal(lock, local, env)
      if (exact && resolvePath(text, { base: local.cwd, home: env.home }) === env.testLock) out.ownLock = true
      local.locked = true
      i++
      if (argv[i]?.text === '-c' || argv[i]?.text === '--command') {
        if (argv[i + 1]) runCode(argv[i + 1].text, local, env, out)
        return null
      }
      continue
    }
    if (WRAPPERS.has(n)) {
      const [values, positional] = WRAPPERS.get(n)
      i++
      while (i < argv.length && argv[i].text.startsWith('-') && argv[i].text !== '-') {
        if (argv[i].text === '--') { i++; break }
        i += values.includes(argv[i].text) ? 2 : 1
      }
      i += positional
      continue
    }
    if (RUNNERS.has(n) || RUNNER_VERBS[n]?.includes(argv[i + 1]?.text)) {
      i += RUNNERS.has(n) ? 1 : 2
      while (i < argv.length && argv[i].text.startsWith('-') && argv[i].text !== '-') {
        const o = argv[i].text
        if (o === '--') { i++; break }
        if (o === '-c' || o === '--call') {
          if (argv[i + 1]) runCode(argv[i + 1].text, local, env, out)
          return null
        }
        i += RUNNER_VALUES.has(o) ? 2 : 1
      }
      runner = true
      continue
    }
    break
  }
  const word = argv[i]
  if (word.dynamic) {
    fail(out, R.dynamicCmd)
    return null
  }
  const name = runner ? binOf(word.text) : basename(word.text)
  const args = argv.slice(i + 1)
  const reason = ruleFor(name, args, local, st, env, out, io)
  if (reason) fail(out, reason)
  else if (!local.locked && isTestRun(name, word, args)) out.test = true
  return name
}

function binOf(spec) {
  let name = spec.replace(/(.)@[^/]*$/, '$1')
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  if (scoped) name = ['cli', 'test'].includes(scoped[2]) ? scoped[1] : scoped[2]
  return PACKAGE_BINS[name] ?? basename(name)
}

// The words that are not options, skipping the values of options in `values`.
// After `--` everything is an operand, unless `stop` asks to end there.
function operands(args, values = new Set(), stop = false) {
  const out = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text
    if (t === '--') {
      if (!stop) out.push(...args.slice(k + 1))
      break
    }
    if (t.startsWith('-') && t !== '-') {
      if (values.has(t)) k++
      continue
    }
    out.push(args[k])
  }
  return out
}

const firstOperand = (args, values) => operands(args, values)[0]?.text

function optionValues(args, names) {
  const out = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text
    if (names.includes(t) && args[k + 1]) out.push(args[++k])
    else if (names.some((o) => o.startsWith('--') && t.startsWith(`${o}=`))) out.push(valueAfterEq(args[k]))
  }
  return out.filter(Boolean)
}

function setVar(st, word, env) {
  const m = /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?)=/.exec(word.parts[0].v)
  if (m[2] || m[3]) { st.vars.set(m[1], UNKNOWN); return }
  const value = valueAfterEq(word)
  const sub = value.parts.length === 1 && value.parts[0].k === 'sub' && value.subs.length === 1
  st.vars.set(m[1], (sub && mktempValue(value.subs[0], st, env)) || literal(value, st, env))
}

// x=$(mktemp ...) names a new entry inside the temp folder (or the -p folder).
function mktempValue(items, st, env) {
  const words = items.length === 1 && items[0].type === 'cmd' ? items[0].words : []
  if (basename(words[0]?.text ?? '') !== 'mktemp') return null
  let dir = '/tmp'
  for (let k = 1; k < words.length; k++) {
    const t = words[k].text
    if (t === '-p') dir = words[++k]?.text ?? dir
    else if (t.startsWith('--tmpdir=')) dir = t.slice(9)
    else if (!t.startsWith('-') && t.includes('/')) dir = dirname(t)
  }
  const abs = resolvePath(dir, { base: st.cwd, home: env.home })
  return abs ? { text: `${abs}/tmp.`, exact: false } : UNKNOWN
}

// for name in words: the loop variable takes the word a write would object to
// first, else the first word, so a later rm "$name" is judged by it.
function loopVar(args, st, env) {
  const name = args[0]?.text
  if (!name || !/^[A-Za-z_]\w*$/.test(name)) return
  const list = args[1]?.text === 'in' ? args.slice(2) : []
  if (list.length === 0) { st.vars.set(name, UNKNOWN); return }
  const all = list.flatMap(variants)
  const pick = all.find((w) => writeReasonOne(w, st, env)) ?? all[0]
  st.vars.set(name, literal(pick, st, env))
}

function changeDir(name, args, st, env) {
  if (name === 'popd') {
    st.oldpwd = st.cwd
    st.cwd = st.dirs.length ? st.dirs.pop() : null
    return
  }
  const target = args.find((w) => !/^-[LPe@]+$/.test(w.text) && w.text !== '--')
  let next
  if (!target) next = name === 'cd' ? env.home : null
  else if (target.text === '-') next = st.oldpwd
  else if (/^[+-]\d+$/.test(target.text)) next = null
  else {
    const { text, exact } = literal(target, st, env)
    next = exact ? resolvePath(text, { base: st.cwd, home: env.home }) : null
  }
  if (name === 'pushd') st.dirs.push(st.cwd)
  st.oldpwd = st.cwd
  st.cwd = next
}

function ruleFor(name, args, local, st, env, out, io) {
  switch (name) {
    case 'git': return gitRule(args, local, env)
    case 'gh': return ghRule(args)
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return packageRule(name, args)
    case 'vercel': case 'heroku': return say.deploy(name)
    case 'netlify': return firstOperand(args) === 'dev' ? null : say.deploy(name)
    case 'firebase': {
      const op = firstOperand(args) ?? ''
      return op === 'deploy' || op.endsWith(':deploy') ? say.deploy(name) : null
    }
    case 'fly': case 'flyctl': return ['deploy', 'secrets'].includes(firstOperand(args)) ? say.deploy(name) : null
    case 'wrangler': return wranglerRule(args)
    case 'supabase': return supabaseRule(args)
    case 'docker': case 'podman': return dockerRule(args)
    case 'stripe': case 'aws': case 'gcloud': case 'gsutil': case 'az': return say.cloud(name)
    case 'sudo': case 'su': case 'doas': case 'pkexec': case 'run0': return say.privilege(name)
    case 'systemctl': return systemctlRule(args)
    case 'systemd-run': case 'loginctl': case 'shutdown': case 'reboot': case 'poweroff': case 'halt':
    case 'crontab': case 'at': return say.machine(name)
    case 'pkill': case 'killall': return say.kill(name)
    case 'claude': return R.claude
    case 'ssh': case 'scp': case 'sftp': case 'mosh': case 'sshpass': return say.remoteShell(name)
    case 'rsync': return rsyncRule(args, local, env)
    case 'mail': case 'mailx': case 'sendmail': case 'mutt': case 'neomutt': case 'msmtp': case 'swaks':
      return say.mailer(name)
    case 'xdg-open': case 'open': case 'kde-open': case 'kde-open5': case 'gnome-open': return say.opener(name)
    case 'gio': return firstOperand(args) === 'open' ? say.opener('gio open') : null
    case 'curl': return curlRule(args, local, env)
    case 'wget': return wgetRule(args, local, env)
    case 'eval': runCode(args.map((a) => a.text).join(' '), local, env, out); return null
    case 'trap': {
      const code = args[0]?.text
      if (code && !code.startsWith('-')) runCode(code, local, env, out)
      return null
    }
    case 'find': return findRule(args, local, env, out)
    case 'cd': case 'pushd': case 'popd': changeDir(name, args, st, env); return null
    case 'export': case 'local': case 'declare': case 'typeset': case 'readonly':
      for (const a of args) if (isAssignment(a)) setVar(st, a, env)
      return null
    case 'unset': for (const a of args) st.vars.delete(a.text); return null
    case 'alias': return args.some((a) => a.text.includes('=')) ? R.shellAlias : null
    case 'read':
      for (const a of operands(args, new Set(['-a', '-d', '-i', '-n', '-N', '-p', '-t', '-u']))) st.vars.set(a.text, UNKNOWN)
      return null
  }
  if (SHELLS.has(name)) {
    const shell = shellArgs(args)
    if (shell.code) runCode(shell.code.text, local, env, out)
    else if ((shell.stdin || !shell.script) && (io.pipeIn || io.stdin)) return R.pipeShell
    return null
  }
  if (BULK_READERS.has(name)) {
    // tar reads its operands from inside -C when one is given
    const into = name === 'tar' ? optionValues(args, ['-C', '--directory'])[0] : null
    const { text: dir, exact: known } = into ? literal(into, local, env) : { text: '.', exact: true }
    const base = known ? resolvePath(dir, { base: local.cwd, home: env.home }) : null
    for (const a of operands(args, name === 'tar' ? TAR_VALUES : undefined)) {
      const { text, exact } = literal(a, local, env)
      const abs = exact && text ? resolvePath(text, { base, home: env.home }) : null
      if (abs && !within(abs, env.worktree) && env.secrets.some((s) => under(s, abs))) return say.bulk(name, shown(abs, env))
    }
  }
  return writeRule(name, args, local, env, out)
}

// ---- git, gh and package managers

const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix',
  '--attr-source'])
const CREATE_FLAGS = new Set(['-b', '-B', '--orphan', '-c', '-C', '--create', '--force-create'])
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l',
  '--show-origin', '--show-scope'])
const CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit',
  '-e'])
const CONFIG_VALUES = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])
const CLONE_VALUES = new Set(['-b', '--branch', '-o', '--origin', '--depth', '-c', '--config', '--reference', '--reference-if-able',
  '--separate-git-dir', '-u', '--upload-pack', '--template', '-j', '--jobs', '--filter', '--shallow-since', '--shallow-exclude',
  '--server-option', '--bundle-uri', '--initial-branch', '--object-format', '--ref-format'])

function gitRule(args, local, env) {
  let dir = local.cwd
  const places = []
  let k = 0
  for (; k < args.length; k++) {
    const a = args[k]
    const t = a.text
    if (t === '-C') {
      const w = args[++k]
      const { text, exact } = w ? literal(w, local, env) : UNKNOWN
      dir = exact ? resolvePath(text, { base: dir, home: env.home }) : null
      continue
    }
    if (t === '-c' || t === '--config-env' || t.startsWith('--config-env=')) {
      const value = t.startsWith('--config-env=') ? t.slice(13) : args[++k]?.text ?? ''
      if (/^alias\./i.test(value) || /=\s*!/.test(value)) return R.alias
      continue
    }
    if (t === '--git-dir' || t === '--work-tree') { if (args[k + 1]) places.push(args[++k]); continue }
    if (/^--(git-dir|work-tree)=/.test(t)) { places.push(valueAfterEq(a)); continue }
    if (GIT_VALUES.has(t)) { k++; continue }
    if (t.startsWith('-')) continue
    break
  }
  const sub = args[k]
  if (!sub) return null
  if (sub.dynamic) return R.dynamicCmd
  if (args.slice(k + 1).some((a) => a.text === '--no-verify' || (sub.text === 'commit' && a.text === '-n'))) return R.noVerify
  if (!writable(dir, env, 'path')) return say.gitOutside(dir && shown(dir, env))
  for (const [key, value] of local.vars) {
    if (/^GIT_CONFIG_(PARAMETERS|KEY_\d+)$/.test(key) && /alias\./i.test(value.text)) return R.alias
  }
  const located = [
    ...places.map((w) => (w ? literal(w, local, env) : UNKNOWN)),
    ...['GIT_DIR', 'GIT_WORK_TREE'].filter((key) => local.vars.has(key)).map((key) => local.vars.get(key)),
  ]
  for (const { text, exact } of located) {
    const abs = exact ? resolvePath(text, { base: dir, home: env.home }) : null
    if (!writable(abs, env, 'path')) return say.gitOutside(abs && shown(abs, env))
  }
  const rest = args.slice(k + 1)
  switch (sub.text) {
    case 'push': case 'send-pack': case 'http-push': return R.push
    case 'send-email': return R.send
    case 'checkout': case 'switch': return checkoutRule(sub.text, rest, env)
    case 'branch': return branchRule(rest, env)
    case 'update-ref': case 'symbolic-ref': {
      const hit = rest.map((a) => /^refs\/heads\/(.+)$/.exec(a.text)?.[1]).find((b) => b && env.protect(b))
      return hit ? say.protectedEdit(hit) : null
    }
    case 'worktree': return ['add', 'remove', 'move', 'prune'].includes(firstOperand(rest)) ? R.worktree : null
    case 'stash': return ['list', 'show'].includes(rest[0]?.text) ? null : R.stash
    case 'config': return configWrites(rest) ? R.config : null
    case 'remote': return [undefined, 'show', 'get-url'].includes(firstOperand(rest)) ? null : R.remote
    case 'filter-branch': case 'filter-repo': return R.filter
    case 'clone': case 'init': {
      const ops = operands(rest, CLONE_VALUES)
      const targets = [sub.text === 'clone' ? ops[1] : ops[0], ...optionValues(rest, ['--separate-git-dir'])]
      for (const w of targets.filter(Boolean)) {
        const reason = writeReason(w, { ...local, cwd: dir }, env)
        if (reason) return reason
      }
      return null
    }
  }
  return null
}

function checkoutRule(sub, rest, env) {
  const refs = []
  const paths = []
  let dashdash = false
  let created = false
  let track = false
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].text
    if (dashdash) { paths.push(t); continue }
    if (t === '--') { dashdash = true; continue }
    const eq = /^--(orphan|create|force-create)=(.+)$/.exec(t)
    if (CREATE_FLAGS.has(t) || eq) {
      const name = eq ? eq[2] : rest[++k]?.text
      if (name && env.protect(name)) return say.protectedBranch(name)
      created = true
      continue
    }
    if (t === '--detach' || (sub === 'switch' && t === '-d')) return null
    if (t === '-t' || t === '--track' || t.startsWith('--track=')) { track = true; continue }
    if (t.startsWith('-') && t !== '-') continue
    refs.push(t)
  }
  if (created || paths.length > 0 || refs.length !== 1) return null
  const [target] = refs
  if (target === '-' || /^@\{-\d+\}$/.test(target)) return R.previous
  const name = track ? target.replace(/^[^/]+\//, '') : target
  return env.protect(name) ? say.protectedBranch(name) : null
}

function branchRule(rest, env) {
  const risky = rest.some(({ text: f }) => ['--force', '--delete', '--move', '--copy'].includes(f)
    || (/^-[A-Za-z]+$/.test(f) && /[dDfmMcC]/.test(f)))
  if (!risky) return null
  const hit = rest.find((a) => !a.text.startsWith('-') && env.protect(a.text))
  return hit ? say.protectedEdit(hit.text) : null
}

function configWrites(rest) {
  const flags = rest.map((a) => a.text).filter((t) => t.startsWith('-'))
  if (flags.some((f) => CONFIG_WRITES.has(f))) return true
  if (flags.some((f) => CONFIG_READS.has(f))) return false
  const ops = operands(rest, CONFIG_VALUES).map((a) => a.text)
  if (ops[0] === 'get' || ops[0] === 'list') return false
  if (['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(ops[0])) return true
  return ops.length >= 2
}

const GH_VALUES = new Set(['-R', '--repo', '--hostname', '--json', '-q', '--jq', '-t', '--template', '-L', '--limit', '-s',
  '--state'])
const GH_GROUPS = new Set(['pr', 'issue', 'repo', 'run', 'release', 'workflow'])
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks'])

function ghRule(args) {
  if (args.some((a) => a.text === '--web' || a.text === '-w')) return R.ghWeb
  const [group, action] = operands(args, GH_VALUES).map((a) => a.text)
  if (group === undefined || ['help', 'version', 'search'].includes(group)) return null
  if (group === 'api') return apiWrites(args.slice(args.findIndex((a) => a.text === 'api') + 1)) ? R.gh : null
  return GH_GROUPS.has(group) && GH_READS.has(action) ? null : R.gh
}

function apiWrites(rest) {
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].text
    let method = null
    if (t === '-X' || t === '--method') method = rest[++k]?.text ?? ''
    else if (t.startsWith('--method=')) method = t.slice(9)
    else if (/^-X./.test(t)) method = t.slice(2)
    if (method !== null) {
      if (method.toUpperCase() !== 'GET') return true
      continue
    }
    if (/^(-f|-F|--field|--raw-field|--input)$/.test(t) || /^--(field|raw-field|input)=/.test(t) || /^-[fF]./.test(t)) return true
  }
  return false
}

const PACKAGE_VALUES = new Set(['--prefix', '-w', '--workspace', '-C', '--dir', '--filter', '-F', '--workspace-dir', '--cwd',
  '--registry', '--otp', '--tag', '--access', '--loglevel'])
const REGISTRY = new Set(['login', 'logout', 'adduser', 'add-user', 'token', 'owner', 'author', 'deprecate', 'unpublish',
  'access', 'dist-tag', 'team', 'org'])

function packageRule(name, args) {
  const ops = operands(args, PACKAGE_VALUES, true).map((a) => a.text)
  if (ops.includes('publish')) return R.publish
  const script = ops[ops.findIndex((t) => t === 'run' || t === 'run-script') + 1] ?? ''
  const runs = ops.some((t) => t === 'run' || t === 'run-script')
  if (runs && /^(deploy|release)/.test(script)) return say.deploy(`${name} run ${script}`)
  if ((name === 'npm' || name === 'pnpm') && REGISTRY.has(ops[0])) return R.registry
  if (name === 'yarn' && ops[0] === 'npm' && REGISTRY.has(ops[1])) return R.registry
  return null
}

function wranglerRule(args) {
  if (['dev', 'types', 'whoami'].includes(firstOperand(args))) return null
  if (args.length > 0 && args.every((a) => ['--version', '-v', '-V'].includes(a.text))) return null
  return say.deploy('wrangler')
}

const SUPABASE_VALUES = new Set(['--workdir', '--project-ref', '--project-id', '--db-url', '-o', '--output', '-s', '--schema',
  '--profile', '--network-id', '--lang'])

function supabaseRule(args) {
  const [a, b] = operands(args, SUPABASE_VALUES).map((w) => w.text)
  const has = (flag) => args.some((w) => w.text === flag || w.text.startsWith(`${flag}=`))
  const remote = has('--linked') || has('--db-url') || has('--project-ref') || has('--project-id')
  if (['start', 'stop', 'status', 'test'].includes(a)) return remote ? say.deploy('supabase') : null
  if (a === 'db' && b === 'diff') return null
  if (a === 'db' && b === 'reset') return remote ? say.deploy('supabase') : null
  if (a === 'migration' && (b === 'new' || b === 'list')) return null
  if (a === 'gen' && b === 'types' && has('--local') && !remote) return null
  return say.deploy('supabase')
}

const DOCKER_VALUES = new Set(['--context', '-c', '-H', '--host', '--config', '-l', '--log-level', '--url', '--connection',
  '-f', '--file', '-p', '--project-name', '--env-file', '--profile', '-t', '--tag'])

function dockerRule(args) {
  const ops = operands(args, DOCKER_VALUES).map((a) => a.text)
  if (ops[0] === 'push' || ops[0] === 'login') return R.docker
  if (['image', 'compose', 'manifest', 'buildx'].includes(ops[0]) && ops.includes('push')) return R.docker
  if (args.some((a) => a.text === '--push' || /^--output=.*type=registry/.test(a.text))) return R.docker
  return null
}

const SYSTEMCTL_VALUES = new Set(['-p', '--property', '-t', '--type', '--state', '-n', '--lines', '-o', '--output', '-H', '--host',
  '-M', '--machine', '-s', '--signal', '--kill-whom', '--root', '--what', '--job-mode', '--timestamp', '--when'])
const SYSTEMCTL_READS = new Set(['status', 'show', 'list-units', 'list-timers', 'is-active', 'is-enabled', 'cat', 'is-failed',
  'list-unit-files'])

function systemctlRule(args) {
  const user = args.some((a) => a.text === '--user')
  const remote = args.some((a) => /^(-H|--host|-M|--machine)(=|$)/.test(a.text))
  const verb = firstOperand(args, SYSTEMCTL_VALUES) ?? 'list-units'
  return user && !remote && SYSTEMCTL_READS.has(verb) ? null : R.systemctl
}

// ---- network

const CURL_SHORT_VALUES = 'AbcCdDeEFHKmoPQrTuUwxXyYzt'
const CURL_LONG_VALUES = new Set(['--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--form',
  '--form-string', '--upload-file', '--request', '--url', '--header', '--user', '--user-agent', '--referer', '--cookie',
  '--cookie-jar', '--output', '--output-dir', '--config', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
  '--retry-max-time', '--proxy', '--proxy-user', '--cacert', '--capath', '--cert', '--key', '--write-out', '--range',
  '--resolve', '--connect-to', '--limit-rate', '--max-filesize', '--interface', '--dns-servers', '--unix-socket',
  '--abstract-unix-socket', '--oauth2-bearer', '--variable', '--aws-sigv4', '--trace', '--trace-ascii', '--stderr',
  '--dump-header', '--etag-save', '--etag-compare', '--time-cond', '--continue-at', '--speed-limit', '--speed-time',
  '--max-redirs', '--netrc-file', '--noproxy', '--preproxy', '--quote', '--mail-from', '--mail-rcpt', '--local-port'])
const CURL_SENDS = new Set(['--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--form',
  '--form-string', '--upload-file'])
const CURL_OUTPUTS = new Set(['--output', '--output-dir', '--cookie-jar', '--dump-header', '--trace', '--trace-ascii', '--stderr',
  '--etag-save'])
const readMethod = (method) => /^(GET|HEAD)$/i.test(method ?? '')

function hostOf(url) {
  let rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
  rest = rest.slice(rest.lastIndexOf('@') + 1)
  if (rest.startsWith('[')) return rest.slice(1, rest.includes(']') ? rest.indexOf(']') : undefined).toLowerCase()
  return rest.split(':')[0].toLowerCase()
}

function isLocal(url) {
  const host = hostOf(url)
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host)
    || host === '::1' || host === '0.0.0.0'
}

function sendCheck(sending, urls) {
  if (!sending) return null
  if (urls.length === 0) return say.send('an address the guard cannot see')
  const remote = urls.find((u) => !isLocal(u))
  if (remote === undefined) return null
  const host = hostOf(remote)
  return say.send(/^[\w.:-]+$/.test(host) ? host : remote)
}

function outputsCheck(outputs, local, env) {
  for (const w of outputs) {
    if (w.text === '-') continue
    const reason = writeReason(w, local, env)
    if (reason) return reason
  }
  return null
}

function curlRule(args, local, env) {
  let sending = false
  let unix = false
  const urls = []
  const outputs = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text
    if (t === '--') { urls.push(...args.slice(k + 1).map((a) => a.text)); break }
    if (t.startsWith('--')) {
      if (!CURL_LONG_VALUES.has(t)) continue
      const v = args[++k]
      if (CURL_SENDS.has(t)) sending = true
      if (t === '--request' && !readMethod(v?.text)) sending = true
      if (t === '--url' && v) urls.push(v.text)
      if (CURL_OUTPUTS.has(t) && v) outputs.push(v)
      if (t === '--unix-socket' || t === '--abstract-unix-socket') unix = true
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let m = 1; m < t.length; m++) {
        const ch = t[m]
        if (!CURL_SHORT_VALUES.includes(ch)) continue
        const v = m + 1 < t.length ? plainWord(t.slice(m + 1)) : args[++k]
        if ('dFT'.includes(ch)) sending = true
        if (ch === 'X' && !readMethod(v?.text)) sending = true
        if ('ocD'.includes(ch) && v) outputs.push(v)
        break
      }
      continue
    }
    urls.push(t)
  }
  return outputsCheck(outputs, local, env) ?? (unix ? null : sendCheck(sending, urls))
}

const WGET_VALUES = new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix',
  '-U', '--user-agent', '--header', '-e', '--execute', '-t', '--tries', '-T', '--timeout', '-w', '--wait', '--user', '--password',
  '--http-user', '--http-password', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '-i', '--input-file',
  '--referer', '--load-cookies', '--save-cookies', '-Q', '--quota', '--limit-rate', '-l', '--level', '-A', '--accept', '-R',
  '--reject', '-D', '--domains', '--bind-address'])
const WGET_OUTPUTS = new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix',
  '--save-cookies'])

function wgetRule(args, local, env) {
  let sending = false
  const urls = []
  const outputs = []
  for (let k = 0; k < args.length; k++) {
    let t = args[k].text
    let v = null
    const eq = t.startsWith('--') ? t.indexOf('=') : -1
    if (eq > 0) { v = valueAfterEq(args[k]); t = t.slice(0, eq) }
    else if (WGET_VALUES.has(t)) v = args[++k] ?? null
    else if (/^-[OoaP]./.test(t)) { v = plainWord(t.slice(2)); t = t.slice(0, 2) }
    if (['--post-data', '--post-file', '--body-data', '--body-file'].includes(t)) sending = true
    if (t === '--method' && !readMethod(v?.text)) sending = true
    if (WGET_OUTPUTS.has(t) && v) outputs.push(v)
    if (!t.startsWith('-') && v === null) urls.push(t)
  }
  return outputsCheck(outputs, local, env) ?? sendCheck(sending, urls)
}

const RSYNC_VALUES = new Set(['-e', '--rsh', '--exclude', '--include', '-f', '--filter', '--files-from', '--exclude-from',
  '--include-from', '--rsync-path', '--port', '--password-file', '--log-file', '--partial-dir', '-T', '--temp-dir', '--backup-dir',
  '--chmod', '--chown', '--timeout', '--bwlimit', '--max-size', '--min-size', '--compare-dest', '--copy-dest', '--link-dest',
  '-B', '--block-size', '--suffix', '--out-format', '-M', '--remote-option', '--info', '--debug'])

function rsyncRule(args, local, env) {
  const ops = operands(args, RSYNC_VALUES)
  if (ops.some((a) => /^rsync:\/\//.test(a.text) || /^(?:[\w.-]+@)?[\w.-]+::?/.test(a.text))) return say.remoteShell('rsync')
  if (ops.length < 2) return null
  const targets = args.some((a) => a.text === '--remove-source-files') ? ops : ops.slice(-1)
  for (const w of targets) {
    const reason = writeReason(w, local, env)
    if (reason) return reason
  }
  return null
}

// ---- writes from the shell

const ALL_OPERANDS = new Map([
  ['rm', []], ['rmdir', []], ['unlink', []], ['shred', ['-n', '--iterations', '-s', '--size', '--random-source']],
  ['truncate', ['-s', '--size', '-r', '--reference']], ['touch', ['-d', '--date', '-t', '-r', '--reference']],
  ['mkdir', ['-m', '--mode', '--context']], ['tee', []], ['chmod', []], ['chown', ['--from']], ['chgrp', []],
  ['mv', ['-t', '--target-directory', '-S', '--suffix']],
])
const TARGET_ONLY = new Map([
  ['cp', ['-t', '--target-directory', '-S', '--suffix']],
  ['install', ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']],
  ['ln', ['-t', '--target-directory', '-S', '--suffix']],
])
const SED_VALUES = new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length'])
const CHANGES_FILES = new Set([...ALL_OPERANDS.keys(), ...TARGET_ONLY.keys(), 'sed', 'dd'])

function writeRule(name, args, local, env) {
  const check = (words) => {
    for (const w of words) {
      const reason = writeReason(w, local, env)
      if (reason) return reason
    }
    return null
  }
  if (ALL_OPERANDS.has(name)) {
    const values = new Set(ALL_OPERANDS.get(name))
    return check([...operands(args, values), ...optionValues(args, ['-t', '--target-directory'].filter((o) => values.has(o)))])
  }
  if (TARGET_ONLY.has(name)) {
    const target = optionValues(args, ['-t', '--target-directory'])
    if (target.length) return check(target)
    const ops = operands(args, new Set(TARGET_ONLY.get(name)))
    if (name === 'install' && args.some((a) => a.text === '-d' || a.text === '--directory')) return check(ops)
    if (ops.length >= 2) return check(ops.slice(-1))
    if (name === 'ln' && ops.length === 1) {
      if (local.cwd === null) return R.cwdUnknown
      return writable(local.cwd, env, 'path') ? null : say.outside(shown(local.cwd, env))
    }
    return null
  }
  if (name === 'tar') {
    const extract = args.some(({ text: t }, k) => t === '--extract' || t === '--get'
      || (/^-[A-Za-z]*x/.test(t) && !t.startsWith('--')) || (k === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(t)))
    return extract ? check(optionValues(args, ['-C', '--directory'])) : null
  }
  if (name === 'unzip') return check(optionValues(args, ['-d']))
  if (name === 'dd') return check(args.filter((a) => a.text.startsWith('of=')).map(valueAfterEq).filter(Boolean))
  if (name === 'sed') {
    const inPlace = args.some(({ text: t }) => t === '--in-place' || t.startsWith('--in-place=') || /^-[^-]*i/.test(t))
    if (!inPlace) return null
    const ops = operands(args, SED_VALUES)
    const script = args.some(({ text: t }) => ['-e', '--expression', '-f', '--file'].includes(t)
      || /^--(expression|file)=/.test(t))
    return check(script ? ops : ops.slice(1))
  }
  return null
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FIND_OUTPUTS = new Set(['-fprint', '-fprint0', '-fprintf', '-fls'])

function findRule(args, local, env, out) {
  let k = 0
  while (k < args.length && /^-([HLP]|O\d*)$/.test(args[k].text)) k++
  if (args[k]?.text === '-D') k += 2
  const starts = []
  while (k < args.length && !/^[-(!),]/.test(args[k].text)) starts.push(args[k++])
  let deletes = false
  for (; k < args.length; k++) {
    const t = args[k].text
    if (t === '-delete') deletes = true
    else if (FIND_OUTPUTS.has(t) && args[k + 1]) {
      const reason = writeReason(args[++k], local, env)
      if (reason) return reason
    } else if (FIND_ACTIONS.has(t)) {
      const inner = []
      while (++k < args.length && args[k].text !== ';' && args[k].text !== '+') inner.push(args[k])
      const name = judgeWords(inner, clone(local), env, out)
      if (out.reason) return null
      if (CHANGES_FILES.has(name)) deletes = true
    }
  }
  if (!deletes) return null
  for (const w of starts.length ? starts : [plainWord('.')]) {
    const reason = writeReason(w, local, env)
    if (reason) return reason
  }
  return null
}

// ---- shells and test runs

// What a shell's arguments ask for: code to run (-c), a script file, or stdin.
function shellArgs(args) {
  let code = false
  let stdin = false
  let k = 0
  for (; k < args.length; k++) {
    const t = args[k].text
    if (t === '--' || t === '-') { k++; break }
    if (/^[-+][oO]$/.test(t) || t === '--rcfile' || t === '--init-file') { k++; continue }
    if (t.startsWith('--')) continue
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t[0] === '-' && t.includes('c')) code = true
      if (t[0] === '-' && t.includes('s')) stdin = true
      continue
    }
    break
  }
  const first = args[k] ?? null
  if (code) return { code: first }
  return { script: stdin ? null : first, stdin }
}

const NODE_VALUES = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
  '--input-type', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-concurrency'])
const MAKE_VALUES = new Set(['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file',
  '-W', '--what-if', '--assume-new', '-j', '--jobs', '-l', '--load-average'])

/** Builds are as heavy as tests (a Next.js build takes gigabytes), so they wait for the same lock. */
function isBuild(name, args) {
  const ops = ['npm', 'pnpm', 'yarn', 'bun'].includes(name) ? operands(args, PACKAGE_VALUES, true).map((a) => a.text) : []
  if (ops.length) return ops[0] === 'build' || (['run', 'run-script'].includes(ops[0]) && /^build/.test(ops[1] ?? ''))
  if (['next', 'vite', 'astro', 'nuxt', 'svelte-kit', 'remix'].includes(name)) return firstOperand(args) === 'build'
  if (name === 'cargo') return firstOperand(args.filter((a) => !a.text.startsWith('+'))) === 'build'
  return false
}

function isTestRun(name, word, args) {
  if (isBuild(name, args)) return true
  switch (name) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return packageTest(name, args)
    case 'deno': case 'go': return firstOperand(args) === 'test'
    case 'cargo': return ['test', 'nextest'].includes(firstOperand(args.filter((a) => !a.text.startsWith('+'))))
    case 'vitest': case 'jest': case 'mocha': case 'pytest': case 'py.test': return true
    case 'playwright': return firstOperand(args) === 'test'
    case 'make': case 'gmake': return operands(args, MAKE_VALUES).some((a) => a.text === 'test' || a.text === 'check')
    case 'node': {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text
        if (t === '--test') return true
        if (!t.startsWith('-')) return false
        if (NODE_VALUES.has(t)) k++
      }
      return false
    }
  }
  if (/^python[\d.]*$/.test(name)) return pythonModule(args) === 'pytest'
  if (SHELLS.has(name)) {
    const { script } = shellArgs(args)
    return script ? testScript(script.text) : false
  }
  return testScript(word.text)
}

function packageTest(name, args) {
  const ops = operands(args, PACKAGE_VALUES, true).map((a) => a.text)
  const [first, second = ''] = ops
  if (!first) return false
  if (name === 'bun') return first === 'test' || (first === 'run' && /^test/.test(second))
  if (['test', 't', 'tst', 'it', 'cit', 'install-test', 'install-ci-test'].includes(first)) return true
  if ((first === 'run' || first === 'run-script') && /^test/.test(second)) return true
  if (name === 'npm') return false
  if (/^test/.test(first)) return true
  const run = ops.indexOf('run')
  return run >= 0 && /^test/.test(ops[run + 1] ?? '')
}

function pythonModule(args) {
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text
    if (t === '-m') return args[k + 1]?.text ?? null
    if (/^-m./.test(t)) return t.slice(2)
    if (t === '-c' || !t.startsWith('-')) return null
    if (['-W', '-X', '-Q'].includes(t)) k++
  }
  return null
}

function testScript(text) {
  const parts = text.split('/')
  const base = parts.pop()
  return /^run-tests/.test(base) || (base === 'run.sh' && parts.some((d) => d === 'test' || d === 'tests'))
}
