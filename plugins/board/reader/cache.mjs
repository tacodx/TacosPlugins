// What one run leaves for the next: each repo's commits under the key of its
// refs, and the colour each project was given. Nothing in it is precious: a
// cache that cannot be read is started again.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CACHE_FILE = 'cache.json'
export const CACHE_VERSION = 1

const fresh = () => ({ version: CACHE_VERSION, repos: {}, colours: {} })
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @returns {{ version: number, repos: Record<string, object>, colours: Record<string, number>, text: string | null }} */
export function readCache(dataDir) {
  let text
  try {
    text = readFileSync(join(dataDir, CACHE_FILE), 'utf8')
  } catch {
    return { ...fresh(), text: null }
  }
  try {
    const cache = JSON.parse(text)
    if (!isRecord(cache) || cache.version !== CACHE_VERSION || !isRecord(cache.repos) || !isRecord(cache.colours)) return { ...fresh(), text }
    return { version: CACHE_VERSION, repos: cache.repos, colours: cache.colours, text }
  } catch {
    return { ...fresh(), text }
  }
}

/** Writes the cache whole or not at all. Returns whether it was written. */
export function writeCache(dataDir, { repos, colours }) {
  const file = join(dataDir, CACHE_FILE)
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, repos, colours }))
    renameSync(temp, file)
    return true
  } catch {
    rmSync(temp, { force: true })
    return false
  }
}
