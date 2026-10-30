import type { Tips, View } from '../../types'
import { textCard } from '../charts.mjs'
import { count } from '../format.mjs'
import { observations } from '../notes.mjs'
import { card } from './parts.tsx'
import type { Desktop } from './parts.tsx'

/** `onAsk` starts the model call; this module never sees `$`. */
export function tips(el: Desktop, view: View, advice: Tips, onAsk: () => void) {
  const { Box, Text, Button, Markdown } = el
  const key = `${view.range.id}:${view.range.to}`
  const mine = advice.for === key ? advice : null
  const plain = observations(view)

  return (
    <Box flexDirection="column" gap={1}>
      {card(el, 'observations', textCard({ eyebrow: 'What the numbers say', lines: plain }), plain.length > 0 ? plain.join(' ') : 'No activity in this range.')}
      <Box key="tips-ask" flexDirection="column">
        <Text bold>A second reading</Text>
        <Text dimColor>
          Claude Haiku reads the numbers above and writes a few suggestions. Only numbers are sent: project names are replaced by placeholders
          first, and session titles are left out.
        </Text>
        <Button key="tips-write" label={mine?.status === 'ready' ? 'Write them again' : 'Write suggestions'} variant="primary" onPress={onAsk} />
      </Box>
      {mine?.status === 'loading' && (
        <Box key="tips-loading">
          <Text>Asking Claude…</Text>
        </Box>
      )}
      {mine?.status === 'error' && (
        <Box key="tips-error">
          <Text bold>{`No suggestions this time: ${mine.text ?? 'unknown reason'}`}</Text>
        </Box>
      )}
      {mine?.status === 'ready' && mine.text !== null && (
        <Box key="tips-text" flexDirection="column">
          <Markdown text={mine.text} />
          <Text dimColor>{mine.tokens === null ? 'Written earlier today.' : `Written with ${count(mine.tokens)} tokens.`}</Text>
        </Box>
      )}
    </Box>
  )
}
