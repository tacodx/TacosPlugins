import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAccessToken } from './auth.mjs'
import { readCache, writeCache, withLock } from './cache.mjs'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export function failureCachePath(dir) {
  return join(dir, 'tacos', 'usage-failure.json')
}

// Spec §6: short backoff on a generic failure, longer backoff on repeated 429s.
const BACKOFF_MS = { 'http-429': 300_000 }
const DEFAULT_BACKOFF_MS = 30_000
const backoffFor = (reason) => BACKOFF_MS[reason] ?? DEFAULT_BACKOFF_MS

/** Raw `{reason, count, fetchedAt}`, or null if there is no record or it is unreadable. Never throws. */
function readFailureRecord(path, readFile = readFileSync) {
  try {
    const entry = JSON.parse(readFile(path, 'utf8'))
    if (!entry || typeof entry.fetchedAt !== 'number' || !entry.data?.reason) return null
    return { ...entry.data, fetchedAt: entry.fetchedAt }
  } catch { return null } // no failure recorded yet, or the file is unreadable/corrupt
}

/**
 * A failure record must never be mistaken for gauge data, so it lives in its own file.
 * Returns the record only while its own backoff window is still open; once elapsed it
 * is treated as absent so the next call retries the network normally.
 */
function activeFailure(path, now, readFile = readFileSync) {
  const record = readFailureRecord(path, readFile)
  if (!record) return null
  if (now - record.fetchedAt >= backoffFor(record.reason)) return null
  return record
}

/** Never throws — recording a failure is best-effort, same as the gauge cache itself. */
function recordFailure(path, now, reason, readFile = readFileSync) {
  const prior = readFailureRecord(path, readFile)
  writeCache(path, { reason, count: (prior?.count ?? 0) + 1 }, { now })
}

const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null)

function gauge(node) {
  const percent = num(node?.utilization)
  if (percent === null) return null
  return { percent, resetsAt: node?.resets_at ?? null }
}

/** Pure. Tolerates any payload shape. */
export function normalise(raw) {
  if (!raw || typeof raw !== 'object') {
    return { five_hour: null, seven_day: null, extra_usage: null, scoped: [] }
  }
  const extra = raw.extra_usage
  return {
    five_hour: gauge(raw.five_hour),
    seven_day: gauge(raw.seven_day),
    extra_usage: num(extra?.utilization) === null ? null : {
      percent: extra.utilization,
      resetsAt: extra.resets_at ?? null,
      usedMinor: num(extra.used_credits),
      limitMinor: num(extra.monthly_limit),
      currency: extra.currency ?? null,
      decimals: num(extra.decimal_places) ?? 2,
    },
    scoped: (Array.isArray(raw.limits) ? raw.limits : [])
      .filter((l) => l?.kind === 'weekly_scoped' && num(l.percent) !== null)
      .map((l) => ({
        model: l.scope?.model?.display_name ?? null,
        percent: l.percent,
        resetsAt: l.resets_at ?? null,
      })),
  }
}

/** Returns {raw, error}. Never throws. */
export async function fetchUsage({ token, fetchImpl = fetch, timeoutMs = 3000 }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ac.signal,
    })
    if (!res?.ok) return { raw: null, error: `http-${res?.status ?? 'unknown'}` }
    return { raw: await res.json(), error: null }
  } catch (err) { // fail-open: a timed-out or unreachable usage endpoint is a stale-cache path, not a broken hook
    return { raw: null, error: err?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally { clearTimeout(timer) }
}

/**
 * Cache-first. Returns {gauges, blind, reason, fresh, warning}.
 * blind=true means we have no usable data — callers MUST allow everything.
 * warning is set independently of blind/reason — e.g. 'refresh-not-persisted' when a
 * token refresh succeeded (so this call still has a good token) but its write-back to
 * disk failed, which callers should still surface even though nothing here is blind.
 */
export async function getGauges({
  dir, now, fetchImpl = fetch, ttlMs = 60_000, maxStaleMs = 900_000, timeoutMs = 3000,
}) {
  const cachePath = join(dir, 'tacos', 'usage-cache.json')
  const failurePath = failureCachePath(dir)
  const cached = readCache(cachePath, { now, ttlMs, maxStaleMs })
  if (cached?.fresh) return { gauges: cached.data, blind: false, reason: null, fresh: true, warning: null }

  // A recent failure is still backing off: skip credential read and network entirely,
  // and answer exactly as a fresh failure would (stale cache if any, else blind).
  const failure = activeFailure(failurePath, now)
  if (failure) {
    if (cached) return { gauges: cached.data, blind: false, reason: failure.reason, fresh: false, warning: null }
    return { gauges: null, blind: true, reason: failure.reason, fresh: false, warning: null }
  }

  const { token, error: authError } = await getAccessToken({ dir, now, fetchImpl })
  if (!token) {
    recordFailure(failurePath, now, authError)
    if (cached) return { gauges: cached.data, blind: false, reason: authError, fresh: false, warning: null }
    return { gauges: null, blind: true, reason: authError, fresh: false, warning: null }
  }
  // A token was obtained even when authError is 'refresh-not-persisted' (the refreshed
  // access token is still good to use) — carry that warning forward regardless of how
  // the rest of this call turns out, rather than dropping it now that token is truthy.
  const warning = authError === 'refresh-not-persisted' ? authError : null

  let result = { raw: null, error: 'skipped' }
  await withLock(`${cachePath}.lock`, async () => {
    result = await fetchUsage({ token, fetchImpl, timeoutMs })
  }, { now, staleMs: timeoutMs + 5000 })

  if (result.error) {
    recordFailure(failurePath, now, result.error)
    if (cached) return { gauges: cached.data, blind: false, reason: result.error, fresh: false, warning }
    return { gauges: null, blind: true, reason: result.error, fresh: false, warning }
  }
  const gauges = normalise(result.raw)
  writeCache(cachePath, gauges, { now })
  return { gauges, blind: false, reason: null, fresh: true, warning }
}
