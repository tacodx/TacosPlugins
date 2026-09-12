import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib')
const load = (m) => import(pathToFileURL(join(LIB, m)).href)
const { normaliseLimits, switchingHelps } = await load('buckets.mjs')
const { currentModel } = await load('current-model.mjs')
const { configDir } = await load('config.mjs')
const { getGauges } = await load('usage.mjs')
const { run, allowOutput, contextOutput } = await load('hookio.mjs')

/** Pure. This plugin informs; it can never deny. */
export function adviseForHook({ input, buckets, model }) {
  const { helps, reason } = switchingHelps(buckets, model)
  if (!helps) return { action: 'allow', text: null }
  return { action: 'context', text: `Model advice: ${reason}` }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) run(async (input) => {
  const dir = configDir(process.env)
  const { raw } = await getGauges({ dir, now: Date.now(), wantRaw: true })
  const buckets = normaliseLimits(raw)
  const model = currentModel({
    transcriptPath: input.transcript_path,
    settingsPath: join(dir, 'settings.json'),
  })
  const { action, text } = adviseForHook({ input, buckets, model })
  return action === 'context' ? contextOutput(input.hook_event_name, text) : allowOutput()
})
