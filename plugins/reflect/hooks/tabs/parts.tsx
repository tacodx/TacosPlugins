import type { ElementTable } from 'claude-code'

export type Desktop = ElementTable<'desktop'>

/**
 * One drawing of the pane. `id` lets a test find it; `alt` is what the drawing
 * says, for whoever cannot see it.
 */
export function card(el: Desktop, id: string, source: string, alt: string) {
  const { Box, Svg } = el

  return (
    <Box key={`card-${id}`}>
      <Svg source={source} alt={alt} isInteractive />
    </Box>
  )
}
