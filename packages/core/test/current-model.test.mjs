import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelFromTranscript, stripSuffix, currentModel, readTail, findSessionTranscript } from '../current-model.mjs'

const row = (model, ts) => JSON.stringify({ message: { model }, timestamp: ts })
const WINDOW_1 = 64 * 1024
const WINDOW_2 = 1024 * 1024

test('takes the most recent model, not the first', () => {
  const text = [row('claude-sonnet-5', '1'), row('claude-opus-5', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('ignores synthetic rows', () => {
  const text = [row('claude-opus-5', '1'), row('<synthetic>', '2')].join('\n')
  assert.equal(modelFromTranscript(text), 'claude-opus-5')
})

test('tolerates junk lines and returns null when there is no model', () => {
  assert.equal(modelFromTranscript('not json\n{}\n'), null)
  assert.equal(modelFromTranscript(''), null)
})

test('strips a context suffix', () => {
  assert.equal(stripSuffix('claude-opus-5[1m]'), 'claude-opus-5')
  assert.equal(stripSuffix('claude-opus-5'), 'claude-opus-5')
  assert.equal(stripSuffix(null), null)
})

test('falls back to settings when the transcript yields nothing', () => {
  // Transcript content is fed via readTail, never readFile — readFile governs only the
  // settings.json read below.
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readTail: () => ({ text: '', reachedStart: true }),
    readFile: () => JSON.stringify({ model: 'claude-opus-5[1m]' }),
  })
  assert.equal(m, 'claude-opus-5')
})

test('prefers the transcript over settings', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readTail: () => ({ text: row('claude-sonnet-5', '1'), reachedStart: true }),
    readFile: () => JSON.stringify({ model: 'claude-opus-5' }),
  })
  assert.equal(m, 'claude-sonnet-5')
})

test('never throws; returns null when everything fails', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readTail: () => { throw new Error('nope') },
    readFile: () => { throw new Error('nope') },
  })
  assert.equal(m, null)
})

test('returns null, not a guessed default, when there is no settings path to fall back to', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: undefined,
    readTail: () => ({ text: '', reachedStart: true }),
  })
  assert.equal(m, null)
})

test('currentModel never calls readFile with the transcript path — readFile governs settings.json only', () => {
  // readFile and readTail are two separate seams with no interaction: passing readFile
  // must have zero effect on how the transcript is read. Record every path readFile
  // receives and assert afterward that the transcript path is never among them — this is
  // the exact property whose absence let both real call sites (the hook and /limits)
  // silently disable the windowed transcript read by passing readFile for settings.json.
  //
  // Deliberately supplies ONLY readFile, no readTail override, so the transcript falls
  // through to whatever currentModel's actual default transcript-reading path is. That
  // default is the real windowed readTail, which will genuinely try to open this
  // nonexistent path and fail closed (ENOENT) — never touching readFile at all. This is
  // the exact case the old conditional got wrong: with only readFile supplied, it swapped
  // in a readFile-backed whole-file substitute instead of leaving readTail's real default
  // in place, so a mutation restoring that conditional makes this test fail (verified
  // below) precisely because it does NOT also inject readTail, unlike the test after it.
  const readFileCalls = []
  const readFile = (p) => {
    readFileCalls.push(p)
    return JSON.stringify({ model: 'claude-opus-5' })
  }
  const m = currentModel({
    transcriptPath: '/nonexistent-transcript-path-for-current-model-test', settingsPath: '/s',
    readFile,
  })
  assert.equal(m, 'claude-opus-5')
  assert.deepEqual(readFileCalls, ['/s'])
  assert.ok(!readFileCalls.includes('/nonexistent-transcript-path-for-current-model-test'),
    'readFile must never be called with the transcript path')
})

test('supplying readFile has no effect on transcript reading — the windowed readTail is still used', () => {
  // Pins the other half of the same property: readFile's mere presence must not disable
  // or replace the windowed transcript read. readTail is injected here purely as a spy
  // (recording the window size it was asked for) so this test can observe that it is
  // still the transcript's actual read path even though readFile is also supplied.
  const readTailCalls = []
  const readFile = () => JSON.stringify({ model: 'claude-opus-5' }) // must never be reached for this transcript
  const readTail = (path, bytes) => {
    readTailCalls.push(bytes)
    return { text: row('claude-sonnet-5', '1'), reachedStart: true }
  }
  const m = currentModel({ transcriptPath: '/t', settingsPath: '/s', readFile, readTail })
  assert.equal(m, 'claude-sonnet-5')
  assert.ok(readTailCalls.length > 0, 'readTail must be called for the transcript even when readFile is also supplied')
  assert.deepEqual(readTailCalls, [WINDOW_1])
})

test('returns null, not an empty string, when the transcript model strips to nothing', () => {
  const m = currentModel({
    transcriptPath: '/t',
    readTail: () => ({ text: row('[1m]', '1'), reachedStart: true }),
  })
  assert.equal(m, null)
})

test('falls through to settings when the transcript model is unusable, not just empty-but-final', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    // The transcript's most recent row is literally "[1m]" — stripSuffix reduces it to ''.
    // That must not end the search: it's unusable, not a reason to stop before settings.
    readTail: () => ({ text: row('[1m]', '1'), reachedStart: true }),
    readFile: () => JSON.stringify({ model: 'claude-sonnet-5' }),
  })
  assert.equal(m, 'claude-sonnet-5')
})

test('finds the model in the first window without growing', () => {
  const calls = []
  const m = currentModel({
    transcriptPath: '/t',
    readTail: (path, bytes) => {
      calls.push(bytes)
      return { text: row('claude-opus-5', '1'), reachedStart: true }
    },
  })
  assert.equal(m, 'claude-opus-5')
  assert.deepEqual(calls, [WINDOW_1])
})

test('grows to a bigger window when the first has no model', () => {
  const calls = []
  const m = currentModel({
    transcriptPath: '/t',
    readTail: (path, bytes) => {
      calls.push(bytes)
      // The smallest window is entirely full of unparseable content (as a real
      // readTail would return when it lands inside one still-open row, with no '\n' in
      // view yet) — nothing usable here, and reachedStart is false because there is
      // more file before this window.
      if (bytes === WINDOW_1) return { text: 'x'.repeat(WINDOW_1), reachedStart: false }
      return { text: row('claude-sonnet-5', '1'), reachedStart: false }
    },
  })
  assert.equal(m, 'claude-sonnet-5')
  assert.deepEqual(calls, [WINDOW_1, WINDOW_2])
})

test('resolves a single row bigger than the smallest window after growing', () => {
  const calls = []
  const giantRow = JSON.stringify({ message: { model: 'claude-opus-5', content: 'x'.repeat(200_000) }, timestamp: '1' })
  const m = currentModel({
    transcriptPath: '/t',
    readTail: (path, bytes) => {
      calls.push(bytes)
      // The giant row alone is bigger than the smallest window, so that window's raw
      // read lands entirely inside it — no '\n' anywhere in view, and reachedStart is
      // false because there is more file before this window.
      if (bytes === WINDOW_1) return { text: giantRow.slice(-WINDOW_1), reachedStart: false }
      return { text: giantRow, reachedStart: false }
    },
  })
  assert.equal(m, 'claude-opus-5')
  assert.deepEqual(calls, [WINDOW_1, WINDOW_2])
})

test('gives up without growing once a small file has been read in full', () => {
  const calls = []
  const m = currentModel({
    transcriptPath: '/t',
    // A file smaller than even the first window: readTail reports reachedStart on the
    // very first try, which is what tells the caller not to bother asking for more.
    readTail: (path, bytes) => {
      calls.push(bytes)
      return { text: row('<synthetic>', '1'), reachedStart: true }
    },
  })
  assert.equal(m, null)
  assert.deepEqual(calls, [WINDOW_1])
})

test('readTail drops the leading fragment when the window starts mid-line', () => {
  const full = row('claude-sonnet-5', '1') + '\n' + row('claude-opus-5', '2')
  const content = 'garbage-not-json-at-all' + '\n' + full
  const buf = Buffer.from(content, 'utf8')
  const bytes = full.length + 5 // starts 5 bytes into the leading garbage fragment: offset > 0
  const io = {
    open: () => 1,
    fstat: () => ({ size: buf.length }),
    read: (fd, dest, destOffset, length, position) => {
      buf.copy(dest, destOffset, position, position + length)
      return length
    },
    close: () => {},
  }
  const { text, reachedStart } = readTail('/fake', bytes, io)
  assert.equal(text, full) // leading fragment gone — starts exactly at the first complete line
  assert.equal(reachedStart, false)
})

test('readTail keeps the first line intact when the whole file fits in the window', () => {
  const content = row('claude-opus-5', '1')
  const buf = Buffer.from(content, 'utf8')
  const io = {
    open: () => 1,
    fstat: () => ({ size: buf.length }),
    read: (fd, dest, destOffset, length, position) => {
      buf.copy(dest, destOffset, position, position + length)
      return length
    },
    close: () => {},
  }
  // Request far more than the file contains: the read starts at byte 0, so nothing is removed.
  const { text, reachedStart } = readTail('/fake', buf.length + 10_000, io)
  assert.equal(text, content)
  assert.equal(reachedStart, true)
})

test('readTail returns the raw chunk unchanged when no newline is in view', () => {
  const content = 'y'.repeat(200) // one giant "row" fragment, no '\n' anywhere
  const buf = Buffer.from(content, 'utf8')
  const bytes = 50 // smaller than the file: offset > 0, but no '\n' inside the window
  const io = {
    open: () => 1,
    fstat: () => ({ size: buf.length }),
    read: (fd, dest, destOffset, length, position) => {
      buf.copy(dest, destOffset, position, position + length)
      return length
    },
    close: () => {},
  }
  const { text, reachedStart } = readTail('/fake', bytes, io)
  assert.equal(text, 'y'.repeat(bytes)) // unchanged: nothing was safe to cut at
  assert.equal(reachedStart, false) // no boundary found — signals "try a bigger window"
})

test('a transcript whose window starts mid-line still yields the correct most recent model', () => {
  const full = row('claude-sonnet-5', '1') + '\n' + row('claude-opus-5', '2')
  const content = 'garbage-not-json-at-all' + '\n' + full
  const buf = Buffer.from(content, 'utf8')
  const bytes = full.length + 5 // starts 5 bytes into the leading garbage fragment: offset > 0
  const io = {
    open: () => 1,
    fstat: () => ({ size: buf.length }),
    read: (fd, dest, destOffset, length, position) => {
      buf.copy(dest, destOffset, position, position + length)
      return length
    },
    close: () => {},
  }
  // Ignores currentModel's requested window size and always reads through the real
  // readTail at this fixed, mid-line-starting size — this exercises the real
  // fragment-removal end to end, not a hand-rolled stand-in for it.
  const m = currentModel({
    transcriptPath: '/fake',
    readTail: (path) => readTail(path, bytes, io),
  })
  assert.equal(m, 'claude-opus-5')
})

// --- findSessionTranscript ---
//
// This is the only way `/limits` (a plain shell substitution that receives just a session
// id, never transcript_path) can recover transcript access at all. The directory reader is
// injected and never asserted inside — each mock records nothing, just returns canned
// listings or throws, and assertions run on findSessionTranscript's return value afterward.

test('exactly one project directory containing the session file resolves to its path', () => {
  const readdir = (p) => {
    if (p === '/cfg/projects') return ['proj-a']
    if (p === '/cfg/projects/proj-a') return ['s1.jsonl', 'other.jsonl']
    throw new Error(`unexpected path ${p}`)
  }
  const found = findSessionTranscript('/cfg', 's1', { readdir })
  assert.equal(found, '/cfg/projects/proj-a/s1.jsonl')
})

test('zero matches falls back to null (caller then uses settings)', () => {
  const readdir = (p) => {
    if (p === '/cfg/projects') return ['proj-a']
    if (p === '/cfg/projects/proj-a') return ['other.jsonl']
    throw new Error(`unexpected path ${p}`)
  }
  assert.equal(findSessionTranscript('/cfg', 's1', { readdir }), null)
})

test('two matches across different project directories falls back to null rather than picking one', () => {
  const readdir = (p) => {
    if (p === '/cfg/projects') return ['proj-a', 'proj-b']
    if (p === '/cfg/projects/proj-a') return ['s1.jsonl']
    if (p === '/cfg/projects/proj-b') return ['s1.jsonl']
    throw new Error(`unexpected path ${p}`)
  }
  assert.equal(findSessionTranscript('/cfg', 's1', { readdir }), null)
})

test('an unreadable projects directory falls back to null rather than throwing', () => {
  const readdir = () => { throw new Error('EACCES') }
  assert.doesNotThrow(() => findSessionTranscript('/cfg', 's1', { readdir }))
  assert.equal(findSessionTranscript('/cfg', 's1', { readdir }), null)
})

test('one unreadable project directory does not stop the search of the others', () => {
  const readdir = (p) => {
    if (p === '/cfg/projects') return ['broken', 'proj-a']
    if (p === '/cfg/projects/broken') throw new Error('EACCES')
    if (p === '/cfg/projects/proj-a') return ['s1.jsonl']
    throw new Error(`unexpected path ${p}`)
  }
  assert.equal(findSessionTranscript('/cfg', 's1', { readdir }), '/cfg/projects/proj-a/s1.jsonl')
})

test('missing configDir or sessionId never throws and yields null', () => {
  assert.equal(findSessionTranscript(undefined, 's1'), null)
  assert.equal(findSessionTranscript('/cfg', undefined), null)
  assert.equal(findSessionTranscript('/cfg', ''), null)
})
