import { readFileSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

/** Pure. Last row wins; `<synthetic>` is not a real model. */
export function modelFromTranscript(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    let m
    try { m = JSON.parse(line)?.message?.model } catch { continue } // a partial or junk line tells us nothing
    if (typeof m === 'string' && m !== '' && m !== '<synthetic>') return m
  }
  return null
}

/** `claude-opus-5[1m]` -> `claude-opus-5`. */
export function stripSuffix(model) {
  if (typeof model !== 'string') return null
  const i = model.indexOf('[')
  return i === -1 ? model : model.slice(0, i)
}

/**
 * Finds a session's transcript by searching one level under `<configDir>/projects/` for a
 * `<sessionId>.jsonl` file. Exists for callers that only ever receive a session id, never a
 * `transcript_path` — a plain slash-command CLI invoked as a shell substitution (unlike a
 * hook, which gets `transcript_path` handed to it directly on stdin) has no other way to
 * find the transcript at all.
 *
 * Deliberately conservative, in the same direction every guess-avoidance rule in this
 * plugin leans: a path is returned ONLY when exactly one project directory contains a
 * session file with this name. Zero matches (nothing found yet, e.g. session hasn't
 * written a transcript) and more than one match (a session id colliding across projects,
 * which should not happen but is not a case worth guessing through) both return null, and
 * the caller's existing settings.json fallback applies exactly as it would for a hook that
 * received no transcript_path at all — this function never invents a preference between
 * ambiguous candidates.
 *
 * Never throws: a missing or unreadable `projects` directory, or a single unreadable
 * project subdirectory, is treated as "no match found there" rather than propagating —
 * fail-open to the settings fallback, not to a crash.
 */
export function findSessionTranscript(configDir, sessionId, { readdir = readdirSync } = {}) {
  if (typeof configDir !== 'string' || typeof sessionId !== 'string' || sessionId === '') return null
  const projectsDir = join(configDir, 'projects')
  let projectNames
  try { projectNames = readdir(projectsDir) }
  catch { return null } // no projects directory yet, or it cannot be read — nothing to search
  const wanted = `${sessionId}.jsonl`
  const matches = []
  for (const name of projectNames) {
    let files
    try { files = readdir(join(projectsDir, name)) }
    catch { continue } // this one project directory is unreadable; the others may still resolve
    if (files.includes(wanted)) matches.push(join(projectsDir, name, wanted))
  }
  return matches.length === 1 ? matches[0] : null
}

// Windows tried, smallest first. A JSONL transcript's most recent model is almost always
// inside the last 64KB; the larger sizes are only needed when a long run of synthetic/tool
// rows, or one outsized row, pushes the real answer further back than that.
const WINDOW_SIZES = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024]

/**
 * Reads at most the last `bytes` bytes of the file at `path`, returning
 * `{ text, reachedStart }`.
 *
 * A byte offset into a JSONL file is not necessarily a row boundary. When the read
 * starts strictly past byte 0 (the file is bigger than the window), whatever sits
 * before the first '\n' is a row we landed inside of, not at its start, and can never
 * be safely parsed — so it is REMOVED: everything up to and including that '\n' is cut
 * from the returned text. This is safe because a line boundary in this format is always
 * an ASCII newline, and an ASCII byte can never appear as a continuation byte of a
 * multi-byte UTF-8 character, so cutting the text at it can never split one.
 *
 * If the window never reaches a '\n' at all — the tail end of one row bigger than the
 * whole window — there is no boundary to cut at, so the raw (as yet unparseable) bytes
 * are returned unchanged. `modelFromTranscript` will fail to parse that single fragment
 * as JSON and find nothing, and `reachedStart: false` correctly tells the caller a
 * bigger window might do better.
 *
 * `reachedStart` is computed directly from the file size (true exactly when the whole
 * file fit inside the requested window), not inferred from the returned text's length.
 * Removing the leading fragment above makes `text` shorter than `bytes` on every
 * ordinary discard, not only when the start of the file was actually reached, so the
 * length can no longer serve as that signal — it has to be explicit.
 */
export function readTail(path, bytes, {
  open = openSync, fstat = fstatSync, read = readSync, close = closeSync,
} = {}) {
  const fd = open(path, 'r')
  try {
    const size = fstat(fd).size
    const len = Math.min(bytes, size)
    const filePos = size - len
    const buf = Buffer.alloc(len)
    read(fd, buf, 0, len, filePos)
    let text = buf.toString('utf8')
    if (filePos > 0) {
      const nl = text.indexOf('\n')
      if (nl !== -1) text = text.slice(nl + 1) // drop the fragment we landed inside of; keep the newline's own successor onward
    }
    return { text, reachedStart: filePos === 0 }
  } finally {
    close(fd)
  }
}

/**
 * Tries growing windows so a fresh transcript resolves without reading the whole file,
 * while a pathological tail (long runs of synthetic/tool rows, or one huge row) still
 * resolves correctly by growing until it does.
 *
 * Never throws: an unreadable transcript (missing file, permission error, whatever
 * `readTailFn` throws) tells us nothing, so this returns null and `currentModel` falls
 * back to settings exactly as it would for an empty transcript.
 */
function modelFromTail(transcriptPath, readTailFn) {
  for (const bytes of WINDOW_SIZES) {
    let text, reachedStart
    try { ({ text, reachedStart } = readTailFn(transcriptPath, bytes)) } catch { return null } // a thrown read or a malformed result both tell us nothing
    const model = modelFromTranscript(text)
    if (model) return model
    if (reachedStart) return null // the whole file was already read; a bigger window can't add anything
  }
  return null
}

/**
 * Never throws. Returns null when the model cannot be determined — the caller stays silent.
 *
 * `readFile` and `readTail` are independent, optional overrides. A caller that supplies
 * only `readFile` (the shape this module originally took) still gets the transcript read
 * through it, wholesale, exactly as before — no caller that only injects `readFile` needs
 * to change. That whole-file read is wrapped as `{ text, reachedStart: true }` so it
 * matches the real `readTail`'s return shape and `modelFromTail` never tries to grow past
 * the one read (there is nothing more to read). With neither supplied, production reads
 * the transcript through the real windowed `readTail` above, so a live hook is never
 * forced to read an entire multi-megabyte transcript to find one field near the end.
 */
export function currentModel({ transcriptPath, settingsPath, readFile, readTail: readTailOverride } = {}) {
  const readWhole = readFile ?? readFileSync
  const tail = readTailOverride ?? (readFile
    ? (p) => ({ text: readFile(p, 'utf8'), reachedStart: true }) // a whole-file read has nothing left to grow into
    : readTail)

  if (transcriptPath) {
    const fromTranscript = modelFromTail(transcriptPath, tail)
    // A transcript model that strips down to '' (e.g. the most recent row is literally
    // "[1m]") is not a usable value — but it is also not a reason to stop looking. It
    // must be treated exactly like a transcript that yielded nothing at all: fall through
    // to settingsPath rather than returning early with a bad answer (or, as a prior bug
    // here did, with '' itself — a truthy-looking empty string the caller could mistake
    // for "a model we can't name").
    const stripped = fromTranscript ? stripSuffix(fromTranscript) : null
    if (stripped) return stripped
  }
  if (settingsPath) {
    let raw
    try { raw = readWhole(settingsPath, 'utf8') } catch { return null } // unreadable settings tells us nothing
    try { return stripSuffix(JSON.parse(raw)?.model) || null }
    catch { return null } // malformed settings tells us nothing
  }
  return null
}
