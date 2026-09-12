import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { normalise, fetchUsage, getGauges, USAGE_URL, rawCachePath } from '../usage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', `${n}.json`), 'utf8'))

/** A non-expired credentials file so getAccessToken resolves a token without ever
 *  calling fetchImpl itself — leaving fetchImpl free to stand in for fetchUsage only. */
function withCreds(dir, now) {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: now + 999_999_999 },
  }))
}

test('utilization becomes percent and resets_at becomes resetsAt', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.five_hour.percent, 35)
  assert.equal(g.five_hour.resetsAt, '2026-09-11T20:00:00Z')
  assert.equal(g.seven_day.percent, 81)
})

test('money is decoded from minor units, never shown raw', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.extra_usage.percent, 84.13333333333334)
  assert.equal(g.extra_usage.usedMinor, 5048)
  assert.equal(g.extra_usage.limitMinor, 6000)
  assert.equal(g.extra_usage.currency, 'EUR')
  assert.equal(g.extra_usage.decimals, 2)
})

test('null gauges normalise to null, not to zero', () => {
  const g = normalise(fixture('usage-sparse'))
  assert.equal(g.seven_day, null)
  assert.equal(g.extra_usage, null)
  assert.equal(g.five_hour.percent, 1)
})

test('the scoped bucket is collected with its model name', () => {
  const g = normalise(fixture('usage-max'))
  assert.equal(g.scoped.length, 1)
  assert.equal(g.scoped[0].model, 'Fable')
  assert.equal(g.scoped[0].percent, 4)
})

test('an unrecognised payload yields empty gauges rather than throwing', () => {
  assert.deepEqual(normalise(null).scoped, [])
  assert.equal(normalise({}).five_hour, null)
  assert.equal(normalise('nonsense').five_hour, null)
})

test('fetchUsage sends the oauth beta header to the usage endpoint', async () => {
  let seen
  await fetchUsage({
    token: 't',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({}) } },
  })
  assert.equal(seen.url, USAGE_URL)
  assert.equal(seen.opts.headers.Authorization, 'Bearer t')
  assert.equal(seen.opts.headers['anthropic-beta'], 'oauth-2025-04-20')
})

test('a non-ok response reports an error instead of throwing', async () => {
  const r = await fetchUsage({ token: 't', fetchImpl: async () => ({ ok: false, status: 429 }) })
  assert.equal(r.raw, null)
  assert.match(r.error, /429/)
})

// Added beyond the brief's Step 1 test list: none of the brief's 7 tests ever call
// getGauges, so the single most important behaviour in the task ("blind must be true
// whenever there is no usable data") had zero coverage. Verified by mutation per the
// task's Step 5: with `blind: true` changed to `blind: false` on the no-credentials
// path, all 7 brief tests still passed — only this test catches it.
test('getGauges is blind when there is no cache and no credentials', async () => {
  // Isolated, empty temp dir standing in for CLAUDE_CONFIG_DIR — never the real
  // ~/.claude, and it holds no .credentials.json or cache file.
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  let fetchCalled = false
  let result
  try {
    result = await getGauges({
      dir,
      now: Date.now(),
      fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(result.blind, true)
  assert.equal(result.gauges, null)
  assert.equal(fetchCalled, false) // no token available, so fetchUsage must never be reached
})

test('a failure suppresses an immediate retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  let fetchCount = 0
  const failingFetch = async () => { fetchCount++; return { ok: false, status: 500 } }
  try {
    const first = await getGauges({ dir, now, fetchImpl: failingFetch })
    assert.equal(first.blind, true)
    assert.equal(fetchCount, 1)

    const second = await getGauges({ dir, now: now + 1000, fetchImpl: failingFetch })
    assert.equal(second.blind, true)
    assert.equal(second.reason, first.reason)
    assert.equal(fetchCount, 1, 'a call inside the backoff window must never re-hit the network')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the suppression expires and the next call retries normally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  try {
    await getGauges({ dir, now, fetchImpl: async () => ({ ok: false, status: 500 }) })

    let fetchCalled = false
    const result = await getGauges({
      dir, now: now + 30_001, // one generic (non-429) backoff period plus a millisecond
      fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => fixture('usage-max') } },
    })
    assert.equal(fetchCalled, true, 'the network must be retried once the backoff window has elapsed')
    assert.equal(result.blind, false)
    assert.equal(result.fresh, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a 429 backs off longer than a generic error', async () => {
  const dir429 = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const dirGeneric = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir429, now)
  withCreds(dirGeneric, now)
  try {
    await getGauges({ dir: dir429, now, fetchImpl: async () => ({ ok: false, status: 429 }) })
    await getGauges({ dir: dirGeneric, now, fetchImpl: async () => ({ ok: false, status: 500 }) })

    // Past the generic backoff (30s) but well inside the 429 backoff (5min).
    const later = now + 31_000
    let genericFetchCalled = false
    let retry429Called = false
    await getGauges({
      dir: dirGeneric, now: later,
      fetchImpl: async () => { genericFetchCalled = true; return { ok: true, json: async () => ({}) } },
    })
    await getGauges({
      dir: dir429, now: later,
      fetchImpl: async () => { retry429Called = true; return { ok: true, json: async () => ({}) } },
    })
    assert.equal(genericFetchCalled, true, 'a generic failure must have backed off by now')
    assert.equal(retry429Called, false, 'a 429 must still be backing off at the same elapsed time')
  } finally {
    rmSync(dir429, { recursive: true, force: true })
    rmSync(dirGeneric, { recursive: true, force: true })
  }
})

// model-advisor's whole safety story rests on getGauges NEVER leaking limits[] into
// usage-guard's path just because model-advisor asked for it moments earlier. Both plugins
// share the same on-disk cache directory, so this has to be proven from a live network
// fetch (the shape a real success return takes), not merely from an empty-dir blind path.
test('getGauges without wantRaw has no raw key, even after a live fetch populates the raw cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  try {
    const result = await getGauges({ dir, now, fetchImpl: async () => ({ ok: true, json: async () => fixture('usage-max') }) })
    assert.equal(Object.hasOwn(result, 'raw'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wantRaw on a live fetch returns the raw limits[] payload and persists it to its own cache file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  try {
    const result = await getGauges({
      dir, now, wantRaw: true,
      fetchImpl: async () => ({ ok: true, json: async () => fixture('usage-max') }),
    })
    assert.ok(Array.isArray(result.raw?.limits))
    assert.equal(result.raw.limits[1].kind, 'weekly_scoped')
    const onDisk = JSON.parse(readFileSync(rawCachePath(dir), 'utf8'))
    assert.deepEqual(onDisk.data, fixture('usage-max'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The raw-cache write on a successful fetch is deliberately unconditional (not gated on
// wantRaw) precisely so this scenario works: usage-guard and model-advisor both hook
// UserPromptSubmit and share this same cache directory, and whichever one's hook fires
// first — here, usage-guard's plain call, which never asks for raw — still leaves a raw
// cache the other can read. Without the unconditional write, model-advisor would see
// raw: null for a full TTL window every time usage-guard's hook wins the race, which is
// the common case whenever both plugins are installed.
test('a plain getGauges() fetch feeds a later wantRaw:true call within the same TTL, without fetching twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  let fetchCount = 0
  const fetchImpl = async () => { fetchCount++; return { ok: true, json: async () => fixture('usage-max') } }
  try {
    const first = await getGauges({ dir, now, fetchImpl }) // usage-guard's own call: no wantRaw
    assert.equal(Object.hasOwn(first, 'raw'), false, 'sanity check: this call never asked for raw')

    const second = await getGauges({ dir, now: now + 1, wantRaw: true, fetchImpl }) // model-advisor's call, moments later

    assert.equal(fetchCount, 1, 'the second call must reuse the raw cache the first call left, not fetch again')
    assert.ok(Array.isArray(second.raw?.limits))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wantRaw on a fresh gauge-cache hit reads raw back from its own cache file, without touching the network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  try {
    await getGauges({ dir, now, wantRaw: true, fetchImpl: async () => ({ ok: true, json: async () => fixture('usage-max') }) })

    let fetchCalled = false
    const result = await getGauges({
      dir, now: now + 1, wantRaw: true,
      fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } },
    })
    assert.equal(result.fresh, true, 'sanity check: the gauge cache must be a fresh hit for this test to mean anything')
    assert.equal(fetchCalled, false)
    assert.ok(Array.isArray(result.raw?.limits))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Brief: "If the raw cache is missing or stale while the gauge cache is fresh, return
// raw: null — the advisor treats that as no buckets and stays silent." Simulated here by
// deleting the raw cache file after it was written, while the gauge cache is still fresh.
test('wantRaw returns null when the raw cache is missing but the gauge cache is still fresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  try {
    await getGauges({ dir, now, wantRaw: true, fetchImpl: async () => ({ ok: true, json: async () => fixture('usage-max') }) })
    rmSync(rawCachePath(dir), { force: true })

    const result = await getGauges({ dir, now: now + 1, wantRaw: true, fetchImpl: async () => { throw new Error('must not be called') } })
    assert.equal(result.fresh, true)
    assert.equal(result.raw, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cached failure yields blind: true and never touches the network while active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  const now = Date.now()
  withCreds(dir, now)
  let fetchCalled = false
  try {
    // Seed the failure record directly, exactly as getGauges itself would have written it.
    await getGauges({ dir, now, fetchImpl: async () => ({ ok: false, status: 500 }) })

    const result = await getGauges({
      dir, now: now + 500,
      fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } },
    })
    assert.equal(result.blind, true)
    assert.equal(result.gauges, null)
    assert.equal(fetchCalled, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
