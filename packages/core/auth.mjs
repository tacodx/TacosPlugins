import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLIENT_ID = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

const EXPIRY_MARGIN_MS = 300_000 // matches Claude Code's own margin

export function credentialsPath(dir) {
  return join(dir, '.credentials.json')
}

export function readCredentials(path, readFile = readFileSync) {
  try {
    const o = JSON.parse(readFile(path, 'utf8'))?.claudeAiOauth
    return o?.accessToken ? o : null
  } catch { return null } // file missing, unreadable, or not valid JSON
}

export function isExpired(cred, now, marginMs = EXPIRY_MARGIN_MS) {
  if (!cred?.expiresAt) return false
  return now + marginMs >= cred.expiresAt
}

/** Returns updated credentials, or null on any failure. Never throws. */
export async function refreshToken(cred, {
  fetchImpl = fetch, clientId = CLIENT_ID, scope = SCOPE,
} = {}) {
  if (!cred?.refreshToken) return null
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        client_id: clientId,
        scope,
      }),
    })
    if (!res?.ok) return null
    const body = await res.json()
    if (!body?.access_token) return null
    return {
      ...cred,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || cred.refreshToken,
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : cred.expiresAt,
    }
  } catch { return null } // network error, non-JSON body, or any other refresh failure: fail closed to null
}

/** Read-modify-write. Preserves every sibling key, notably mcpOAuth. Never throws. */
export function writeBackCredentials(path, cred, {
  readFile = readFileSync, writeFile = writeFileSync, rename = renameSync,
} = {}) {
  try {
    let doc = {}
    try { doc = JSON.parse(readFile(path, 'utf8')) || {} } catch { doc = {} } // missing/corrupt file: start from an empty doc rather than lose the new credentials
    doc.claudeAiOauth = { ...(doc.claudeAiOauth || {}), ...cred }
    const tmp = `${path}.${process.pid}.tmp`
    writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    rename(tmp, path)
  } catch { /* fail-open: a credential we cannot persist is a slow path, not a broken session */ }
}

/** Returns {token, error}. Never throws. */
export async function getAccessToken({
  dir, now, fetchImpl = fetch, readFile = readFileSync, writeFile = writeFileSync,
}) {
  const path = credentialsPath(dir)
  const cred = readCredentials(path, readFile)
  if (!cred) return { token: null, error: 'no-credentials' }
  if (!isExpired(cred, now)) return { token: cred.accessToken, error: null }

  const refreshed = await refreshToken(cred, { fetchImpl })
  if (!refreshed) return { token: null, error: 'refresh-failed' }
  writeBackCredentials(path, refreshed, { readFile, writeFile })
  return { token: refreshed.accessToken, error: null }
}
