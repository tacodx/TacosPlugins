import type { ElementTable } from 'claude-code'

export type Desktop = ElementTable<'desktop'>

/** One headline number with what it is and one line about it. `id` lets a test find it. */
export function tile(el: Desktop, id: string, label: string, value: string, note: string) {
  const { Box, Text } = el

  return (
    <Box key={`tile-${id}`} flexDirection="column" flexGrow={1} minWidth={16}>
      <Text dimColor>{label}</Text>
      <Text bold>{value}</Text>
      <Text dimColor>{note}</Text>
    </Box>
  )
}

/** Two tiles side by side. */
export function pair(el: Desktop, left: unknown, right: unknown) {
  const { Box } = el

  return (
    <Box gap={2}>
      {left}
      {right}
    </Box>
  )
}

/** A titled drawing. `alt` is what the drawing says, for whoever cannot see it. */
export function chart(el: Desktop, id: string, title: string, source: string, alt: string) {
  const { Box, Text, Svg } = el

  return (
    <Box key={`chart-${id}`} flexDirection="column">
      <Text bold>{title}</Text>
      <Svg source={source} alt={alt} isInteractive />
    </Box>
  )
}

/** A titled list of sentences. */
export function lines(el: Desktop, id: string, title: string, items: string[]) {
  const { Box, Text } = el

  return (
    <Box key={`lines-${id}`} flexDirection="column">
      <Text bold>{title}</Text>
      {items.map((item) => (
        <Text>{item}</Text>
      ))}
    </Box>
  )
}
