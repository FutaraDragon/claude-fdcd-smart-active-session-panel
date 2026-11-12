import type { ClientModule } from 'claude-code'

// The click layer over one folder row (the row itself is an SVG in register.tsx). Draws
// nothing at rest; on hover a ↻ shows at the right end. A click on ↻ posts { reroll: id },
// anywhere else posts { pick: id }.
export type FolderProps = {
  id: string
  color?: string
}

type FolderState = { hover: boolean }

const REROLL_COLUMNS = 3 // " ↻ " at the right end of the row

const Folder: ClientModule<FolderProps, FolderState> = (p, surface) => {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    surface.setState({ hover: false })
    surface.onPointer(e => {
      if (e.type === 'enter') surface.setState({ hover: true })
      if (e.type === 'leave') surface.setState({ hover: false })
      if (e.type === 'up' && e.button === 'left') {
        surface.post(e.x >= surface.columns - REROLL_COLUMNS ? { reroll: p.id } : { pick: p.id })
      }
    })
  }
  const hover = surface.state?.hover ?? false

  return (
    <Box flexDirection="row" justifyContent="flex-end">
      {hover ? <Text color={p.color}>{' ↻ '}</Text> : <Text>{' '}</Text>}
    </Box>
  )
}

export default Folder
