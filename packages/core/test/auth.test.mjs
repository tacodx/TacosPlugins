import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExpired, refreshToken, writeBackCredentials, readCredentials, getAccessToken,
  credentialsPath, TOKEN_URL,
} from '../auth.mjs'

const cred = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 }

test('expiry uses a five minute margin', () => {
  assert.equal(isExpired(cred, 600_000), false)
  assert.equal(isExpired(cred, 700_001), true, 'inside the 300s margin counts as expired')
  assert.equal(isExpired(cred, 1_200_000), true)
})

test('the five-minute margin boundary itself counts as expired, not just past it', () => {
  // guards >= vs >: at exactly now + margin === expiresAt, the token must already read as expired
  assert.equal(isExpired(cred, 700_000), true)
})

test('isExpired treats a missing, zero, null, or NaN expiry as expired', () => {
  assert.equal(isExpired({ ...cred, expiresAt: undefined }, 0), true)
  assert.equal(isExpired({ ...cred, expiresAt: 0 }, 0), true)
  assert.equal(isExpired({ ...cred, expiresAt: null }, 0), true)
  assert.equal(isExpired({ ...cred, expiresAt: NaN }, 0), true)
})

test('readCredentials pulls claudeAiOauth and tolerates junk', () => {
  const ok = readCredentials('/p', () => JSON.stringify({ claudeAiOauth: cred }))
  assert.equal(ok.accessToken, 'a')
  assert.equal(readCredentials('/p', () => 'garbage'), null)
  assert.equal(readCredentials('/p', () => JSON.stringify({})), null)
})

test('refresh posts to the platform token endpoint, not api.anthropic.com', async () => {
  let seen
  await refreshToken(cred, {
    fetchImpl: async (url, opts) => {
      seen = { url, opts }
      return { ok: true, json: async () => ({ access_token: 'a2', expires_in: 3600 }) }
    },
  })
  assert.equal(seen.url, TOKEN_URL)
  assert.match(seen.url, /platform\.claude\.com/)
  const body = JSON.parse(seen.opts.body)
  assert.equal(body.grant_type, 'refresh_token')
  assert.equal(body.refresh_token, 'r')
  assert.ok(body.client_id)
})

test('a rotated refresh token is captured; an absent one keeps the old', async () => {
  const rotated = await refreshToken(cred, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 60 }) }),
  })
  assert.equal(rotated.refreshToken, 'r2')
  const kept = await refreshToken(cred, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'a2', expires_in: 60 }) }),
  })
  assert.equal(kept.refreshToken, 'r')
})

test('a failed refresh returns null rather than throwing', async () => {
  assert.equal(await refreshToken(cred, { fetchImpl: async () => ({ ok: false, status: 400 }) }), null)
  assert.equal(await refreshToken(cred, { fetchImpl: async () => { throw new Error('offline') } }), null)
})

test('write-back preserves sibling keys such as mcpOAuth', () => {
  let written
  writeBackCredentials('/p', { accessToken: 'new', refreshToken: 'r2', expiresAt: 9 }, {
    readFile: () => JSON.stringify({ mcpOAuth: { server: { token: 'keep' } }, claudeAiOauth: cred }),
    writeFile: (_p, body) => { written = JSON.parse(body) },
    rename: () => {},
  })
  assert.equal(written.mcpOAuth.server.token, 'keep', 'mcp tokens must survive')
  assert.equal(written.claudeAiOauth.accessToken, 'new')
})

test('write-back uses mode 0600', () => {
  let mode
  writeBackCredentials('/p', cred, {
    readFile: () => JSON.stringify({ claudeAiOauth: cred }),
    writeFile: (_p, _b, opts) => { mode = opts?.mode },
    rename: () => {},
  })
  assert.equal(mode, 0o600)
})

test('write-back writes an atomic, freshly-named tmp file then renames it into place', () => {
  let writeArgs, renameArgs
  writeBackCredentials('/p', cred, {
    readFile: () => JSON.stringify({ claudeAiOauth: cred }),
    writeFile: (p, _b, opts) => { writeArgs = { path: p, opts } },
    rename: (from, to) => { renameArgs = { from, to } },
    uuid: () => 'FIXED',
  })
  assert.ok(writeArgs.path.endsWith('.tmp'), 'tmp path must be distinguishable')
  assert.notEqual(writeArgs.path, '/p', 'must never write directly to the real target')
  assert.equal(writeArgs.opts.mode, 0o600)
  assert.equal(writeArgs.opts.flag, 'wx', 'wx guarantees mode is applied on every write, never reusing a stale tmp file')
  assert.equal(renameArgs.from, writeArgs.path)
  assert.equal(renameArgs.to, '/p')
})

test('an unreadable credentials file (EACCES) is never overwritten', () => {
  let writeCalled = false
  writeBackCredentials('/p', cred, {
    readFile: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err },
    writeFile: () => { writeCalled = true },
    rename: () => {},
  })
  assert.equal(writeCalled, false)
})

test('a corrupt/unparseable credentials file is never overwritten', () => {
  let writeCalled = false
  writeBackCredentials('/p', cred, {
    readFile: () => '﻿not valid json even after stripping the bom',
    writeFile: () => { writeCalled = true },
    rename: () => {},
  })
  assert.equal(writeCalled, false)
})

test('a BOM-prefixed but validly-formatted credentials file still preserves siblings', () => {
  // this is the exact Critical-1 repro: mcpOAuth + a UTF-8 BOM must survive a write-back
  let written
  writeBackCredentials('/p', { accessToken: 'new' }, {
    readFile: () => '﻿' + JSON.stringify({ mcpOAuth: { server: { token: 'keep' } }, claudeAiOauth: cred }),
    writeFile: (_p, body) => { written = JSON.parse(body) },
    rename: () => {},
  })
  assert.equal(written.mcpOAuth.server.token, 'keep')
  assert.equal(written.claudeAiOauth.accessToken, 'new')
})

test('a genuinely missing credentials file (ENOENT) is created fresh', () => {
  let written
  writeBackCredentials('/p', cred, {
    readFile: () => { const err = new Error('missing'); err.code = 'ENOENT'; throw err },
    writeFile: (_p, body) => { written = JSON.parse(body) },
    rename: () => {},
  })
  assert.ok(written.claudeAiOauth)
  assert.equal(written.claudeAiOauth.accessToken, cred.accessToken)
})

test('a credentials file that parses to a JSON array is never overwritten', () => {
  let writeCalled = false
  writeBackCredentials('/p', cred, {
    readFile: () => JSON.stringify([1, 2, 3]),
    writeFile: () => { writeCalled = true },
    rename: () => {},
  })
  assert.equal(writeCalled, false)
})

test('a failed rename cleans up the tmp file rather than leaving it behind', () => {
  let removedPath, writtenTmpPath
  writeBackCredentials('/p', cred, {
    readFile: () => JSON.stringify({ claudeAiOauth: cred }),
    writeFile: (p) => { writtenTmpPath = p },
    rename: () => { throw new Error('rename failed') },
    remove: (p) => { removedPath = p },
  })
  assert.equal(removedPath, writtenTmpPath)
})

test('getAccessToken refreshes an expired token and writes it back through every injected seam', async () => {
  let written, renamedFrom, renamedTo, removeCalled = false
  const dir = '/home/test/.claude'
  const result = await getAccessToken({
    dir,
    now: 2_000_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }) }),
    readFile: () => JSON.stringify({ claudeAiOauth: cred, mcpOAuth: { x: 1 } }),
    writeFile: (_p, body) => { written = JSON.parse(body) },
    rename: (from, to) => { renamedFrom = from; renamedTo = to },
    remove: () => { removeCalled = true },
  })
  assert.equal(result.token, 'new-token')
  assert.equal(result.error, null)
  assert.equal(written.claudeAiOauth.accessToken, 'new-token')
  assert.equal(written.claudeAiOauth.refreshToken, 'new-refresh')
  assert.equal(written.mcpOAuth.x, 1, 'mcp tokens must survive the full orchestration, not just the unit-level write-back')
  assert.equal(renamedTo, credentialsPath(dir), 'getAccessToken must forward its own rename, not silently fall back to the real renameSync')
  assert.ok(renamedFrom.endsWith('.tmp'))
  assert.equal(removeCalled, false, 'remove is only invoked on a failed rename; this rename succeeds')
})

test('getAccessToken falls back to the existing token when refresh fails, rather than going blind', async () => {
  const result = await getAccessToken({
    dir: '/home/test/.claude',
    now: 2_000_000,
    fetchImpl: async () => ({ ok: false, status: 401 }),
    readFile: () => JSON.stringify({ claudeAiOauth: cred }),
    writeFile: () => { throw new Error('must not be called: refresh failed, nothing to write back') },
    rename: () => { throw new Error('must not be called: refresh failed, nothing to write back') },
  })
  assert.equal(result.token, cred.accessToken)
  assert.equal(result.error, 'refresh-failed-using-existing')
})
