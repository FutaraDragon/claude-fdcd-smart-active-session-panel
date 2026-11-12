import type { ClientModule } from 'claude-code'

// An invisible click layer over an SVG label: posts its message on a left click
export type HitProps = { message: Record<string, string> }

const Hit: ClientModule<HitProps, { ready: boolean }> = (p, surface) => {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ready: true })
    surface.onPointer(e => {
      if (e.type === 'up' && e.button === 'left') surface.post(p.message)
    })
  }
  return <Box />
}

export default Hit
