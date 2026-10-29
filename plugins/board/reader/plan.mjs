// The plan: the rows of one Markdown table, read from a file the config names.
//
// The table is the first one under the heading the config names (the first one
// in the file when it names none). A row's first cell is its number and its
// second its name; a row struck through (~~…~~) is done; a bold phrase that
// opens the third cell is its status, as in "**Started 2026-03-02.** …".
import { readFileSync, statSync } from 'node:fs'

import { expandHome } from './config.mjs'

// A plan is a page of text; anything this large is not one.
const MAX_BYTES = 1024 * 1024

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const isRow = (line) => /^\s*\|/.test(line)

/** Markdown down to the words: no emphasis, strike, code ticks or link targets. */
export function plain(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The cells of a table row, `\|` kept as a pipe inside its cell. */
function cells(line) {
  const parts = []
  let current = ''
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      current += '\\|'
      i += 1
    } else if (body[i] === '|') {
      parts.push(current.trim())
      current = ''
    } else {
      current += body[i]
    }
  }
  parts.push(current.trim())
  return parts
}

const isStruck = (cell) => /^~~.*~~$/.test(cell.trim())

/** The bold phrase a cell opens with, without its closing stop: "**Done 2026-03-05.** …" -> "Done 2026-03-05". */
function status(cell) {
  const match = /^(\*\*|__)(.+?)\1/.exec(cell.trim())
  return match ? plain(match[2]).replace(/[.,:;]+$/, '') : ''
}

/** A heading's words, for comparing with the section named in the config. */
const words = (text) => plain(text).replace(/:$/, '').trim().toLowerCase()

/**
 * @param {string} markdown
 * @param {string | null | undefined} section the heading's words, or nothing for the first table
 * @returns {{ rows: { id: string, name: string, done: boolean, note: string }[] } | { error: string }}
 */
export function parsePlan(markdown, section) {
  const lines = markdown.split(/\r?\n/)
  let start = 0
  // The heading level that ends the section; 0 where there is no section and nothing ends it.
  let level = 0
  if (section) {
    start = lines.findIndex((line) => {
      const heading = HEADING.exec(line)
      return heading !== null && words(heading[2]) === words(section)
    })
    if (start === -1) return { error: `there is no section "${section}"` }
    level = HEADING.exec(lines[start])[1].length
    start += 1
  }

  for (let i = start; i < lines.length; i += 1) {
    const heading = HEADING.exec(lines[i])
    if (heading !== null && heading[1].length <= level) break
    if (!isRow(lines[i]) || !SEPARATOR.test(lines[i + 1] ?? '')) continue

    const rows = []
    for (let j = i + 2; j < lines.length && isRow(lines[j]); j += 1) {
      const row = cells(lines[j])
      const [id, name] = row.length > 1 ? [row[0], row[1]] : ['', row[0]]
      rows.push({
        id: plain(id),
        name: plain(name),
        done: isStruck(name) || (row.length > 1 && isStruck(id)),
        note: row.length > 2 ? status(row[2]) : '',
      })
    }
    return { rows }
  }
  return { error: section ? `the section "${section}" has no table` : 'there is no table' }
}

/**
 * The plan the config names, read now.
 * @param {null | { file: string, section?: string }} plan
 * @returns {null | { file: string, rows: object[], done: number, total: number } | { file: string, error: string }}
 */
export function readPlan(plan, home) {
  if (plan === null) return null
  const file = expandHome(plan.file, home)
  let text
  try {
    if (statSync(file).size > MAX_BYTES) return { file, error: 'the file is too large to be a plan' }
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, error: 'the file could not be read' }
  }
  const parsed = parsePlan(text, plan.section)
  if ('error' in parsed) return { file, error: parsed.error }
  return { file, rows: parsed.rows, done: parsed.rows.filter((row) => row.done).length, total: parsed.rows.length }
}
