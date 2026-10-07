// Brings the store up to date with the transcripts on disk: rescans the files
// that changed and folds the files that are gone into the frozen total.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { createScanner, SCAN_VERSION } from './scan.mjs'
import { foldFile, upsertFile } from './store.mjs'

/**
 * Every `*.jsonl` under `root`, or null when `root` does not exist. A folder
 * deleted while we walk is simply not there; any other failure is thrown,
 * because a folder we could not read must never look like deleted files.
 */
export function listTranscripts(root) {
  const found = []
  let isRootMissing = false

  const walk = (dir, isRoot) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      if (isRoot) isRootMissing = true
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, false)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let stat
        try {
          stat = statSync(path)
        } catch (err) {
          if (err.code === 'ENOENT') continue
          throw err
        }
        found.push({ rel: relative(root, path).split(sep).join('/'), path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }

  walk(root, true)
  if (isRootMissing) return null
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * What a transcript is known by: its path below the project folder. The project
 * folder is named after a working directory, so renaming a project and moving
 * its transcripts along changes the path and nothing else. Keyed by the full
 * path, the old one would be folded and the new one counted again.
 */
export function identityOf(rel) {
  const slash = rel.indexOf('/')
  return slash === -1 ? rel : rel.slice(slash + 1)
}

/** Reads one transcript as a stream: some are tens of megabytes. */
export async function scanFile(path, options) {
  const scanner = createScanner(options)
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) scanner.push(line)
  return scanner.finish()
}

/**
 * @param {{ home: string, clock: Function, zone: string, scan?: Function }} options
 *   `zone` names the time zone `clock` works in; it is remembered with the summaries
 * @returns {Promise<{ scanned: number, kept: number, folded: number, vanished: number, duplicates: number }>}
 *   `duplicates` is the number of transcripts found at more than one path
 */
export async function updateStore(store, root, { home, clock, zone, scan = scanFile }) {
  // A fold cannot be undone. A store pointed at another folder would see every
  // file as deleted, fold them all, and count them a second time when pointed back.
  if (store.root !== null && store.root !== root) {
    throw new Error(`the saved history was built from ${store.root}, not ${root}`)
  }
  const onDisk = listTranscripts(root)
  const result = { scanned: 0, kept: 0, folded: 0, vanished: 0, duplicates: 0 }
  if (onDisk === null) {
    if (Object.keys(store.files).length > 0) throw new Error(`the transcripts folder is missing: ${root}`)
    return result
  }
  store.root = root

  // Summaries made by another version of the scanner, or bucketed into the days
  // of another time zone, are all remade. What is already frozen stays as it was.
  const isOutdated = store.scan === null || store.scan.version !== SCAN_VERSION || store.scan.zone !== zone

  // Several paths can be one transcript: a copied project folder, or one renamed
  // under a running session. Transcripts only grow, so the largest holds what the
  // others do, and it alone is counted.
  const chosen = new Map()
  const copies = new Map() // key -> how many paths claim to be that transcript
  for (const file of onDisk) {
    const key = identityOf(file.rel)
    copies.set(key, (copies.get(key) ?? 0) + 1)
    const best = chosen.get(key)
    if (best === undefined || file.size > best.size) chosen.set(key, file)
  }
  for (const count of copies.values()) if (count > 1) result.duplicates += 1

  const present = new Set()
  for (const [key, file] of chosen) {
    const known = Object.hasOwn(store.files, key) ? store.files[key] : null
    if (!isOutdated && known !== null && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      present.add(key)
      result.kept += 1
      continue
    }
    // A file smaller than the one already summarised is not that file: it is a
    // stale copy that outlived the larger one. The fuller summary stays, and is
    // folded once this copy is gone as well.
    if (!isOutdated && known !== null && file.size < known.size) {
      present.add(key)
      result.kept += 1
      continue
    }
    const kind = file.rel.split('/').includes('subagents') ? 'sub' : 'main'
    let summary
    try {
      summary = await scan(file.path, { kind, fileId: basename(file.rel, '.jsonl'), home, clock })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // Deleted between the listing and the read. If we knew it, it is folded below,
      // unless another copy was listed: then the transcript is not gone, and folding
      // it would have the next run count that copy on top of the frozen one.
      result.vanished += 1
      if (copies.get(key) > 1) {
        present.add(key)
        if (known !== null) result.kept += 1
      }
      continue
    }
    present.add(key)
    upsertFile(store, key, file, summary)
    result.scanned += 1
  }

  for (const key of Object.keys(store.files)) {
    if (present.has(key)) continue
    foldFile(store, key)
    result.folded += 1
  }
  store.scan = { version: SCAN_VERSION, zone }
  return result
}
