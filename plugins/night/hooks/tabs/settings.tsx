import type { ElementTable } from 'claude-code'

import type { Draft, View } from '../../types'
import { fansLines } from '../words.mjs'

type Desktop = ElementTable<'desktop'>
/** What every surface hands the tab. */
export type Basic = Pick<Desktop, 'Box' | 'Text' | 'Button'>
/** The fields of a surface that has them: all but mobile. */
export type Fields = Pick<Desktop, 'Input' | 'Select'>

/** What the tab's controls do; register.tsx holds every call on `$`. */
export type SettingsActs = {
  /** One edit of From or To, kept until Save. */
  type: (which: 'from' | 'to', text: string) => void
  /** Save the window, with the field Enter was pressed in as typed. */
  save: (typed?: { which: 'from' | 'to'; text: string }) => void
  sessions: (value: string) => void
  project: (name: string, on: boolean) => void
}

const SESSIONS = ['1', '2', '3', '4'].map((value) => ({ value, label: value }))

export function settings(el: Basic, fields: Fields | null, view: View, draft: Draft, act: SettingsActs) {
  const { Box, Text, Button } = el
  const from = draft.from ?? view.window.from
  const to = draft.to ?? view.window.to

  let window
  if (fields === null) {
    window = (
      <Box key="window">
        <Text>{`From ${from} to ${to}, ${view.sessions} ${view.sessions === 1 ? 'session' : 'sessions'}. These are changed on the desktop or in a terminal.`}</Text>
      </Box>
    )
  } else {
    const { Input, Select } = fields
    window = (
      <Box key="window" flexDirection="column" gap={1}>
        <Box key="times" gap={2} flexWrap="wrap" alignItems="flex-end">
          <Input key="from" label="From" placeholder="23:30" value={from} submitLabel="save" onInput={(text) => act.type('from', text)} onSubmit={(text) => act.save({ which: 'from', text })} />
          <Input key="to" label="To" placeholder="06:30" value={to} submitLabel="save" onInput={(text) => act.type('to', text)} onSubmit={(text) => act.save({ which: 'to', text })} />
          <Button key="save-window" label="Save" variant="primary" onPress={() => act.save()} />
        </Box>
        <Select key="sessions" label="Sessions" options={SESSIONS} value={String(view.sessions)} onSelect={(value) => act.sessions(value)} />
      </Box>
    )
  }

  return (
    <Box key="settings" flexDirection="column" gap={1}>
      {window}
      <Box key="projects" flexDirection="column">
        <Text bold>Projects</Text>
        {view.projects.length === 0 && <Text dimColor>No open project with a git repository was found.</Text>}
        {view.projects.map((project) => (
          <Box key={`row-${project.name}`} gap={1} justifyContent="space-between" alignItems="center">
            <Box gap={1}>
              <Text>{project.name}</Text>
              <Text dimColor>{project.status}</Text>
            </Box>
            <Button
              key={`project-${project.name}`}
              label={project.on ? 'On' : 'Off'}
              variant={project.on ? 'primary' : 'secondary'}
              onPress={() => act.project(project.name, !project.on)}
            />
          </Box>
        ))}
      </Box>
      <Box key="fans" flexDirection="column">
        {fansLines(view.fans).map((line, i) => (i === 0 ? <Text>{line}</Text> : <Text dimColor>{line}</Text>))}
      </Box>
    </Box>
  )
}
