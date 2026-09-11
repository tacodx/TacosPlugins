import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExpired, refreshToken, writeBackCredentials, readCredentials, TOKEN_URL } from '../auth.mjs'

const cred = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 }

test('expiry uses a five minute margin', () => {
  assert.equal(isExpired(cred, 600_000), false)
  assert.equal(isExpired(cred, 700_001), true, 'inside the 300s margin counts as expired')
  assert.equal(isExpired(cred, 1_200_000), true)
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
