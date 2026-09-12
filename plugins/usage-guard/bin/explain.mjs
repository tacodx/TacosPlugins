#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { configDir, readConfig } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { decide } = await load('decide.mjs')
const { renderStatus } = await load('render.mjs')

const dir = configDir(process.env)
const sessionId = process.argv[2] || null
const cfg = readConfig({ dir, sessionId, readFile: readFileSync })
const { gauges, blind, reason, warning } = await getGauges({ dir, now: Date.now() })
const decision = blind ? null : decide(gauges, cfg.gauges)
console.log(renderStatus({ gauges, thresholds: cfg.gauges, decision, mode: cfg.mode, blind, reason, configUnreadable: cfg.configUnreadable, warning }))
