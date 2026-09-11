#!/usr/bin/env node
import { readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Copies every top-level .mjs from coreDir into targetLibDir. Returns copied filenames. */
export function vendorCore(coreDir, targetLibDir) {
  mkdirSync(targetLibDir, { recursive: true })
  const copied = []
  for (const name of readdirSync(coreDir)) {
    if (!name.endsWith('.mjs')) continue
    if (statSync(join(coreDir, name)).isDirectory()) continue
    copyFileSync(join(coreDir, name), join(targetLibDir, name))
    copied.push(name)
  }
  return copied
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const core = join(root, 'packages', 'core')
  for (const plugin of readdirSync(join(root, 'plugins'))) {
    const lib = join(root, 'plugins', plugin, 'lib')
    const copied = vendorCore(core, lib)
    console.log(`vendored ${copied.length} modules into plugins/${plugin}/lib/`)
  }
}
