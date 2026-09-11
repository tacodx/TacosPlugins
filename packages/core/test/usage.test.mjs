import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalise, fetchUsage, USAGE_URL } from '../usage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', `${n}.json`), 'utf8'))

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
