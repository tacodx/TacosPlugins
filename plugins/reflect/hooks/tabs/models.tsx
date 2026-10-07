import type { View } from '../../types'
import { shareBar, stackedColumnChart } from '../charts.mjs'
import { count, modelName, percent, tokens } from '../format.mjs'
import { columnsOf, withOther } from '../shape.mjs'
import { chart, pair, tile } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function models(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const named = view.models.slice(0, 4).map((each) => each.name)
  const hasOther = view.models.length > named.length
  const series = hasOther ? [...named, 'Other'] : named
  const since = view.coverage.transcriptsFrom
  const tokenDays = since === null ? view.days : view.days.filter((each) => each.day >= since)
  // A day's models arrive with everything past the top six already folded into "other".
  const perDay = columnsOf(tokenDays, (each) => {
    const values: Record<string, number> = {}
    for (const [name, out] of Object.entries(each.models)) {
      const key = named.includes(name) ? name : 'Other'
      values[key] = (values[key] ?? 0) + out
    }
    return values
  })
  const read = t.cacheR + t.cacheW + t.inp

  return (
    <Box flexDirection="column" gap={1}>
      {chart(el, 'share', 'Share of output tokens', shareBar(withOther(view.models, 4, (each) => each.out, (each) => modelName(each.name)), tokens), `Share of output tokens by model, ${tokens(t.out)} in all`)}
      {chart(el, 'per-day', 'Output tokens over time, by model', stackedColumnChart(perDay, series, tokens, (name) => (name === 'Other' ? name : modelName(name))), 'Output tokens over time, stacked by model')}
      {pair(
        el,
        tile(el, 'cache', 'Cache hit rate', t.cacheHitRate === null ? 'n/a' : percent(t.cacheHitRate), `of ${tokens(read)} tokens read`),
        tile(el, 'fresh', 'Read uncached', tokens(t.inp + t.cacheW), `${tokens(t.cacheW)} of it written to the cache`),
      )}
      {chart(el, 'replies', 'Replies by model', shareBar(withOther(view.models, 4, (each) => each.msgs, (each) => modelName(each.name)), count), `Replies by model, ${count(t.msgs + t.subMsgs)} in all`)}
      {chart(el, 'efforts', 'Replies by effort level', shareBar(withOther(view.efforts, 4, (each) => each.n), count), 'Replies by effort level')}
    </Box>
  )
}
