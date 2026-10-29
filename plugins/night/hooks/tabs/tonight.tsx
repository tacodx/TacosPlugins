import type { ElementTable } from 'claude-code'

import type { View } from '../../types'
import { tonightAlt, tonightCard } from '../card.mjs'
import { summary } from '../words.mjs'

type Desktop = ElementTable<'desktop'>
/** What a surface that draws SVG hands the tab. */
export type Drawn = Pick<Desktop, 'Box' | 'Svg' | 'Link'>
/** What every surface hands the tab. */
export type Plain = Pick<Desktop, 'Box' | 'Text' | 'Link'>

/** Tonight as one drawing, and the recap's page below it when there is one. */
export function tonightDrawn(el: Drawn, view: View) {
  const { Box, Svg, Link } = el
  const said = summary(view)
  const url = said.recap?.url ?? null

  return (
    <Box key="tonight" flexDirection="column" gap={1}>
      <Box key="card-tonight">
        <Svg source={tonightCard(said)} alt={tonightAlt(said)} isInteractive />
      </Box>
      {url !== null && (
        <Box key="recap-link">
          <Link href={url} label="Open the recap" />
        </Box>
      )}
    </Box>
  )
}

/** Tonight as plain lines, for the terminal: the same words as the drawing. */
export function tonightPlain(el: Plain, view: View) {
  const { Box, Text, Link } = el
  const said = summary(view)
  const recap = said.recap

  return (
    <Box key="tonight" flexDirection="column" gap={1}>
      <Box key="phase" flexDirection="column">
        <Text bold>{said.phase}</Text>
        {said.noWorkers && <Text dimColor>No workers yet</Text>}
        {said.workers.map((worker) => (
          <Text>{worker.line}</Text>
        ))}
      </Box>
      <Box key="rows" flexDirection="column">
        {said.rows.map((row) =>
          row.isLate ? <Text color="warning">{`${row.label}: ${row.value}`}</Text> : <Text>{`${row.label}: ${row.value}`}</Text>,
        )}
      </Box>
      {recap !== null && (
        <Box key="recap" flexDirection="column">
          <Text bold>{`Last recap: ${recap.headline}`}</Text>
          {recap.lines.map((line) => (
            <Text>{line}</Text>
          ))}
          {recap.url !== null && <Link href={recap.url} label="Open the recap" />}
        </Box>
      )}
      {said.attention !== null && (
        <Box key="attention">
          <Text color="warning">{said.attention}</Text>
        </Box>
      )}
    </Box>
  )
}
