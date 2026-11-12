import type { ClientModule } from 'claude-code'

// The click layer over one row of a session card (the row itself is SVG in register.tsx).
// On the title row a click on the pin posts { pin: id }, on the chevron { fold: id }; anywhere
// else, on any row, { open: id }.
export type CardProps = {
  id: string
  title: boolean // this layer lies over the title row
}

// The icons at the right of the title row, in columns from the right edge (the pin last).
// A 2-column pin zone also covered half the chevron, so opening an old pinned card unpinned it
// and it dropped out of the list (2026-10-27): the icons now have a column between them, and
// clicks read the exact position (`fine`) instead of whole columns
const PIN_COLUMNS = 1.6
const FOLD_COLUMNS = 4

const Card: ClientModule<CardProps, { ready: boolean }> = (p, surface) => {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ready: true })
    surface.onPointer(e => {
      if (e.type !== 'up' || e.button !== 'left') return
      const x = (e as any).fine?.x ?? e.x + 0.5
      if (p.title && x >= surface.columns - PIN_COLUMNS) surface.post({ pin: p.id })
      else if (p.title && x >= surface.columns - FOLD_COLUMNS) surface.post({ fold: p.id })
      else surface.post({ open: p.id })
    })
  }
  return <Box />
}

export default Card
