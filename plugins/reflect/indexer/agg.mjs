// Shapes and arithmetic for per-day aggregates.
//
// The keys of the count maps come from the data: tool names, model names,
// project folders. A plain property read cannot be trusted with them, because
// `map.constructor` is a function on every object, so all access goes through
// `own` and `bump`.

const NUMERIC = ['prompts', 'msgs', 'subMsgs', 'out', 'inp', 'cacheR', 'cacheW', 'activeMs']
const COUNT_MAPS = ['tools', 'skills', 'mcp', 'efforts']
const MODEL_FIELDS = ['msgs', 'out', 'inp', 'cacheR', 'cacheW']

// Assigning to `__proto__` on a plain object sets its prototype instead of a key.
const safeKey = (key) => (key === '__proto__' ? '(__proto__)' : String(key))

/** The value under `key`, created with `make()` when the map has no such key of its own. */
export function own(map, key, make) {
  const name = safeKey(key)
  if (!Object.hasOwn(map, name)) map[name] = make()
  return map[name]
}

export function bump(map, key, n = 1) {
  const name = safeKey(key)
  map[name] = (Object.hasOwn(map, name) ? map[name] : 0) + n
}

export function addCounts(target, source) {
  for (const [key, n] of Object.entries(source)) bump(target, key, n)
}

export const emptyModel = () => ({ msgs: 0, out: 0, inp: 0, cacheR: 0, cacheW: 0 })

/** What the scanner keeps for one file on one local day. */
export function emptyDay() {
  return {
    prompts: 0,
    hours: new Array(24).fill(0),
    msgs: 0,
    subMsgs: 0,
    out: 0,
    inp: 0,
    cacheR: 0,
    cacheW: 0,
    activeMs: 0,
    models: {},
    tools: {},
    skills: {},
    mcp: {},
    efforts: {},
  }
}

/** One day across every file: a day aggregate plus who contributed to it. */
export function emptyMergedDay() {
  return { ...emptyDay(), sessions: 0, projects: {} }
}

/**
 * Adds one file's summary into a map of merged days. This is the only place
 * that knows how a file contributes to a day, so a file folded into the frozen
 * total and a file still on disk cannot be counted differently.
 */
export function addSummary(days, summary) {
  for (const [day, agg] of Object.entries(summary.days)) {
    const target = own(days, day, emptyMergedDay)
    for (const field of NUMERIC) target[field] += agg[field]
    for (let hour = 0; hour < 24; hour += 1) target.hours[hour] += agg.hours[hour]
    for (const field of COUNT_MAPS) addCounts(target[field], agg[field])
    for (const [model, usage] of Object.entries(agg.models)) {
      const sum = own(target.models, model, emptyModel)
      for (const field of MODEL_FIELDS) sum[field] += usage[field]
    }
    const project = own(target.projects, summary.project, () => ({ prompts: 0, out: 0, sessions: 0 }))
    project.prompts += agg.prompts
    project.out += agg.out
    if (summary.kind === 'main') {
      target.sessions += 1
      project.sessions += 1
    }
  }
}
