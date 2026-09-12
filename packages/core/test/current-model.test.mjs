import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelFromTranscript, stripSuffix, currentModel, readTail } from '../current-model.mjs'

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
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? '' : JSON.stringify({ model: 'claude-opus-5[1m]' })),
  })
  assert.equal(m, 'claude-opus-5')
})

test('prefers the transcript over settings', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: (p) => (p === '/t' ? row('claude-sonnet-5', '1') : JSON.stringify({ model: 'claude-opus-5' })),
  })
  assert.equal(m, 'claude-sonnet-5')
})

test('never throws; returns null when everything fails', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: '/s',
    readFile: () => { throw new Error('nope') },
  })
  assert.equal(m, null)
})

test('returns null, not a guessed default, when there is no settings path to fall back to', () => {
  const m = currentModel({
    transcriptPath: '/t', settingsPath: undefined,
    readFile: () => '',
  })
  assert.equal(m, null)
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
