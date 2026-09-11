import { join } from 'node:path'
import { getAccessToken } from './auth.mjs'
import { readCache, writeCache, withLock } from './cache.mjs'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

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
  } catch (err) {
    return { raw: null, error: err?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally { clearTimeout(timer) }
}

/**
 * Cache-first. Returns {gauges, blind, reason, fresh}.
 * blind=true means we have no usable data — callers MUST allow everything.
 */
export async function getGauges({
  dir, now, fetchImpl = fetch, ttlMs = 60_000, maxStaleMs = 900_000, timeoutMs = 3000,
}) {
  const cachePath = join(dir, 'tacos', 'usage-cache.json')
  const cached = readCache(cachePath, { now, ttlMs, maxStaleMs })
  if (cached?.fresh) return { gauges: cached.data, blind: false, reason: null, fresh: true }

  const { token, error: authError } = await getAccessToken({ dir, now, fetchImpl })
  if (!token) {
    if (cached) return { gauges: cached.data, blind: false, reason: authError, fresh: false }
    return { gauges: null, blind: true, reason: authError, fresh: false }
  }

  let result = { raw: null, error: 'skipped' }
  await withLock(`${cachePath}.lock`, async () => {
    result = await fetchUsage({ token, fetchImpl, timeoutMs })
  }, { now, staleMs: timeoutMs + 5000 })

  if (result.error) {
    if (cached) return { gauges: cached.data, blind: false, reason: result.error, fresh: false }
    return { gauges: null, blind: true, reason: result.error, fresh: false }
  }
  const gauges = normalise(result.raw)
  writeCache(cachePath, gauges, { now })
  return { gauges, blind: false, reason: null, fresh: true }
}
