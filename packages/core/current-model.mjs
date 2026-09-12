import { readFileSync } from 'node:fs'

/** Pure. Last row wins; `<synthetic>` is not a real model. */
export function modelFromTranscript(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    let m
    try { m = JSON.parse(line)?.message?.model } catch { continue } // a partial or junk line tells us nothing
    if (typeof m === 'string' && m !== '' && m !== '<synthetic>') return m
  }
  return null
}

/** `claude-opus-5[1m]` -> `claude-opus-5`. */
export function stripSuffix(model) {
  if (typeof model !== 'string') return null
  const i = model.indexOf('[')
  return i === -1 ? model : model.slice(0, i)
}

/** Never throws. Returns null when the model cannot be determined — the caller stays silent. */
export function currentModel({ transcriptPath, settingsPath, readFile = readFileSync }) {
  const read = (p) => {
    try { return readFile(p, 'utf8') } catch { return null } // unreadable tells us nothing; fall through
  }
  if (transcriptPath) {
    const fromTranscript = modelFromTranscript(read(transcriptPath))
    if (fromTranscript) return stripSuffix(fromTranscript)
  }
  if (settingsPath) {
    const raw = read(settingsPath)
    try { return stripSuffix(JSON.parse(raw)?.model) || null }
    catch { return null } // unreadable or malformed settings tells us nothing
  }
  return null
}
