import type { View } from '../../types'
import { shareCard, stackedCard, statCard } from '../charts.mjs'
import { count, modelName, percent, tokens } from '../format.mjs'
import { columnsOf, withOther } from '../shape.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

export function models(el: Desktop, view: View) {
  const { Box } = el
  const t = view.totals
  const named = view.models.slice(0, 4).map((each) => each.name)
  const series = view.models.length > named.length ? [...named, 'Other'] : named
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
      {card(
        el,
        'share',
        shareCard({ eyebrow: 'Output tokens', aside: tokens(t.out), parts: withOther(view.models, 4, (each) => each.out, (each) => modelName(each.name)), format: tokens }),
        `Share of output tokens by model, ${tokens(t.out)} in all`,
      )}
      {card(
        el,
        'per-day',
        stackedCard({ eyebrow: 'Output over time, by model', columns: perDay, names: series, format: tokens, nameOf: (name) => (name === 'Other' ? name : modelName(name)) }),
        'Output tokens over time, stacked by model',
      )}
      {card(
        el,
        'cache',
        statCard([
          { label: 'Cache hit rate', figure: t.cacheHitRate === null ? 'n/a' : percent(t.cacheHitRate), note: `of ${tokens(read)} tokens read` },
          { label: 'Read uncached', figure: tokens(t.inp + t.cacheW), note: `${tokens(t.cacheW)} written to cache` },
        ]),
        `${t.cacheHitRate === null ? 'No' : percent(t.cacheHitRate)} of ${tokens(read)} tokens read came from the prompt cache`,
      )}
      {card(
        el,
        'replies',
        shareCard({ eyebrow: 'Replies', aside: count(t.msgs + t.subMsgs), parts: withOther(view.models, 4, (each) => each.msgs, (each) => modelName(each.name)), format: count }),
        `Replies by model, ${count(t.msgs + t.subMsgs)} in all`,
      )}
      {card(el, 'efforts', shareCard({ eyebrow: 'Effort level', aside: 'replies', parts: withOther(view.efforts, 4, (each) => each.n), format: count }), 'Replies by effort level')}
    </Box>
  )
}
