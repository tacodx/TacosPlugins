import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
  if (!Number.isFinite(cred?.expiresAt)) return true // missing/zero/null/NaN expiry: treat as already-expired, never as "never expires"
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

/**
 * Read-modify-write. Preserves every sibling key, notably mcpOAuth. Never throws.
 * Refuses to write at all unless it can prove the target is either genuinely absent
 * (ENOENT) or a readable, parseable, object-shaped document — an unreadable or corrupt
 * file must never be silently replaced with just {claudeAiOauth}, since that would
 * destroy sibling keys we could not actually inspect.
 */
export function writeBackCredentials(path, cred, {
  readFile = readFileSync, writeFile = writeFileSync, rename = renameSync,
  remove = unlinkSync, uuid = randomUUID,
} = {}) {
  let raw
  try {
    raw = readFile(path, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') return // unreadable (EACCES, EMFILE, a read racing another writer, etc.): never overwrite what we couldn't confirm is safe to replace
    raw = null // file genuinely does not exist yet; starting from an empty doc is safe
  }

  let doc = {}
  if (raw !== null) {
    let parsed
    try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) } // strip a UTF-8 BOM before parsing; some tools write one
    catch { return } // existing file is corrupt/unparseable: refuse to blindly overwrite it
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return // not a credentials-document shape: refuse to overwrite
    doc = parsed
  }

  doc.claudeAiOauth = { ...(doc.claudeAiOauth || {}), ...cred }
  const tmp = `${path}.${process.pid}.${uuid()}.tmp`
  try {
    // 'wx' guarantees this call always creates the file, so `mode` is always applied —
    // reusing an existing (possibly world-readable) leftover tmp file would silently keep its old mode.
    writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600, flag: 'wx' })
    rename(tmp, path)
  } catch { // fail-open: a credential we cannot persist is a slow path, not a broken session
    try { remove(tmp) } catch { /* tmp may never have been created (writeFile itself failed); nothing to clean up */ }
  }
}

/** Returns {token, error}. Never throws. */
export async function getAccessToken({
  dir, now, fetchImpl = fetch, readFile = readFileSync, writeFile = writeFileSync,
  rename = renameSync, remove = unlinkSync,
}) {
  const path = credentialsPath(dir)
  const cred = readCredentials(path, readFile)
  if (!cred) return { token: null, error: 'no-credentials' }
  if (!isExpired(cred, now)) return { token: cred.accessToken, error: null }

  const refreshed = await refreshToken(cred, { fetchImpl })
  // a dead token that still happens to work beats returning null and guaranteeing failure
  if (!refreshed) return { token: cred.accessToken, error: 'refresh-failed-using-existing' }
  writeBackCredentials(path, refreshed, { readFile, writeFile, rename, remove })
  return { token: refreshed.accessToken, error: null }
}
