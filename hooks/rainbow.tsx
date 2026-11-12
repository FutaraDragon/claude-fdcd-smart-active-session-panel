import type { ClientModule } from 'claude-code'

// Easter egg: a usage bar at 100% loops a fast rainbow
const COLORS = ['#ff4d4d', '#ffa64d', '#ffee4d', '#5cff4d', '#4dc3ff', '#a64dff', '#ff4dd2']

const Rainbow: ClientModule<null, { i: number }> = (_p, surface) => {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ i: 0 })
    // From the wall clock, not a counter, so the bar ends (SMIL in register.tsx, begun at the
    // same clock offset) show the same color
    surface.every(15, () => {
      const i = Math.floor(Date.now() / 110) % COLORS.length
      if (i !== surface.state?.i) surface.setState({ i })
    })
  }
  return <Box flexGrow={1} backgroundColor={COLORS[surface.state?.i ?? 0]} />
}

export default Rainbow
