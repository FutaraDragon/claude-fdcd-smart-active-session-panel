import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecentSession, SessionInfo, TaskInfo, UsageLimit } from '../types'
import type { CardProps } from './card'

const PANE = 'fdcd-smart-active-session-panel'
// Shown at the top right. A mod is not told its own manifest version, so it is written here;
// the build checks it matches plugin.json
const VERSION = '1.5.0'
const SERVER = 'ccd_session_mgmt'
const REFRESH_MS = 5_000

const sessions = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'sessions' } as const, [])
const updatedAt = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'updatedAt' } as const, '')
const error = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'error' } as const, '')
// Group filter: 'all', or one group's id
const filter = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'filter' } as const, 'all')
// Group id → color like '#4fa3e0'; made once, kept in $.store so every session shows the same
const groupColors = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'groupColors' } as const, {})
const COLORS_KEY = 'groupColors'
// Our own pin: a pinned session stays in the list however old it is. Saved in $.store, so
// every session's panel shares the same pins.
const pins = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'pins' } as const, [])
const PINS_KEY = 'pins'
const sortMode = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'sortMode' } as const, 'pinned')
const SORT_KEY = 'sortMode'

async function togglePin($: EngineInterface, id: string) {
  const old = await healed($, PINS_KEY, idList)
  const next = old.includes(id) ? old.filter(p => p !== id) : [...old, id]
  await $.store.set(PINS_KEY, next)
  await refresh($) // a newly unpinned old session may now drop out of the list
}

// Light or dark: a mod is not told, but the desktop app keeps it in its own config file
// ("userThemeMode"); under "system" the operating system is asked instead. Unofficial: ''
// when nothing answers, and then the colors fall back to theme names.
const theme = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'theme' } as const, '')

// The Microsoft Store (packaged, MSIX) app keeps its config elsewhere: %APPDATA%\Claude holds only
// a marker, the real one is %LOCALAPPDATA%\Claude-Data\<claude_…>\config.json (a colleague's PC,
// 2026-11-11: his panel drew dark in light mode). Older packaged builds: Packages\Claude_…
async function packagedConfigs($: EngineInterface): Promise<string[]> {
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return []
  const dirs = async (path: string) => ((await $.fs.list(path).catch(() => [])) as any[]).filter(e => e.kind === 'dir').map(e => e.name)
  return [
    ...(await dirs(`${local}/Claude-Data`)).map(name => `${local}/Claude-Data/${name}/config.json`),
    ...(await dirs(`${local}/Packages`))
      .filter(name => name.startsWith('Claude_'))
      .map(name => `${local}/Packages/${name}/LocalCache/Roaming/Claude/config.json`),
  ]
}

async function readThemeMode($: EngineInterface): Promise<string> {
  // Windows keeps the app's config under %APPDATA%; macOS under ~/Library/Application Support
  const appData = await $.env.get('APPDATA')
  const home = await $.env.get('HOME')
  const isWindows = !!appData
  const configPaths = isWindows
    ? [`${appData}/Claude/config.json`, ...(await packagedConfigs($))]
    : [`${home}/Library/Application Support/Claude/config.json`]
  // The first config that has the setting wins ("system" included)
  let mode = ''
  for (const path of configPaths) {
    const config = await readJson($, path)
    const found = config?.userThemeMode ?? config?.userTheme
    if (typeof found === 'string') {
      mode = found
      break
    }
  }
  if (mode === 'light' || mode === 'dark') return mode
  // "system" (or no setting): ask the operating system
  return isWindows ? readWindowsTheme($) : readMacTheme($)
}

// Windows: AppsUseLightTheme is 0x1 for light apps, 0x0 for dark
// ("AppsUseLightTheme    REG_DWORD    0x0", seen 2026-10-14)
async function readWindowsTheme($: EngineInterface): Promise<string> {
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
    const out = await $.process.run(['reg', 'query', key, '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 })
    if (out.exitCode !== 0) return ''
    if (/AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(out.stdout)) return 'dark'
    if (/AppsUseLightTheme\s+REG_DWORD\s+0x1\b/.test(out.stdout)) return 'light'
    return ''
  } catch {
    return ''
  }
}

// macOS: AppleInterfaceStyle reads "Dark" in dark mode; in light mode the key is missing and
// the command fails. UNTESTED: no Mac to try it on yet.
async function readMacTheme($: EngineInterface): Promise<string> {
  try {
    const out = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
    return out.exitCode === 0 && /dark/i.test(out.stdout) ? 'dark' : 'light'
  } catch {
    return ''
  }
}

// The colors a fade needs as real values, per theme: the border at rest, and the "ink"
// (black on light, white on dark) a hover fades to
function themeColors(mode: string): { rest?: string; ink?: string } {
  if (mode === 'light') return { rest: '#cfcfcf', ink: '#000000' }
  if (mode === 'dark') return { rest: '#4a4a4a', ink: '#ffffff' }
  return {}
}

// The account's usage limits, shown as bars in the header. Account-wide, so this session
// reads them itself on each refresh (tested 2026-10-12: rateLimits five_hour / seven_day).
const limits = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'limits' } as const, [])
const LIMIT_LABELS: Record<string, string> = { five_hour: '5 hours', seven_day: 'weekly' }

// A session has rateLimits only after its first turn (a fresh session's panel showed no bars,
// 2026-10-26), so every session saves the newest numbers it gets to the shared store, and the
// panel shows its own if it has them, else the newest saved ones.
const LIMITS_KEY = 'limits'

// ---- Files of our own, beside the app's store (2026-11-11) ----
// The app's store is ONE file for every key, and every session wrote its info there every few
// seconds; two writes at once left it half written and the panel blank. Now: each session's info
// in its own file (one writer per file), limits and PR states in shared.json written only by the
// session holding the writer pass, and the store keeps only what a click changes
let dataDirPath = ''
async function dataDir($: EngineInterface): Promise<string> {
  if (!dataDirPath) {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    dataDirPath = `${home}/.claude/plugins/store/fdcd-smart-active-session-panel-data`
  }
  return dataDirPath
}

async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

// The pulse: any session that changes writes pulse.json = { at }. The session showing the
// panel or band reads it every second and refreshes when it differs, in place of a 5 s
// list_sessions (FutaraDragon's design, 2026-11-12). Compared by text, never by "newer": a
// clock moved back still counts. Unreadable: refresh once and write it again (a torn write
// heals; nothing in it is worth keeping)
const PULSE_MS = 1_000
let lastPulse = ''
const pulsePath = async ($: EngineInterface) => `${await dataDir($)}/pulse.json`

function pulse($: EngineInterface) {
  void (async () => {
    try {
      await $.fs.write(await pulsePath($), JSON.stringify({ at: Date.now() }))
    } catch {}
  })()
}

async function pulseTick($: EngineInterface) {
  if (!seenOnScreen) return
  let now: string
  try {
    const raw = String(await $.fs.read(await pulsePath($)))
    now = typeof JSON.parse(raw)?.at === 'number' ? raw : 'bad'
  } catch {
    now = 'bad'
  }
  if (now === lastPulse) return
  const first = lastPulse === ''
  lastPulse = now
  if (now === 'bad') pulse($)
  if (first) return
  void refreshIfOpen($)
  void bandTick($, true)
}

type Shared = { writer?: { id: string; at: number }; limits?: { at: string; limits: UsageLimit[] }; prs?: Record<string, string> }
const PASS_MS = 15_000
const sharedPath = async ($: EngineInterface) => `${await dataDir($)}/shared.json`
const readShared = async ($: EngineInterface): Promise<Shared> => ((await readJson($, await sharedPath($))) ?? {}) as Shared

// The writer pass: one session at a time writes shared.json. The holder renews it each tick; a
// pass not renewed for 15 s is free. A session that takes it acts from its NEXT tick, after
// reading it back still its own (two taking it at once: the last write wins, the other walks past)
let passPending = false
async function holdsPass($: EngineInterface): Promise<boolean> {
  const id = await mySessionId($).catch(() => '')
  if (!id) return false
  const shared = await readShared($)
  const writer = shared.writer
  const free = !writer?.id || Date.now() - Number(writer.at) > PASS_MS
  if (writer?.id === id && (passPending || !free)) {
    passPending = false
    await $.fs.write(await sharedPath($), JSON.stringify({ ...shared, writer: { id, at: Date.now() } }))
    return true
  }
  if (free) {
    passPending = true
    await $.fs.write(await sharedPath($), JSON.stringify({ ...shared, writer: { id, at: Date.now() } }))
  }
  return false
}

async function writeShared($: EngineInterface, patch: Partial<Shared>) {
  if (!(await holdsPass($))) return
  const shared = await readShared($)
  const next = { ...shared, ...patch }
  if (stable(next) !== stable(shared)) await $.fs.write(await sharedPath($), JSON.stringify(next))
}

function toLimits(usage: any): UsageLimit[] {
  return (usage?.rateLimits ?? [])
    .filter((r: any) => LIMIT_LABELS[r.kind])
    .map((r: any) => ({ label: LIMIT_LABELS[r.kind], percent: Number(r.percentUsed) || 0, resetsAt: r.resetsAt }))
}

async function saveLimits($: EngineInterface, usage: any) {
  const found = toLimits(usage)
  if (found.length > 0) await writeShared($, { limits: { at: new Date().toISOString(), limits: found } })
}

// The app's own usage card numbers, live (get_usage, local, no tokens). A session's own
// rateLimits change only after its own reply, so an idle panel showed 3% / 64% while the app
// showed 11% / 66%, and saved its old numbers over newer ones every refresh (team, 2026-10-28)
function planLimits(plan: any): UsageLimit[] {
  if (plan?.status !== 'ok') return []
  return ((plan.windows ?? []) as any[])
    .map(w => {
      const text = String(w.label ?? '')
      const label = /5-hour/i.test(text) ? '5 hours' : /^weekly · all models/i.test(text) ? 'weekly' : ''
      return { label, percent: Number(w.percentUsed) || 0, resetsAt: w.resetsAt }
    })
    .filter(l => l.label !== '')
}

async function readLimits($: EngineInterface, ask = true): Promise<UsageLimit[]> {
  try {
    if (!ask) throw new Error('saved only')
    const result = await $.mcp.call(SERVER, 'get_usage', {})
    const live = result.isError ? [] : planLimits(parse(result)?.plan)
    if (live.length > 0) {
      await writeShared($, { limits: { at: new Date().toISOString(), limits: live } })
      return bothLimits(live)
    }
  } catch {}
  try {
    const saved = (await readShared($)).limits
    if (Array.isArray(saved?.limits))
      return bothLimits(
        saved.limits
          .filter(l => l && typeof l.label === 'string')
          .map(l => ({ label: l.label, percent: Number(l.percent) || 0, resetsAt: isoTime(l.resetsAt) || undefined })),
      )
    return bothLimits(toLimits(await $.session.usage()))
  } catch {
    return []
  }
}

// Always both bars, in order. Right after a reset the app leaves that window out until it is
// used again, and the 5-hour bar vanished (2026-10-27); a missing window, or one whose reset
// time has passed, is drawn empty with no reset time
function bothLimits(found: UsageLimit[]): UsageLimit[] {
  return Object.values(LIMIT_LABELS).map(label => {
    const l = found.find(f => f.label === label)
    const over = !l || (l.resetsAt !== undefined && new Date(l.resetsAt).getTime() <= Date.now())
    return over ? { label, percent: 0 } : l
  })
}

// One usage limit drawn as a single SVG: icon and percent on top, a thin round bar, and the
// reset time below in a smaller font (plain Text has no font size; SVG text does).
// Widths in percent and sizes in pixels, with no viewBox: nothing is stretched, so the bar's
// ends stay round at any panel width. `ink` is the theme's text color (black / white), or a
// mid gray when the theme is unknown.
const LIMIT_PX = 34

// 14 px icons: a clock for the 5-hour limit, a calendar for the weekly one
const LIMIT_ICONS: Record<string, string> = {
  '5 hours':
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="INK" stroke-width="1.4"/>' +
    '<path d="M7 4v3.2l2.2 1.4" fill="none" stroke="INK" stroke-width="1.4" stroke-linecap="round"/>',
  weekly:
    '<rect x="1.5" y="2.5" width="11" height="10" rx="2" fill="none" stroke="INK" stroke-width="1.4"/>' +
    '<path d="M1.5 6h11M4.5 1v3M9.5 1v3" stroke="INK" stroke-width="1.4" stroke-linecap="round"/>',
}

// The usage block in pieces: an Svg cannot stretch to its box (no width stops at ~400 px,
// width "100%" refused the pane, test17), so only small fixed parts are SVG and the bar
// itself is two Boxes with a background, which flex can stretch
// A bar end: a half circle of `color`, on `back` (the track behind a fill's end) or nothing
const RAINBOW_AT = 100
const BAR_PX = 5
const CAP_PX = 3
// The same colors and step (110 ms) as rainbow.tsx, so a full bar's ends loop with its middle
const RAINBOW_ANIMATE =
  '<animate attributeName="fill" dur="0.77s" calcMode="discrete" repeatCount="indefinite" ' +
  'values="#ff4d4d;#ffa64d;#ffee4d;#5cff4d;#4dc3ff;#a64dff;#ff4dd2"/>'
function capSvg(side: 'left' | 'right', color: string, back: string, rainbow = false): string {
  const r = BAR_PX / 2
  const d =
    side === 'left'
      ? `M${CAP_PX} 0 A${r} ${r} 0 0 0 ${CAP_PX} ${BAR_PX} Z`
      : `M0 0 A${r} ${r} 0 0 1 0 ${BAR_PX} Z`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAP_PX}" height="${BAR_PX}">` +
    (back ? `<rect width="${CAP_PX}" height="${BAR_PX}" fill="${back}"/>` : '') +
    `<path d="${d}" fill="${color}">${rainbow ? RAINBOW_ANIMATE.replace('<animate ', `<animate begin="-${Date.now() % 770}ms" `) : ''}</path></svg>`
  )
}

function limitIconSvg(label: string, ink: string): string {
  const icon = (LIMIT_ICONS[label] ?? '').replace(/INK/g, ink)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)">${icon}</g></svg>`
}

function limitPercentSvg(percent: number, ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="16">` +
    `<text x="40" y="12" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" ` +
    `font-weight="600" fill="${ink}">${percent}%</text></svg>`
  )
}

function limitResetSvg(resetsAt: string | undefined, ink: string): string {
  const reset = `Reset in ${resetsAt ? resetLabel(resetsAt) : '-'}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="14">` +
    `<text x="0" y="11" font-family="system-ui, sans-serif" font-size="10" fill="${ink}" ` +
    `fill-opacity="0.7">${reset}</text></svg>`
  )
}

// Easter egg: the weekly limit at 100% sets off fireworks over the panel for one minute, once
// per weekly reset. The store remembers when it first hit, keyed by that reset time
const FIREWORKS_AT = 100
const FIREWORKS_KEY = 'fireworks'
const FIREWORKS_MS = 60_000
type FireworksMark = { resetsAt: string; at: number }

async function markFireworks($: EngineInterface, found: UsageLimit[]) {
  const weekly = found.find(l => l.label === 'weekly')
  if (!weekly || weekly.percent < FIREWORKS_AT) return
  const mark = (await $.store.get(FIREWORKS_KEY)) as FireworksMark | undefined
  if (mark?.resetsAt !== (weekly.resetsAt ?? '')) {
    await $.store.set(FIREWORKS_KEY, { resetsAt: weekly.resetsAt ?? '', at: Date.now() })
  }
}

// Bursts of dots flying out and fading, each burst somewhere else and later than the last
function fireworksSvg(width: number, height: number): string {
  const colors = ['#ff4d4d', '#ffa64d', '#ffee4d', '#5cff4d', '#4dc3ff', '#a64dff', '#ff4dd2']
  const bursts = [
    [0.25, 0.2], [0.7, 0.15], [0.5, 0.35], [0.2, 0.55], [0.75, 0.5], [0.45, 0.7], [0.65, 0.85], [0.3, 0.88],
  ]
  const parts = bursts
    .map(([fx, fy], b) => {
      const cx = Math.round(width * fx)
      const cy = Math.round(height * fy)
      const color = colors[b % colors.length]
      const begin = `${(b * 0.45).toFixed(2)}s`
      return Array.from({ length: 14 }, (_, i) => {
        const angle = (i / 14) * 2 * Math.PI
        const tx = Math.round(cx + Math.cos(angle) * 55)
        const ty = Math.round(cy + Math.sin(angle) * 55)
        return (
          `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}" opacity="0">` +
          `<animate attributeName="cx" values="${cx};${tx}" dur="1.4s" begin="${begin}" repeatCount="indefinite"/>` +
          `<animate attributeName="cy" values="${cy};${ty + 12}" dur="1.4s" begin="${begin}" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="1;1;0" dur="1.4s" begin="${begin}" repeatCount="indefinite"/>` +
          `</circle>`
        )
      }).join('')
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts}</svg>`
}

// Blue, then yellow from 75%, red from 90%
function limitColor(percent: number): string {
  if (percent >= 90) return '#e06c75'
  if (percent >= 75) return '#e5c07b'
  return '#4a8cf7'
}

// How long until a limit resets: "2h 18m" within a day, else "3d 12h"
function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000))
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
}

// One line of card text as SVG, small like the header. Wider than any card; a narrower slot
// squeezed it (test30), so `slice` keeps it 1:1 and cuts the right side instead. Long text is
// cut first so the markup stays small
// `dot`: a small circle of that color before the text, as on the folder rows (a task row)
function lineSvg(text: string, color: string, opacity = 1, dot = ''): string {
  const cut = text.length > 160 ? text.slice(0, 160) : text
  const safe = cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${FOLDER_PX}" ` +
    `viewBox="0 0 1200 ${FOLDER_PX}" preserveAspectRatio="xMinYMin slice">` +
    (dot ? `<circle cx="4" cy="9" r="3" fill="${dot}"/>` : '') +
    `<text x="${dot ? 12 : 0}" y="13" font-family="system-ui, sans-serif" font-size="11" fill="${color}" ` +
    `fill-opacity="${opacity}">${safe}</text></svg>`
  )
}

// A soft end for card text cut at the card's edge: transparent → the pane's background
const FADE_PX = 24
// A card's round corner (FutaraDragon, 2026-11-06): the pane color outside a quarter circle,
// laid over the card's square corner. Unknown theme ("system"): no pane color, square corners
const CORNER_PX = 4
function cornerSvg(corner: 'tl' | 'tr' | 'bl' | 'br', bg: string): string {
  const r = CORNER_PX
  const d = {
    tl: `M0 0H${r}A${r} ${r} 0 0 0 0 ${r}Z`,
    tr: `M${r} 0V${r}A${r} ${r} 0 0 0 0 0Z`,
    bl: `M0 ${r}V0A${r} ${r} 0 0 0 ${r} ${r}Z`,
    br: `M${r} ${r}H0A${r} ${r} 0 0 0 ${r} 0Z`,
  }[corner]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${r}"><path d="${d}" fill="${bg}"/></svg>`
}

function fadeSvg(bg: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FADE_PX}" height="${FOLDER_PX}">` +
    `<defs><linearGradient id="f"><stop offset="0" stop-color="${bg}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${bg}"/></linearGradient></defs>` +
    `<rect width="${FADE_PX}" height="${FOLDER_PX}" fill="url(#f)"/></svg>`
  )
}

// The card icons, in the stroke style of the usage icons: a chevron (› folded, ⌄ open) and a
// pushpin (outline, filled in the folder color when pinned)
// A card icon's own layer, laid over the title row after the card's click layer (which covered
// the icons, so their hover never fired, 2026-11-06): an empty spot the icon's size, the hover
// twin on a rounded background a step stronger than the card's hover gray, and its own click
function iconHover(Box: any, Svg: any, Client: any, key: string, src: string, message: Record<string, string>, mode: string) {
  const bg = mode === 'light' ? '#cfcfcf' : '#4a4a4a'
  const twin = src.replace(/(<svg[^>]*>)/, `$1<rect width="14" height="16" rx="4" fill="${bg}"/>`)
  return (
    <Box key={key} position="relative" flexShrink={0}>
      <Svg source={'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"/>'} alt="icon spot" width={14} height={16} />
      <Box position="absolute" top={0} left={0} right={0} display="none" hover={{ display: 'flex' }}>
        <Svg source={twin} alt="icon hover" width={14} height={16} />
      </Box>
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client key={`${key}-hit`} module="./hit.tsx" width="100%" props={plain({ message })} />
      </Box>
    </Box>
  )
}

function chevronSvg(folded: boolean, ink: string): string {
  const d = folded ? 'M5.5 3.5l3.5 3.5-3.5 3.5' : 'M3.5 5.5l3.5 3.5 3.5-3.5'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)">` +
    `<path d="${d}" fill="none" stroke="${ink}" stroke-opacity="0.7" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></g></svg>`
  )
}

function pinSvg(pinned: boolean, color: string, ink: string): string {
  const stroke = pinned ? color : ink
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)">` +
    `<path d="M4.5 1.5h5M5.5 1.5v4L3.5 8h7l-2-2.5v-4Z" fill="${pinned ? color : 'none'}" ` +
    `stroke="${stroke}" stroke-opacity="${pinned ? 1 : 0.7}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<path d="M7 8v4.5" stroke="${stroke}" stroke-opacity="${pinned ? 1 : 0.7}" stroke-width="1.4" ` +
    `stroke-linecap="round"/></g></svg>`
  )
}

// A header label as SVG, same small text as the folder rows; hit.tsx lies on top for the click.
// `end` anchors the text at the right edge
function labelSvg(parts: { text: string; dim: boolean }[], ink: string, end = false): string {
  const spans = parts
    .map(s => `<tspan fill-opacity="${s.dim ? 0.6 : 1}">${s.text}</tspan>`)
    .join(' ')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${FOLDER_PX}">` +
    `<text x="${end ? '100%' : '0'}" y="13" text-anchor="${end ? 'end' : 'start'}" ` +
    `font-family="system-ui, sans-serif" font-size="11" fill="${ink}">${spans}</text></svg>`
  )
}

// A clickable label sized to its own text, the text centered: an error in the guessed width
// splits evenly, so both sides keep the same room (FutaraDragon, 2026-11-04)
function fitLabelSvg(parts: { text: string; dim: boolean }[], ink: string, charPx = 6): string {
  const chars = parts.reduce((n, p) => n + p.text.length, 0) + parts.length - 1
  const w = Math.ceil(chars * charPx)
  const spans = parts
    .map(s => `<tspan fill-opacity="${s.dim ? 0.6 : 1}">${s.text}</tspan>`)
    .join(' ')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${FOLDER_PX}">` +
    `<text x="${w / 2}" y="13" text-anchor="middle" ` +
    `font-family="system-ui, sans-serif" font-size="11" fill="${ink}">${spans}</text></svg>`
  )
}

// One folder row as SVG, so its text can be smaller than the pane's font. Not clickable by
// itself: folder.tsx lies on top and catches the clicks
const FOLDER_PX = 18
function folderSvg(name: string, color: string, ink: string, picked: boolean): string {
  const safe = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${FOLDER_PX}">` +
    `<circle cx="6" cy="9" r="4" fill="${color}"/>` +
    `<text x="16" y="13" font-family="system-ui, sans-serif" font-size="11" fill="${ink}" ` +
    `fill-opacity="${picked ? 1 : 0.6}">${safe}</text></svg>`
  )
}

// A Client's props must be plain JSON, and `undefined` is not: one undefined value (the theme
// colors under "system") made the app refuse the whole panel. Drop such keys before sending.
function plain<T>(props: T): T {
  return JSON.parse(JSON.stringify(props))
}

// Cards start folded (mini); the ones the person opened are remembered here, shared by every
// session's panel like the pins. A new session is not on the list, so it starts folded.
const expanded = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'expanded' } as const, [])
const EXPANDED_KEY = 'expanded'

async function toggleFold($: EngineInterface, id: string) {
  const old = await healed($, EXPANDED_KEY, idList)
  const next = old.includes(id) ? old.filter(f => f !== id) : [...old, id]
  await $.store.set(EXPANDED_KEY, next)
  await update($, expanded, () => next)
}

// Is the folder list open? Folded, only the chosen folder's row shows. Remembered for all panels.
const foldersOpenAtom = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'foldersOpen' } as const, true)
const FOLDERS_KEY = 'foldersOpen'

async function toggleFolders($: EngineInterface) {
  const next = !(await read($, foldersOpenAtom))
  await $.store.set(FOLDERS_KEY, next)
  await update($, foldersOpenAtom, () => next)
}

// How far back the list goes (1–7 × 24 h) and whether its choice row is open. Click-written, so
// UI state in the store like the others. Remembered for all panels
const RANGE_CHOICES = [1, 2, 3, 4, 5, 6, 7]
const rangeDays = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'rangeDays' } as const, 2)
const rangeOpen = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'rangeOpen' } as const, false)

async function toggleRange($: EngineInterface) {
  const next = !(await read($, rangeOpen))
  await $.store.set('rangeOpen', next)
  await update($, rangeOpen, () => next)
}

async function pickRange($: EngineInterface, days: number) {
  const next = RANGE_CHOICES.includes(days) ? days : 2
  await $.store.set('rangeDays', next)
  await update($, rangeDays, () => next)
  await $.store.set('rangeOpen', false)
  await update($, rangeOpen, () => false)
}

// Sort by pinned: the pinned cards sit under a "pinned" header row that folds them away
// (FutaraDragon, 2026-10-28). Remembered for all panels, as the folder list
const pinsOpenAtom = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'pinsOpen' } as const, true)
const PINS_OPEN_KEY = 'pinsOpen'

async function togglePins($: EngineInterface) {
  const next = !(await read($, pinsOpenAtom))
  await $.store.set(PINS_OPEN_KEY, next)
  await update($, pinsOpenAtom, () => next)
  await update($, listOffset, () => 0)
}

// Plain mode: every folder color is drawn in the text color (white in dark mode, black in
// light); the colors stay saved and come back when it is off. Toggled by the dot before All
// (FutaraDragon, 2026-10-28)
const plainAtom = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'plain' } as const, false)
const PLAIN_KEY = 'plainColors'

async function togglePlain($: EngineInterface) {
  const next = !(await read($, plainAtom))
  await $.store.set(PLAIN_KEY, next)
  await update($, plainAtom, () => next)
}

// The toggle: a dot of four folder-like colors when on, a plain dot in the text color when off
function plainDotSvg(plain: boolean, ink: string): string {
  const slices = plain
    ? `<circle cx="6" cy="9" r="4" fill="${ink}"/>`
    : ['#e06c75', '#e5c07b', '#98c379', '#61afef']
        .map((c, i) => {
          const a0 = (i * Math.PI) / 2 - Math.PI / 2
          const a1 = a0 + Math.PI / 2
          const p = (a: number) => `${(6 + 4 * Math.cos(a)).toFixed(2)} ${(9 + 4 * Math.sin(a)).toFixed(2)}`
          return `<path d="M6 9L${p(a0)}A4 4 0 0 1 ${p(a1)}Z" fill="${c}"/>`
        })
        .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="${FOLDER_PX}">${slices}</svg>`
}

async function toggleSort($: EngineInterface) {
  const next = (await read($, sortMode)) === 'pinned' ? 'time' : 'pinned'
  await $.store.set(SORT_KEY, next)
  await update($, listOffset, () => 0) // back to the first page
  await refresh($) // the order is made in refresh
}

function filtered(list: RecentSession[], f: string): RecentSession[] {
  return list.filter(s => s.isSelf || f === 'all' || s.group?.id === f)
}

// A bright enough color for the n-th group. Each hue jumps 137.5° (the golden angle) from
// the one before, plus a little randomness, so two groups never get near-twin colors.
function randomColor(n: number): string {
  return hueColor(Math.floor(n * 137.5 + Math.random() * 20) % 360)
}

// The hue (0–359) of a '#rrggbb' color
function colorHue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return Math.round(h * 60 + 360) % 360
}

// HSL → '#rrggbb', with fixed saturation and lightness so every color reads on dark and light
function hueColor(hue: number): string {
  const s = 0.65
  const l = 0.6
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// The ↻ beside a group: roll it a new color, at least 90° of hue away from the old one
async function rerollColor($: EngineInterface, groupId: string) {
  const colors = await healed($, COLORS_KEY, colorMap)
  const oldHue = colors[groupId] ? colorHue(colors[groupId]) : 0
  colors[groupId] = hueColor((oldHue + 90 + Math.floor(Math.random() * 180)) % 360)
  await $.store.set(COLORS_KEY, colors)
  await update($, groupColors, () => colors)
}

// Give every group in the list a color, saving new ones for all sessions
async function ensureGroupColors($: EngineInterface, rows: RecentSession[]) {
  const colors = await healed($, COLORS_KEY, colorMap)
  let added = false
  for (const r of rows) {
    if (r.group && !colors[r.group.id]) {
      colors[r.group.id] = randomColor(Object.keys(colors).length)
      added = true
    }
  }
  if (added) await $.store.set(COLORS_KEY, colors)
  await update($, groupColors, () => colors)
}

// The page of the card list shown, 0 first (the atom kept its old name)
const listOffset = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'listOffset' } as const, 0)
// Box 1: the "updated" row 1 + its gap ½, All row 1 + gap to box 2 ½, plus one per folder row
// and the usage block
const BOX1_ROWS = 3
const PAGER_ROWS = 1.25 // the `‹ 2 / 4 ›` row under the list, with a quarter row above it
// How many pages the last drawing made, for the pager's clicks, which arrive in ui.message
let lastPageCount = 1

// The list pages by whole cards: the click layers are Clients, which no overflow clips, so a
// card cut part-way would be drawn over whatever is below it (2026-10-12)
async function scrollList($: EngineInterface, action: string) {
  const page = Number(await read($, listOffset)) || 0
  const wanted = action === 'prev' ? page - 1 : page + 1
  await update($, listOffset, () => Math.min(lastPageCount - 1, Math.max(0, wanted)))
}

// Split the cards into pages: each page takes as many whole cards as fit in `area` rows
// (a card's rows include the gap below it, which the last card on a page does not need)
// `head(i, page)`: rows drawn above card i when it starts a page (the pinned header)
function pageStarts(rows: number[], area: number, head: (i: number, page: number) => number = () => 0): number[] {
  const starts = [0]
  let used = head(0, 0)
  let count = 0
  rows.forEach((r, i) => {
    if (count > 0 && used + r - 0.25 > area) {
      starts.push(i)
      used = head(i, starts.length - 1)
      count = 0
    }
    used += r
    count += 1
  })
  return starts
}

// The pinned group's header row: "pinned" with a fold chevron and the count
const PIN_HEAD_ROWS = 1.25
function pinHeadSvg(open: boolean, count: number, ink: string): string {
  const d = open ? 'M3.5 5.5L7 9l3.5-3.5' : 'M5.5 3.5L9 7l-3.5 3.5'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${FOLDER_PX}"><g transform="translate(0 2)"><path d="${d}" fill="none" stroke="${ink}" ` +
    `stroke-opacity="0.8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    `<text x="18" y="13" font-family="system-ui, sans-serif" font-size="11" fill="${ink}" fill-opacity="0.7">` +
    `pinned (${count})</text></svg>`
  )
}

// The pager's pieces: a chevron (dimmed at the end) and the page number, centered
function pageArrowSvg(direction: 'prev' | 'next', ink: string, dim: boolean): string {
  const d = direction === 'prev' ? 'M8.5 3.5L5 7l3.5 3.5' : 'M5.5 3.5L9 7l-3.5 3.5'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)">` +
    `<path d="${d}" fill="none" stroke="${ink}" stroke-opacity="${dim ? 0.25 : 0.8}" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></g></svg>`
  )
}

// The new-session button: a pill as the usage bars are built (rounded SVG ends, a flex
// middle in the same color), with a plus in the middle
function pillEndSvg(side: 'left' | 'right', color: string): string {
  const r = FOLDER_PX / 2
  const d = side === 'left' ? `M${r} 0 A${r} ${r} 0 0 0 ${r} ${FOLDER_PX} Z` : `M0 0 A${r} ${r} 0 0 1 0 ${FOLDER_PX} Z`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${FOLDER_PX}"><path d="${d}" fill="${color}"/></svg>`
}

function expandSvg(ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="${FOLDER_PX}"><g transform="translate(0 2)">` +
    `<path d="M8.5 2.5h3v3M11.5 2.5l-4 4M5.5 11.5h-3v-3M2.5 11.5l4-4" fill="none" stroke="${ink}" ` +
    `stroke-opacity="0.8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`
  )
}

// The band's percent sits right after its bar, so it reads with it
function bandPercentSvg(percent: number, ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="16">` +
    `<text x="6" y="12" font-family="system-ui, sans-serif" font-size="12" ` +
    `font-weight="600" fill="${ink}">${percent}%</text></svg>`
  )
}

// 212000 -> '212k', 1000000 -> '1M'
function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

function contextIconSvg(ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)">` +
    `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${ink}" stroke-width="1.4"/>` +
    `<path d="M7 1.5a5.5 5.5 0 0 1 0 11Z" fill="${ink}"/></g></svg>`
  )
}

// An open pull request: GitHub's green PR mark
const PR_COLOR = '#3fb950'
function prIconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16"><g transform="translate(0 1)" fill="none" ` +
    `stroke="${PR_COLOR}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="3.5" cy="3" r="1.6"/><circle cx="3.5" cy="11" r="1.6"/><circle cx="10.5" cy="11" r="1.6"/>` +
    `<path d="M3.5 4.6v4.8M10.5 9.4V5.5a2 2 0 0 0-2-2H6.5M8 2l-1.5 1.5L8 5"/></g></svg>`
  )
}

function pillSvg(color: string, ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${FOLDER_PX}">` +
    `<rect width="100%" height="${FOLDER_PX}" rx="${FOLDER_PX / 2}" fill="${color}"/>` +
    `<svg x="50%" overflow="visible"><g transform="translate(-7 2)">` +
    `<path d="M7 2.5v9M2.5 7h9" stroke="${ink}" stroke-opacity="0.8" stroke-width="1.4" stroke-linecap="round"/></g></svg></svg>`
  )
}

function plusSvg(ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="${FOLDER_PX}"><g transform="translate(0 2)">` +
    `<path d="M7 2.5v9M2.5 7h9" stroke="${ink}" stroke-opacity="0.8" stroke-width="1.4" stroke-linecap="round"/></g></svg>`
  )
}

function pageNumberSvg(text: string, ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="${FOLDER_PX}">` +
    `<text x="30" y="13" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" ` +
    `fill="${ink}" fill-opacity="0.7">${text}</text></svg>`
  )
}

// A card's height in rows: title + reply + model (mini mode: title only), + 1 per live task.
// On the desktop the two thin border lines take about one row together (measured 2026-10-14):
// a card is 4 rows (2 folded), + 1 per task; + ½ for the padding under it and the gap after.
function cardRows(liveTaskCount: number, isFolded: boolean): number {
  return cardPx(liveTaskCount, isFolded) / ROW_PX + 0.25
}

// A card's height in px: its SVG text rows (title; open: reply, tasks, model · time), the
// context bar with the quarter row above it, and a quarter row of padding at the top and bottom.
// The left stripe is drawn this tall, so keep it in step with the layout
const ROW_PX = 20 // one row of the pane, roughly (the usage bar's quarter row drew ~5 px)
function cardPx(liveTaskCount: number, isFolded: boolean): number {
  const textRows = isFolded ? 1 : 3 + liveTaskCount
  return textRows * FOLDER_PX + ROW_PX / 2 + ROW_PX / 2
}

// The status stripe at a card's left: a rounded 3 px line. Working: it breathes `rest` → yellow.
// Asking: a quick light-blue flash, then 0.5 s at rest, again and again (FutaraDragon, 2026-10-28)
const STRIPE_PX = 5
// A clickable thing lights up a little under the pointer (FutaraDragon, 2026-11-04: no one knew they could click)
const hoverColor = (mode: string) => (mode === 'light' ? '#dcdcdc' : '#3a3a3a')
const hoverBg = (mode: string) => ({ backgroundColor: hoverColor(mode) })
const HOVER_R = 5
const HOVER_PAD = 3
// A button's SVG with room at both sides, and its hover twin: the same SVG on a rounded
// background (FutaraDragon's idea, 2026-11-04). The twin is revealed exactly on top under the pointer
function padSvg(src: string, color = ''): string {
  const raw = src.match(/<svg[^>]*?\swidth="([^"]+)"/)?.[1] ?? '0'
  const h = Number(src.match(/<svg[^>]*?\sheight="([\d.]+)"/)?.[1] ?? FOLDER_PX)
  const W = raw.endsWith('%') ? raw : String(Number(raw) + HOVER_PAD * 2)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}"${raw.endsWith('%') ? '' : ` viewBox="0 0 ${W} ${h}"`}>` +
    (color ? `<rect width="${W}" height="${h}" rx="${HOVER_R}" fill="${color}"/>` : '') +
    src.replace('<svg ', `<svg x="${HOVER_PAD}" `) +
    '</svg>'
  )
}
function hov(Box: any, Svg: any, color: string, p: { source: string; alt: string; width?: number; height?: number }) {
  const width = p.width === undefined ? undefined : p.width + HOVER_PAD * 2
  return [
    <Svg key="n" source={padSvg(p.source)} alt={p.alt} width={width} height={p.height} />,
    <Box position="absolute" top={0} left={0} right={0} display="none" hover={{ display: 'flex' }}>
      <Svg source={padSvg(p.source, color)} alt={p.alt} width={width} height={p.height} />
    </Box>,
  ]
}
const ASK_COLOR = '#7cc4ff'
// Working with helpers (a subagent or background task): red-orange, over plain working yellow
// (FutaraDragon, 2026-11-04)
const HELPER_COLOR = '#e08050'
// A session on screen that is also busy or asking: the top half stays in the on-screen color
// (`top`), the bottom half shows the status (FutaraDragon, 2026-10-28)
function stripeSvg(color: string, height: number, running: boolean, rest: string, asking = false, top = ''): string {
  const breathe = asking
    ? `<animate attributeName="fill" dur="0.7s" repeatCount="indefinite" keyTimes="0;0.1;0.28;1" values="${rest};${color};${rest};${rest}"/>`
    : running
      ? `<animate attributeName="fill" dur="1.6s" repeatCount="indefinite" values="${rest};${color};${rest}"/>`
      : ''
  const half = Math.floor(height / 2)
  const body = top
    ? `<rect width="${STRIPE_PX}" height="${half - 1}" rx="2.5" fill="${top}"/>` +
      `<rect y="${half + 1}" width="${STRIPE_PX}" height="${height - half - 1}" rx="2.5" fill="${color}">${breathe}</rect>`
    : `<rect width="${STRIPE_PX}" height="${height}" rx="2.5" fill="${color}">${breathe}</rect>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIPE_PX}" height="${height}">${body}</svg>`
}

const DEAD_TASK_MS = 10 * 60_000

// Background tasks that still look alive: a task whose output file was not written for
// 10 minutes is probably dead (its session crashed before the end notification came).
// Only ignored here, never deleted: a session's info is written by that session alone.
// Returns the live tasks' titles.
async function liveTasks($: EngineInterface, info: SessionInfo | undefined): Promise<string[]> {
  const titles: string[] = []
  for (const task of Object.values(info?.tasks ?? {})) {
    const title = typeof task === 'string' ? task : task.description
    const output = typeof task === 'string' ? undefined : task.output
    if (!output) {
      titles.push(title) // no file to check (older save): trust it
      continue
    }
    const stat = await $.fs.stat(output).catch(() => undefined)
    if (stat && Date.now() - stat.mtimeMs < DEAD_TASK_MS) titles.push(title)
  }
  return titles
}

// 'claude-opus-5-5' → 'opus-5-5'
function shortModel(model: string | undefined): string {
  return model ? model.replace(/^claude-/, '') : 'model ?'
}

// Context use as a text ring: ○ ◔ ◑ ◕ ● and the number
function usageRing(percent: number | undefined): string {
  if (percent === undefined) return '○'
  const ring = ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.round(percent / 25))]
  return `${ring} ${percent}%`
}


// The list's time window: the last N × 24 h, N picked in the "show" row (FutaraDragon,
// 2026-11-12: time based, not calendar days). 2 by default, close to the old "since yesterday"
function cutoff(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function parse(result: { content: { type: string; text?: string }[] }): any {
  const text = result.content.find(c => c.type === 'text')?.text ?? ''
  return JSON.parse(text)
}

function tryParse(result: any): any {
  try {
    return result?.isError ? undefined : parse(result)
  } catch {
    return undefined
  }
}

// Every field gets a safe default; only the id is required (a row without one is dropped).
// One odd value used to stop the whole panel drawing, in every session ("has not drawn in
// this pane" after a session switch, team, 2026-10-28)
const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const isoTime = (v: unknown) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : '')

function toRow(s: any, isSelf: boolean): RecentSession {
  const cwd = text(s?.cwd)
  return {
    id: text(s?.sessionId),
    title: text(s?.title) || '(untitled)',
    cwd,
    lastActivityAt: isoTime(s?.lastActivityAt) || new Date().toISOString(),
    link: text(s?.link),
    isRunning: !!s?.isRunning,
    isSelf,
    // Category = the project folder, as the sidebar shows it (list_sessions has no project name)
    group: cwd ? { id: cwd.toLowerCase(), name: folder(cwd) || cwd } : null,
  }
}

// Self-repair: read a stored value through its cleaner, and when the cleaned value differs
// from what is stored (old, half written or broken), write the clean one back once.
// Compared with sorted keys and no undefined, so an already clean value is never rewritten
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x)) ?? ''

async function healed<T>($: EngineInterface, key: string, clean: (raw: unknown) => T): Promise<T> {
  const raw = await $.store.get(key)
  const value = clean(raw)
  if (raw !== undefined && stable(raw) !== stable(value)) await $.store.set(key, value as any).catch(() => {})
  return value
}

const idList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const colorMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, c]) => typeof c === 'string')) : {}

// A session's saved info, read back with every field checked: it may be from an older version,
// half written, or written by a session on another machine's app
function cleanInfo(raw: any): SessionInfo {
  if (!raw || typeof raw !== 'object') return { tasks: {} }
  const tasks: Record<string, TaskInfo | string> = {}
  if (raw.tasks && typeof raw.tasks === 'object') {
    for (const [id, task] of Object.entries(raw.tasks as Record<string, any>)) {
      if (typeof task === 'string') tasks[id] = task || 'task'
      else if (task && typeof task === 'object')
        tasks[id] = { description: text(task.description, 'task') || 'task', output: typeof task.output === 'string' ? task.output : undefined }
    }
  }
  const percent = Number(raw.contextPercent)
  const tokens = Number(raw.contextTokens)
  const window = Number(raw.contextWindow)
  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    contextPercent: Number.isFinite(percent) ? percent : undefined,
    contextTokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined,
    contextWindow: Number.isFinite(window) && window > 0 ? window : undefined,
    reply: typeof raw.reply === 'string' ? raw.reply : undefined,
    tasks,
    asking: typeof raw.asking === 'boolean' ? raw.asking : undefined,
    seenAt: isoTime(raw.seenAt) || undefined,
    at: isoTime(raw.at) || undefined,
  }
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.getTime() >= today.getTime() ? hm : `yesterday ${hm}`
}

function folder(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

// One refresh at a time: a pulse during a refresh runs one more after it, never two at once
// A refresh stuck over 30 s (an app call that never answers) no longer blocks the next
let refreshing = 0
let refreshAgain = false

async function refresh($: EngineInterface) {
  if (refreshing && Date.now() - refreshing < 30_000) {
    refreshAgain = true
    return
  }
  const mine = Date.now()
  refreshing = mine
  try {
    await refreshOnce($)
  } finally {
    if (refreshing === mine) refreshing = 0
  }
  if (refreshAgain) {
    refreshAgain = false
    void refresh($)
  }
}

async function refreshOnce($: EngineInterface) {
  try {
    const list = await $.mcp.call(SERVER, 'list_sessions', { limit: 50 })
    if (list.isError) throw new Error('list_sessions failed')
    const self = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
    // At session.start get_session('self') can fail (too early), so the start-up save is lost.
    // Take the id from here instead, and save once (saveInfo fills in the model).
    const selfInfo = tryParse(self)
    if (selfInfo?.sessionId && !selfId) {
      selfId = selfInfo.sessionId
      saveInfo($, info => info)
    }
    const daysNow = await healed($, 'rangeDays', v => (RANGE_CHOICES.includes(Number(v)) ? Number(v) : 2))
    await update($, rangeDays, () => daysNow)
    const rangeOpenNow = await healed($, 'rangeOpen', v => v === true)
    await update($, rangeOpen, () => rangeOpenNow)
    const since = cutoff(daysNow)
    const pinned = await healed($, PINS_KEY, idList)
    const listed: any[] = Array.isArray(tryParse(list)) ? tryParse(list) : []
    // A pinned session older than the 20 newest is not in the list: fetch it alone.
    // Never this session: list_sessions always leaves it out, and it is added as the self row
    // below, so fetching it made a second card with the same key and the app refused the pane.
    const selfRowId = selfInfo?.sessionId ?? ''
    const missing = pinned.filter(id => id !== selfRowId && !listed.some(s => s.sessionId === id))
    // A pin on a session that was deleted (not found) or archived is dead: drop it for good
    const dead: string[] = []
    for (const id of missing) {
      const one = await $.mcp.call(SERVER, 'get_session', { session_id: id })
      let found: any
      try {
        found = one.isError ? undefined : parse(one)
      } catch {
        found = undefined // a "not found" answer that is not JSON
      }
      if (!found?.sessionId || found.isArchived) dead.push(id)
      else listed.push(found)
    }
    if (dead.length > 0) {
      // Hidden only, never written: a write here, in the background, met another write and
      // broke the store (a pinned session deleted, 2026-11-11). Unpinning by hand clears it
      const kept = pinned.filter(id => !dead.includes(id))
      pinned.splice(0, pinned.length, ...kept)
    }
    const mode = await healed($, SORT_KEY, v => (v === 'time' ? 'time' : 'pinned'))
    const rows: RecentSession[] = [
      ...(selfInfo?.sessionId ? [toRow(selfInfo, true)] : []),
      ...listed.filter(s => !s.isArchived && s.sessionId !== selfRowId).map((s: any) => toRow(s, false)),
    ].filter(r => r.id !== '').filter(r => r.isSelf || pinned.includes(r.id) || new Date(r.lastActivityAt).getTime() >= since)
    // 'pinned' mode: pinned sessions first, then the rest; each group newest activity first.
    // 'time' mode: only newest activity first. This session gets no special place (2026-10-14).
    const rank = (r: RecentSession) => (mode === 'pinned' && pinned.includes(r.id) ? 0 : 1)
    rows.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt))
    await update($, pins, () => pinned)
    const expandedNow = await healed($, EXPANDED_KEY, idList)
    await update($, expanded, () => expandedNow)
    const foldersNow = await healed($, FOLDERS_KEY, v => v !== false)
    await update($, foldersOpenAtom, () => foldersNow)
    const pinsOpenNow = await healed($, PINS_OPEN_KEY, v => v !== false)
    const plainNow = await healed($, PLAIN_KEY, v => v === true)
    await update($, plainAtom, () => plainNow)
    await update($, pinsOpenAtom, () => pinsOpenNow)
    const themeMode = await readThemeMode($)
    await update($, theme, () => themeMode)
    const limitsNow = await readLimits($)
    await update($, limits, () => limitsNow)
    await markFireworks($, limitsNow)
    await update($, sortMode, () => mode)
    await ensureGroupColors($, rows)
    await update($, sessions, () => rows)
    await readPrs($, rows.map(r => r.id))
    await update($, error, () => '')
    await update($, connecting, () => false)
  } catch (err) {
    // A brand-new session connects the app's session tools a moment after it starts: not an
    // error, just too early (2026-10-26). Keep the spinner up and try again shortly.
    if (NOT_READY.test(String(err))) {
      await update($, connecting, () => true)
      await update($, error, () => '')
      if (!retryTimer) {
        retryTimer = $.clock.after(RETRY_MS, () => {
          retryTimer = undefined
          void refresh($)
        })
      }
      return
    }
    if (await repairStore($, err)) {
      void refresh($)
      return
    }
    await update($, error, () => String(err))
  }
  await update($, updatedAt, () => new Date().toISOString())
}

// Waiting for the app's session tools to connect (a new session's first seconds)
const connecting = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'connecting' } as const, false)
const RETRY_MS = 2_000
let retryTimer: { cancel: () => void } | undefined

// A spinning arc in the text color, for while the list loads (animated SVG: needs isInteractive)
function spinnerSvg(ink: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="9" fill="none" stroke="${ink}" stroke-opacity="0.2" stroke-width="2.5"/>` +
    `<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="${ink}" stroke-width="2.5" stroke-linecap="round">` +
    `<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" ` +
    `dur="0.9s" repeatCount="indefinite"/></path></svg>`
  )
}

// The app keeps each session's pane layout (place, width) on its own and gives a mod no way
// to set it: `columns` is ignored on the desktop (test8, 2026-10-30)
async function openPanel($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Smart Active Sessions' })
}

// The claude:// handler in the registry can point at an old app-* folder after an
// update, so hand the link to the app's root launcher, which forwards it to the
// running app. macOS registers claude:// in the app bundle, so `open` works there.
// Another install (Store, all users) has no launcher there, and the run failed silently
// (2026-10-27): then Windows' own claude:// handler opens it, through rundll32 so the
// link is never parsed by cmd
async function openSession($: EngineInterface, s: RecentSession) {
  if (s.isSelf || !s.link) return
  await openLink($, s.link, s.title)
}

// The same link without a session id opens the Code tab's blank new-session page (2026-10-28)
const NEW_SESSION_LINK = 'claude://claude.ai/epitaxy'

async function openLink($: EngineInterface, link: string, name: string) {
  const s = { link, title: name }
  const tryRun = async (argv: string[]) => {
    try {
      const out = await $.process.run(argv, { timeoutMs: 15_000 })
      return out.exitCode === 0 ? '' : `exit ${out.exitCode} ${out.stderr ?? ''}`.trim()
    } catch (err) {
      return String(err)
    }
  }
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) {
    const err = await tryRun(['open', s.link])
    if (err) $.ui.toast(`Could not open ${s.title}: ${err.slice(0, 200)}`)
    return
  }
  if (!(await tryRun([`${local}/AnthropicClaude/claude.exe`, s.link]))) return
  const err = await tryRun(['rundll32', 'url.dll,FileProtocolHandler', s.link])
  if (err) $.ui.toast(`Could not open ${s.title}: ${err.slice(0, 200)}`)
}

// ---- Each session writes its own info for the panels of every session to read ----
// Key `info.<local_ id>`: one key per session, so two sessions never overwrite each other.
// `$.session.id()` is not the `local_…` id list_sessions uses, so ask get_session once.
let selfId = ''

async function mySessionId($: EngineInterface): Promise<string> {
  if (selfId) return selfId
  const self = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
  selfId = tryParse(self)?.sessionId ?? ''
  return selfId
}

// A brand-new session: the app's tools are not connected yet, or it cannot check their
// permissions yet ("Session state unavailable", a red error in a new session, 2026-10-30).
// Both pass in a moment: show the spinner and try again, never an error
const NOT_READY = /no connected MCP tool|Session state unavailable/i

// The app's store file for this plugin can be left broken (half written: a power cut, or two
// sessions saving at once; a person's panel stayed blank, 2026-11-11). The app then refuses every
// read and write. The path is in its own error: keep a copy as `.broken`, start the file empty
// ({}: every setting falls back to its default), and say so once
const BROKEN_STORE = /store file (.+?\.json) is malformed/
let repairing: Promise<boolean> | undefined
async function repairStore($: EngineInterface, err: unknown): Promise<boolean> {
  const path = String(err).match(BROKEN_STORE)?.[1]
  if (!path) return false
  repairing ??= (async () => {
    try {
      const text = String(await $.fs.read(path))
      try {
        JSON.parse(text)
        return false
      } catch {}
      await $.fs.write(`${path}.broken`, text)
      await $.fs.write(path, '{}')
      $.ui.toast('Smart sessions: the saved settings were broken and have been reset (pins, folds, colors).')
      $.ui.invalidate('ui.render')
      return true
    } catch {
      return false
    }
  })().finally(() => {
    repairing = undefined
  })
  return repairing
}

// Each session's info file: written by that session only. Before 1.4.3 it was the store's
// `info.<id>` key: read once from there while the file does not exist yet
const infoPath = async ($: EngineInterface, id: string) => `${await dataDir($)}/sessions/${id}.json`
async function readInfo($: EngineInterface, id: string): Promise<SessionInfo> {
  const raw = (await readJson($, await infoPath($, id))) ?? (await $.store.get(`info.${id}`).catch(() => undefined))
  return cleanInfo(raw)
}

// One write at a time inside this session, so two events cannot lose each other's change
let infoQueue: Promise<void> = Promise.resolve()

function saveInfo($: EngineInterface, change: (info: SessionInfo) => SessionInfo) {
  infoQueue = infoQueue.then(async () => {
    try {
      const id = await mySessionId($)
      if (!id) return
      const old = await readInfo($, id)
      const next = change(old)
      // Whatever this save is for, fill in the model if it is still missing
      if (!next.model) next.model = await $.session.model()
      // Only a real change is written (the time alone is not one)
      if (stable({ ...next, at: undefined }) === stable({ ...old, at: undefined })) return
      await $.fs.write(await infoPath($, id), JSON.stringify({ ...next, at: new Date().toISOString() }))
      pulse($)
    } catch (err) {
      // A brand-new session's app tools are not connected yet; a later event saves again
      if (NOT_READY.test(String(err))) return
      if (await repairStore($, err)) return
      $.ui.toast(`Smart sessions: could not save info: ${String(err).slice(0, 200)}`)
    }
  })
}

// Last reply as one short line
function shortText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

// The ids inside background task end notifications: <task-id>biblim19g</task-id>.
// One message can carry several, when tasks finish close together.
// An agent that stops while its own background work still runs notifies too, but it is not
// done ("waiting on its own background work", 2026-11-04): that one keeps the task
function notifiedTaskIds(text: string): string[] {
  return text
    .split('<task-notification>')
    .filter(block => !/waiting on its own background work|background work of its own still running/i.test(block))
    .flatMap(block => [...block.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1]))
}

// Skip the call while the panel is closed
// Only the session on screen keeps the panel (FutaraDragon's idea, 2026-10-30): every session
// docked its own and refreshed it every 5 s, so many sessions froze the app, and a pane the app
// opened by itself (an artifact) cut the panel in half; reopened fresh on arrival, it is whole.
// Split view: only the right-most session pane keeps it. The others close theirs, and open it
// again when they are on screen and right-most. A panel the person closed by hand is never reopened:
// only a close made here is remembered
let closedForSplit = false
const LAYOUT_MS = 1_000 // a local call, no tokens: the panel follows the panes within a second
// Off screen the check runs every 5th tick only (session.attach also runs it at once)
const OFF_SCREEN_EVERY = 5
let seenOnScreen = true
let lastKeep = true
let layoutTick = 0
// Our own close (off screen or split) is never the person's: on macOS it came as 'person' and
// turned the panel off everywhere (2026-10-30)
let closingByUs = false

// The sessions on screen now (every pane of the main window), shown as active on their cards
const onScreen = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'onScreen' } as const, [])

// Does this session keep the panel: no split, or it is the right-most session pane.
// Unreadable layout: keep it (the panel behaves as before split support)
async function readLayout($: EngineInterface): Promise<{ keep: boolean; ids: string[] }> {
  try {
    const result: any = await $.mcp.call('ccd_window', 'get_window_layout', {})
    const layout = JSON.parse(result?.content?.[0]?.text ?? '{}')
    const panes = ((layout?.main_window?.panes ?? []) as any[]).filter(p => p.kind === 'session')
    const inSplit = panes.length > 1 && panes.some(p => p.is_this_session)
    const rightMost = [...panes].sort((a, b) => b.col - a.col || a.row - b.row)[0]
    const shown = layout?.this_session?.on_screen !== false
    seenOnScreen = shown
    lastKeep = shown && (!inSplit || !!rightMost?.is_this_session)
    return { keep: lastKeep, ids: panes.map(p => String(p.session_id)) }
  } catch {
    return { keep: true, ids: [] }
  }
}

// The panel is on or off for every session at once (FutaraDragon, 2026-10-30): closing it by
// hand turns it off everywhere, the command turns it on again. Off, no session opens it
const PANEL_OFF_KEY = 'panelOff'
let autoOpenSetting = true

async function panelOff($: EngineInterface): Promise<boolean> {
  return (await $.store.get(PANEL_OFF_KEY).catch(() => false)) === true
}

async function keepOnePanel($: EngineInterface) {
  const { keep, ids } = await readLayout($)
  const before = (await read($, onScreen)) as string[]
  if (before.join() !== ids.join()) {
    await update($, onScreen, () => ids)
    // Another session came on screen: its unread is read now
    if (before.length > 0) void refreshIfOpen($)
  }
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!keep && isOpen) {
    closingByUs = true
    await $.ui.close({ id: PANE }).finally(() => { closingByUs = false })
    closedForSplit = true
    $.ui.invalidate('ui.render')
  } else if (keep && !isOpen && (closedForSplit || autoOpenSetting) && !(await panelOff($))) {
    closedForSplit = false
    await openPanel($)
    void refresh($)
    $.ui.invalidate('ui.render')
  }
}

// The PR of each session, from the app's cache (ccd_pr get_status: local, no tokens). Only the
// session that owns the panel, or the band when no panel is open, asks; the others read it
const PR_KEY = 'prs'
const prs = atom({ plugin: 'fdcd-smart-active-session-panel', key: 'prs' } as const, {})

function prOpen(state: unknown): boolean {
  const s = String(state ?? '').toLowerCase()
  return s !== '' && !/merged|closed/.test(s)
}

async function readPrs($: EngineInterface, ids: string[]) {
  const saved = (await readShared($)).prs ?? {}
  const next: Record<string, string> = { ...saved }
  for (const id of ids) {
    try {
      const result: any = await $.mcp.call('ccd_pr', 'get_status', { session_id: id })
      const status = parse(result)
      next[id] = status?.bound ? String(status?.pr?.state ?? status?.state ?? 'open') : ''
    } catch {}
  }
  await writeShared($, { prs: next })
  await update($, prs, () => next)
}

// No panel in this session: the band above the prompt shows the limits, this session's context
// and PR. The right-most session on screen asks for the live numbers, the rest read the saved
let bandShown = false

// The timer only follows the band shown or hidden (local); the numbers come on a pulse
async function bandTick($: EngineInterface, full = false) {
  if (!seenOnScreen) return
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  const show = !isOpen && ((await panelOff($)) || !autoOpenSetting)
  // Another session turned the panel on or off: draw the band again, shown or hidden
  const appeared = show && !bandShown
  if (show !== bandShown) $.ui.invalidate('ui.render')
  bandShown = show
  if (!show || (!full && !appeared)) return
  const limitsNow = await readLimits($, lastKeep)
  await update($, limits, () => limitsNow)
  const themeMode = await readThemeMode($)
  await update($, theme, () => themeMode)
  if (lastKeep) await readPrs($, (await read($, onScreen)) as string[])
  else {
    const saved = (await readShared($)).prs ?? {}
    await update($, prs, () => saved)
  }
  $.ui.invalidate('ui.render')
}

async function refreshIfOpen($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) await refresh($)
}

export const register: Register = (on, options) => {
  // The "Open the panel in every new session" setting (plugin.json userConfig); on by default
  const autoOpen = (options as any)?.autoOpen !== false
  autoOpenSetting = autoOpen

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fdcd-smart-active-session-panel',
      description: 'Open the panel of recently active sessions',
    })
    $.clock.every(PULSE_MS, () => void pulseTick($))
    $.clock.every(REFRESH_MS, () => void bandTick($))
    $.clock.every(LAYOUT_MS, () => {
      layoutTick += 1
      if (seenOnScreen || layoutTick % OFF_SCREEN_EVERY === 0) void keepOnePanel($)
    })
    // Check the split first, or a left pane showed the panel for a few seconds (2026-10-27)
    if (autoOpen && (await readLayout($)).keep && !(await panelOff($))) {
      await openPanel($)
      void refresh($)
    } else if (autoOpen) {
      closedForSplit = true
    } else {
      void refreshIfOpen($)
    }
    const model = await $.session.model()
    saveInfo($, info => ({ ...info, model }))
    return next(e)
  })

  // The person opens or leaves this session: everything in it so far counts as seen
  on('session.attach', async ($, e, next) => {
    saveInfo($, info => ({ ...info, seenAt: new Date().toISOString() }))
    seenOnScreen = true // check every second again: the layout may not show this session yet
    void keepOnePanel($)
    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    saveInfo($, info => ({ ...info, seenAt: new Date().toISOString() }))
    return next(e)
  })

  // The session closes cleanly: its background tasks end with it, so forget them
  on('session.end', async ($, e, next) => {
    saveInfo($, info => ({ ...info, tasks: {} }))
    await infoQueue
    return next(e)
  })

  // Context % after each turn; the model too, in case it was switched
  on('session.measure', async ($, e, next) => {
    const usage = await $.session.usage()
    const model = await $.session.model()
    saveInfo($, info => ({
      ...info,
      model,
      contextPercent: usage.context?.percent,
      contextTokens: usage.context?.tokens,
      contextWindow: usage.context?.window,
    }))
    void saveLimits($, usage)
    return next(e)
  })

  on('command.run', { command: 'fdcd-smart-active-session-panel' }, async $ => {
    await $.store.set(PANEL_OFF_KEY, false)
    await openPanel($)
    void refresh($)
    $.ui.invalidate('ui.render')
    return { text: 'Smart Active Sessions panel opened.' }
  })

  // The person closes the panel: off for every session until the command opens it again
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin?.kind === 'person' && !closingByUs && (await readLayout($)).keep) {
      await $.store.set(PANEL_OFF_KEY, true)
    }
    const closed = await next(e)
    if (e.id === PANE) $.ui.invalidate('ui.render')
    return closed
  })

  // A background task starts: its id is in the tool's result
  // A question for the person: the question panel and plan approval wait inside the tool
  // call (asking from start to answer); the end-of-turn box (wrap_up) asks only with `ask`,
  // and its call returns at once, so that asking ends with the person's next message
  on('tool.call', async ($, e, next) => {
    const tool = String((e as any).tool)
    const waits = tool === 'AskUserQuestion' || tool === 'ExitPlanMode'
    if (waits || (/wrap_up$/.test(tool) && (e as any).ask)) {
      saveInfo($, info => ({ ...info, asking: true }))
      void refreshIfOpen($)
    }
    const result = await next(e)
    if (waits) {
      saveInfo($, info => ({ ...info, asking: false }))
      void refreshIfOpen($)
    }
    const said = String((result as any)?.text ?? '')
    const isAgent = /^(Agent|Task)$/.test(tool) && /agent launched/i.test(said)
    const taskId = (result as any)?.result?.backgroundTaskId ?? (isAgent ? said.match(/agentId: (\w+)/)?.[1] : undefined)
    // Only the main loop's: a task a subagent starts ends with a notice to that subagent, never
    // to this session, so it stayed red-orange forever (2026-11-04)
    if (!(e as any).agentId && ((e as any).run_in_background || isAgent) && taskId) {
      const task: TaskInfo = {
        description: String((e as any).description ?? e.tool),
        // "Output is being written to: C:\…\tasks\<id>.output. You will be notified…"
        output: said.match(/(?:written to|output_file): (.+?\.output)/)?.[1],
      }
      saveInfo($, info => ({ ...info, tasks: { ...info.tasks, [taskId]: task } }))
    }
    return result
  })

  // A background task ends: the app wakes the session with a <task-notification>
  on('prompt.submit', async ($, e, next) => {
    const ended = e.origin?.kind === 'task-notification' ? notifiedTaskIds(e.text) : []
    if (ended.length > 0) {
      saveInfo($, info => {
        const tasks = { ...info.tasks }
        for (const id of ended) delete tasks[id]
        return { ...info, tasks }
      })
    }
    // The person's own message answers whatever the session asked
    if (e.origin?.kind !== 'task-notification') saveInfo($, info => (info.asking ? { ...info, asking: false } : info))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    pulse($)
    void refreshIfOpen($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (done?.text) saveInfo($, info => ({ ...info, reply: shortText(done.text) }))
    pulse($)
    void refreshIfOpen($)
    return done
  })

  // A card (card.tsx) posts { open: <session id> } on a click, { pin: <session id> } on its ◆ / ◇;
  // { fold: <session id> } on its ▾ / ▸; the pager (hit.tsx) posts { scroll: 'prev' | 'next' }
  on('ui.message', async ($, e) => {
    const data = e.data as any
    if (data?.scroll) {
      await scrollList($, String(data.scroll))
      return {}
    }
    // A folder row (folder.tsx): the dot rerolls its color, the name picks it as the filter
    if (data?.reroll) {
      await rerollColor($, String(data.reroll))
      return {}
    }
    if (data?.pick) {
      await update($, filter, () => String(data.pick))
      await update($, listOffset, () => 0)
      return {}
    }
    if (data?.fold) {
      await toggleFold($, String(data.fold))
      return {}
    }
    // The header labels (hit.tsx over their SVGs)
    if (data?.act === 'folders') {
      await toggleFolders($)
      return {}
    }
    if (data?.act === 'refresh') {
      await refresh($)
      return {}
    }
    if (data?.act === 'range') {
      await toggleRange($)
      return {}
    }
    if (data?.range) {
      await pickRange($, Number(data.range))
      await refresh($)
      return {}
    }
    if (data?.act === 'sort') {
      await toggleSort($)
      return {}
    }
    if (data?.act === 'plain') {
      await togglePlain($)
      return {}
    }
    if (data?.act === 'pins') {
      await togglePins($)
      return {}
    }
    if (data?.act === 'expand') {
      await $.store.set(PANEL_OFF_KEY, false)
      await openPanel($)
      void refresh($)
      $.ui.invalidate('ui.render')
      return {}
    }
    if (data?.act === 'new') {
      await openLink($, NEW_SESSION_LINK, 'a new session')
      return {}
    }
    if (data?.pin) {
      await togglePin($, String(data.pin))
      return {}
    }
    const s = (await read($, sessions)).find(r => r.id === data?.open)
    if (s) await openSession($, s)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e as any).hasSurvey) return next(e)
    // Only while no big panel is on screen (FutaraDragon, 2026-11-04): the panel is off for every
    // session, or never opens by itself. In split view the left panes stay empty beside the panel
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen || (!(await panelOff($)) && autoOpenSetting)) return next(e)
    const { Box, Text, Client, Svg } = $.ui.resolve(e) as any
    const bandMode = await read($, theme)
    const tones = themeColors(bandMode)
    const ink = tones.ink ?? '#8a8a8a'
    const rest = tones.rest ?? '#555555'
    const id = await mySessionId($).catch(() => '')
    const info = id ? await readInfo($, id) : undefined
    const context = Math.max(0, Math.min(100, Number(info?.contextPercent) || 0))
    const pr = prOpen(((await read($, prs)) as Record<string, string>)[id])
    const usage = (await read($, limits)) as UsageLimit[]
    // Hover names a part: the app draws it as a floating tooltip above the band. A plugin can not
    // close it, so it may stay open until the next hover (app limit, every try in NOTES 1.4.2)
    const bandBg = tones.ink === '#000000' ? '#f0f0f0' : '#262626'
    const tipBox = (_key: string, tip: string, width?: number) => (
        <Box position="absolute" top={0} left={0} right={width === undefined ? 0 : undefined} bottom={0} width={width}
          display="none" hover={{ display: 'flex' }} backgroundColor={bandBg} paddingLeft={1} alignItems="center">
          <Text dimColor wrap="truncate-end">{tip}</Text>
        </Box>
      )
    const tipLayer = (key: string, message: Record<string, string>) => (
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client key={`${key}-hit`} module="./hit.tsx" width="100%"
          props={plain({ message })} />
      </Box>
    )
    const bar = (key: string, icon: string, alt: string, percent: number, tip: string) => (
      <Box key={key} flexDirection="row" flexGrow={1} width={1} minWidth={0} alignItems="center" paddingLeft={1}>
        <Svg source={icon} alt={alt} width={14} height={16} />
        <Box flexGrow={1} minWidth={0} flexDirection="row" height={0.25} marginLeft={0.75} backgroundColor={rest}>
          {percent >= RAINBOW_AT ? (
            <Client key={`${key}-rainbow`} module="./rainbow.tsx" width="100%" props={null} />
          ) : (
            <Box width={`${percent}%`} backgroundColor={limitColor(percent)} />
          )}
        </Box>
        <Svg source={bandPercentSvg(Math.round(percent), ink)} alt={`${Math.round(percent)}%`} width={36} height={16} />
        {tipBox(key, tip)}
      </Box>
    )
    const button = (key: string, icon: string, alt: string, act: string) => (
      <Box key={key} position="relative" width={3} flexShrink={0} flexDirection="row" justifyContent="center" hover={hoverBg(bandMode)}>
        <Svg source={icon} alt={alt} width={14} height={FOLDER_PX} />
        {tipBox(key, alt, alt.length + 2)}
        {tipLayer(key, { act })}
      </Box>
    )
    return (
      <Box flexDirection="row" alignItems="center" paddingLeft={1} paddingRight={1} gap={0.5}>
        {button('band-expand', expandSvg(ink), 'Open panel', 'expand')}
        {button('band-new', plusSvg(ink), 'New session', 'new')}
        {usage.map(l =>
          bar(
            `band-${l.label}`,
            limitIconSvg(l.label, ink),
            l.label,
            Math.max(0, Math.min(100, l.percent)),
            `${l.label === '5 hours' ? '5-hour' : 'Weekly'} limit · resets in ${l.resetsAt ? resetLabel(l.resetsAt) : '-'}`,
          ),
        )}
        {bar(
          'band-context',
          contextIconSvg(ink),
          'context',
          context,
          info?.contextWindow
            ? `Context ${tokenCount(info.contextTokens ?? 0)} / ${tokenCount(info.contextWindow)}`
            : 'Context used by this session',
        )}
        {pr && <Svg key="band-pr" source={prIconSvg()} alt="open pull request" width={14} height={16} />}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Client exists on desktop and terminal only (not mobile, not VS Code)
    const { Box, Text, Button, Client, Svg } = $.ui.resolve(e) as any
    const list = await read($, sessions)
    const err = await read($, error)
    const at = await read($, updatedAt)
    const picked = await read($, filter)
    const pinnedIds = await read($, pins)
    const expandedIds = await read($, expanded)
    const isFolded = (id: string) => !expandedIds.includes(id)
    const mode = await read($, sortMode)
    const themeMode = await read($, theme)
    const tones = themeColors(themeMode)
    // The pane's background, for the fade at the end of cut card text (from screenshots;
    // unknown theme: no fade)
    const paneBg = themeMode === 'light' ? '#f2f2f2' : themeMode === 'dark' ? '#242424' : ''
    const pillColor = paneBg || '#3a3a3a'
    const pill = (color: string) => (
      <Box flexGrow={1} flexDirection="row">
        <Svg source={pillEndSvg('left', color)} alt="new session" width={FOLDER_PX / 2} height={FOLDER_PX} />
        <Box flexGrow={1} flexDirection="row" justifyContent="center" backgroundColor={color}>
          <Svg source={plusSvg(tones.ink ?? '#8a8a8a')} alt="new session" width={14} height={FOLDER_PX} />
        </Box>
        <Svg source={pillEndSvg('right', color)} alt="new session" width={FOLDER_PX / 2} height={FOLDER_PX} />
      </Box>
    )
    const usageBars = await read($, limits)
    const shownIds = (await read($, onScreen)) as string[]
    const foldersOpen = await read($, foldersOpenAtom)
    const days = await read($, rangeDays)
    const showRange = await read($, rangeOpen)
    const isConnecting = await read($, connecting)
    const colors = await read($, groupColors)
    const plainMode = await read($, plainAtom)
    const paint = (groupId: string | undefined) => (groupId === undefined ? undefined : plainMode ? tones.ink ?? '#8a8a8a' : colors[groupId])
    // Each group once, in the order the list first shows it
    const groups = [...new Map(list.filter(s => s.group).map(s => [s.group!.id, s.group!])).values()]
    // A picked group that is no longer in the list falls back to All
    const f = groups.some(g => g.id === picked) ? picked : 'all'
    const shown = filtered(list, f)
    const pinsOpen = await read($, pinsOpenAtom)
    const isPinned = (s: RecentSession) => pinnedIds.includes(s.id)
    const pinCount = shown.filter(isPinned).length
    const groupPins = mode === 'pinned' && pinCount > 0
    const listed = groupPins && !pinsOpen ? shown.filter(s => !isPinned(s)) : shown
    const pick = (value: string) => {
      void update($, filter, () => value)
      void update($, listOffset, () => 0)
    }
    // What each shown session wrote about itself (empty for sessions without this mod)
    const prStates = (await read($, prs)) as Record<string, string>
    const infos: Record<string, SessionInfo | undefined> = {}
    const taskTitles: Record<string, string[]> = {}
    for (const s of shown) {
      infos[s.id] = await readInfo($, s.id)
      taskTitles[s.id] = await liveTasks($, infos[s.id])
    }
    const bodyRows = Number((e as any).props?.scroll?.bodyRows) || 0
    const bodyColumns = Number((e as any).props?.bodyColumns) || 0
    const weekly = usageBars.find(l => l.label === 'weekly')
    const fireworksMark = (await $.store.get(FIREWORKS_KEY)) as FireworksMark | undefined
    const showFireworks =
      !!weekly &&
      weekly.percent >= FIREWORKS_AT &&
      fireworksMark?.resetsAt === (weekly.resetsAt ?? '') &&
      Date.now() - fireworksMark.at < FIREWORKS_MS
    // Kept inside the pane: 10.5 px per column and 20 per row drew past the right edge and made
    // the app show a scrollbar (1.2.1-test1)
    const fireworksW = Math.round(bodyColumns * 9)
    const fireworksH = Math.round((bodyRows - 1) * 18)
    // The list area: the pane, less box 1, less box 2's border and its bars
    // + one row per folder shown, and two rows (text, bar) + a half-row gap for the usage
    const shownFolders = groups.filter(g => foldersOpen || g.id === f).length
    const box1Rows = BOX1_ROWS + 1 + shownFolders + 1.5 + (usageBars.length > 0 ? 2.5 : 0)
    // An estimate: a mod is never told a box's real height. A Client "ruler" inside an absolute
    // box was tried and always read 1 row (height 100% and flexGrow both, 2026-10-14).
    const rows = listed.map(s => cardRows(taskTitles[s.id].length, isFolded(s.id)))
    // The pinned header tops the first page, and any page that starts inside the pinned cards
    const head = (i: number, p: number) => (groupPins && (p === 0 || (listed[i] && isPinned(listed[i]))) ? PIN_HEAD_ROWS : 0)
    // All on one page: no pager. Else split again with the pager's row taken off the area
    let starts = pageStarts(rows, bodyRows - box1Rows, head)
    if (starts.length > 1) starts = pageStarts(rows, bodyRows - box1Rows - PAGER_ROWS, head)
    lastPageCount = starts.length
    const page = Math.min(starts.length - 1, Number(await read($, listOffset)) || 0)
    const pageCards = listed.slice(starts[page], starts[page + 1] ?? listed.length)
    const showPinHead = head(starts[page], page) > 0
    const pageArrow = (dir: 'prev' | 'next') => (
      <Box key={`page-${dir}`} position="relative" width={3} flexShrink={0}>
        {hov(Box, Svg, hoverColor(themeMode), { source: pageArrowSvg(dir, tones.ink ?? '#8a8a8a', dir === 'prev' ? page === 0 : page >= starts.length - 1), alt: dir === 'prev' ? 'previous page' : 'next page', width: 14, height: 16 })}
        <Box position="absolute" top={0} left={0} right={0} bottom={0}>
          <Client key={`page-hit-${dir}`} module="./hit.tsx" width="100%" props={plain({ message: { scroll: dir } })} />
        </Box>
      </Box>
    )

    return (
      // Half a row under the pane's height, so the app shows no scrollbar
      <Box flexDirection="column" height={Math.max(0, bodyRows - 0.5)} position="relative">
        <Box key="box1" flexDirection="column" flexShrink={0}>
          {/* The very top, asked back by the team (2026-10-27): when the list was updated, and a
              click anywhere on the line refreshes it now */}
          <Box key="top-row" flexDirection="row" justifyContent="space-between" marginBottom={0.5}>
          <Box key="updated" position="relative" flexShrink={0}>
            {hov(Box, Svg, hoverColor(themeMode), { source: fitLabelSvg(
                [
                  { text: at ? `updated ${timeLabel(at)}` : 'loading…', dim: true },
                  { text: '↻', dim: false },
                ],
                tones.ink ?? '#8a8a8a',
              ), alt: "updated, click to refresh", height: FOLDER_PX })}
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client key="updated-hit" module="./hit.tsx" width="100%" props={plain({ message: { act: 'refresh' } })} />
            </Box>
          </Box>
          <Box key="version" width={Math.max(6, Math.ceil((VERSION.length + 1) * 0.8) + 1)} flexShrink={0}>
            <Svg source={labelSvg([{ text: `v${VERSION}`, dim: true }], tones.ink ?? '#8a8a8a', true)} alt={`version ${VERSION}`} height={FOLDER_PX} />
          </Box>
          </Box>
          {/* The account's usage, side by side: each half is one SVG (icon, percent, thin bar,
              small reset time; see limitSvg) */}
          {usageBars.length > 0 && (
            <Box flexDirection="row" marginBottom={0.5}>
              {usageBars.map((l, i) => (
                <Box
                  key={`limit-${l.label}`}
                  flexDirection="column"
                  width="50%"
                  minWidth={0}
                  paddingRight={i === 0 ? 1 : 0}
                  paddingLeft={i === 0 ? 0 : 1}
                >
                  <Box flexDirection="row" justifyContent="space-between">
                    <Svg source={limitIconSvg(l.label, tones.ink ?? '#8a8a8a')} alt={l.label} width={14} height={16} />
                    <Svg source={limitPercentSvg(Math.round(l.percent), tones.ink ?? '#8a8a8a')} alt={`${l.percent}%`} width={40} height={16} />
                  </Box>
                  {/* Round ends: a Box has no radius, so each end is a tiny half-circle SVG */}
                  <Box flexDirection="row" height={0.25} marginTop={0.25}>
                    <Svg
                      source={capSvg('left', l.percent > 0 ? limitColor(l.percent) : tones.rest ?? '#555555', '', l.percent >= RAINBOW_AT)}
                      alt="bar end"
                      width={CAP_PX}
                      height={BAR_PX}
                      isInteractive={l.percent >= RAINBOW_AT}
                    />
                    <Box flexGrow={1} flexDirection="row" backgroundColor={tones.rest ?? '#555555'}>
                      {l.percent >= RAINBOW_AT ? (
                        <Client key={`rainbow-${l.label}`} module="./rainbow.tsx" width="100%" props={null} />
                      ) : (
                        <Box width={`${Math.max(0, l.percent)}%`} backgroundColor={limitColor(l.percent)} />
                      )}
                      {l.percent > 0 && l.percent < RAINBOW_AT && (
                        <Svg
                          source={capSvg('right', limitColor(l.percent), tones.rest ?? '#555555')}
                          alt="bar end"
                          width={CAP_PX}
                          height={BAR_PX}
                        />
                      )}
                    </Box>
                    <Svg
                      source={capSvg('right', l.percent >= RAINBOW_AT ? limitColor(100) : tones.rest ?? '#555555', '', l.percent >= RAINBOW_AT)}
                      alt="bar end"
                      width={CAP_PX}
                      height={BAR_PX}
                      isInteractive={l.percent >= RAINBOW_AT}
                    />
                  </Box>
                  <Svg
                    source={limitResetSvg(l.resetsAt, tones.ink ?? '#8a8a8a')}
                    alt={`reset in ${resetLabel(l.resetsAt)}`}
                    width={120}
                    height={14}
                  />
                </Box>
              ))}
            </Box>
          )}
          {/* Then: All, the folder list's fold toggle, and the sort mode on the right */}
          {/* Each label is its own SVG box with hit.tsx on top. Box width is in text columns
              (~10 px each), not px: 84 pushed "sort by" off the pane (test15) */}
          {/* How far back: "show: last N days", click opens the choices (FutaraDragon, 2026-11-12) */}
          <Box key="range-row" flexDirection="row">
            {[
              {
                key: 'range',
                parts: [
                  { text: 'show:', dim: true },
                  { text: `last ${days === 1 ? '24 h' : `${days} days`} ${showRange ? '▾' : '▸'}`, dim: false },
                ],
                message: { act: 'range' },
              },
              ...(showRange
                ? RANGE_CHOICES.map(n => ({ key: `range-${n}`, parts: [{ text: `${n}d`, dim: n !== days }], message: { range: String(n) } }))
                : []),
            ].map(l => (
              <Box key={`label-${l.key}`} position="relative" flexShrink={0}>
                {hov(Box, Svg, hoverColor(themeMode), { source: fitLabelSvg(l.parts, tones.ink ?? '#8a8a8a', l.key === 'range' ? 5 : 6), alt: l.parts.map(p => p.text).join(' '), height: FOLDER_PX })}
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key={`label-hit-${l.key}`} module="./hit.tsx" width="100%" props={plain({ message: l.message })} />
                </Box>
              </Box>
            ))}
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              <Box key="label-plain" position="relative" width={3} flexShrink={0}>
                {hov(Box, Svg, hoverColor(themeMode), { source: plainDotSvg(plainMode, tones.ink ?? '#8a8a8a'), alt: plainMode ? 'colors off' : 'colors on', width: 14, height: FOLDER_PX })}
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key="label-hit-plain" module="./hit.tsx" width="100%" props={plain({ message: { act: 'plain' } })} />
                </Box>
              </Box>
              {[
                { key: 'all', cols: 3, parts: [{ text: 'All', dim: f !== 'all' }], message: { pick: 'all' } },
                {
                  key: 'folders',
                  cols: 6,
                  parts: [{ text: foldersOpen ? 'folders ▾' : 'folders ▸', dim: true }],
                  message: { act: 'folders' },
                },
              ].map(l => (
                <Box key={`label-${l.key}`} position="relative" flexShrink={0}>
                  {hov(Box, Svg, hoverColor(themeMode), { source: fitLabelSvg(l.parts, tones.ink ?? '#8a8a8a'), alt: l.parts[0].text, height: FOLDER_PX })}
                  <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                    <Client key={`label-hit-${l.key}`} module="./hit.tsx" width="100%" props={plain({ message: l.message })} />
                  </Box>
                </Box>
              ))}
            </Box>
            <Box key="label-sort" position="relative" flexShrink={0}>
              {hov(Box, Svg, hoverColor(themeMode), { source: fitLabelSvg(
                  [
                    { text: 'sort by:', dim: true },
                    { text: mode === 'pinned' ? 'pinned' : 'time', dim: false },
                  ],
                  tones.ink ?? '#8a8a8a',
                ), alt: "sort by", height: FOLDER_PX })}
              <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                <Client key="label-hit-sort" module="./hit.tsx" width="100%" props={plain({ message: { act: 'sort' } })} />
              </Box>
            </Box>
          </Box>
          {/* One row per folder: an SVG (small text) with folder.tsx on top catching clicks.
              Folded, only the chosen folder stays. A Client on an absolute box is one row tall
              whatever its size (test11), so each row gets its own */}
          {groups
            .filter(g => foldersOpen || g.id === f)
            .map(g => (
              <Box key={`folder-${g.id}`} position="relative">
                {hov(Box, Svg, hoverColor(themeMode), { source: folderSvg(g.name, paint(g.id) ?? '#8a8a8a', tones.ink ?? '#8a8a8a', f === g.id), alt: g.name, height: FOLDER_PX })}
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client
                    key={`folder-hit-${g.id}`}
                    module="./folder.tsx"
                    width="100%"
                    props={plain({ id: g.id, color: colors[g.id] })}
                  />
                </Box>
              </Box>
            ))}
          {/* New session: a long button under the folder list (FutaraDragon, 2026-10-28). Round
              SVG ends and a Box between that stretches: one SVG pill stopped at ~400 px in a wide
              pane (an Svg cannot take width 100%), 2026-11-11 */}
          <Box key="new-session" position="relative" marginTop={0.5} flexDirection="row">
            {pill(pillColor)}
            <Box position="absolute" top={0} left={0} right={0} display="none" hover={{ display: 'flex' }}>
              {pill(themeMode === 'light' ? '#d0d0d0' : '#4a4a4a')}
            </Box>
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client key="new-session-hit" module="./hit.tsx" width="100%" props={plain({ message: { act: 'new' } })} />
            </Box>
          </Box>
        </Box>
        <Box key="box2" flexDirection="column" flexGrow={1} marginTop={0.5}>
        {/* The list area is sized by flex only; the inner list is absolute, so it adds no height */}
        <Box flexDirection="column" flexGrow={1} position="relative" overflow="hidden">
        {/* Nothing to list: a message in the middle ("updated" is empty until the first load) */}
        {shown.length === 0 && err === '' && (
          <Box position="absolute" top={0} bottom={0} left={0} right={0} justifyContent="center" alignItems="center">
            {at && !isConnecting ? (
              <Text dimColor>No sessions.</Text>
            ) : (
              <Svg source={spinnerSvg(tones.ink ?? '#8a8a8a')} alt="Loading" width={24} height={24} isInteractive />
            )}
          </Box>
        )}
        <Box flexDirection="column" position="absolute" top={0} left={0} right={0} gap={0.25}>
        {err !== '' && <Text color="red">{err}</Text>}
        {showPinHead && (
          <Box key={`pin-head-${pinsOpen ? 'open' : 'shut'}`} position="relative" flexShrink={0}>
            {hov(Box, Svg, hoverColor(themeMode), { source: pinHeadSvg(pinsOpen, pinCount, tones.ink ?? '#8a8a8a'), alt: "pinned", height: FOLDER_PX })}
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client key="pin-head-hit" module="./hit.tsx" width="100%" props={plain({ message: { act: 'pins' } })} />
            </Box>
          </Box>
        )}
        {pageCards.map(s => {
          const info = infos[s.id]
          const color = paint(s.group?.id)
          const tasks = taskTitles[s.id]
          const folded = isFolded(s.id)
          const pinned = pinnedIds.includes(s.id)
          const ink = tones.ink ?? '#8a8a8a'
          // A pinned card stands out: a little lighter in dark mode, a little darker in light
          const cardBg = paneBg === '' ? '' : pinned ? (themeMode === 'light' ? '#e4e4e4' : '#303030') : paneBg
          const percent = Math.max(0, Math.min(100, Number(info?.contextPercent) || 0))
          const running = s.isRunning || tasks.length > 0
          const unseen =
            !s.isSelf && !!info?.seenAt && new Date(s.lastActivityAt).getTime() > new Date(info.seenAt).getTime()
          // Asking flashes blue (a waiting question panel also counts as running, so it wins),
          // else working yellow, else unseen green, else on screen (this session, or any pane of
          // a split view) in the text color, else gray
          const active = s.isSelf || shownIds.some(id => id === s.id || id === `local_${s.id}` || `local_${id}` === s.id)
          const asking = !!info?.asking
          // On screen = seen: never green. On screen and busy/asking: split stripe (stripeSvg)
          const border = asking ? ASK_COLOR : tasks.length > 0 ? HELPER_COLOR : running ? '#e5c07b' : unseen && !active ? '#98c379' : active ? ink : tones.rest ?? '#4a4a4a'
          const stripeTop = active && (asking || running) ? ink : ''
          // Each row: its SVG, with a 1-row click layer (card.tsx) on top, as the folder rows.
          // Cards drawn by a Client under SVG text were refused in test25-27, for a reason never
          // found (not the layering: the fireworks lie over every Client and draw fine)
          const row = (key: string, title: boolean, content: any) => (
            <Box key={key} position="relative" width="100%">
              {content}
              <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                <Client key={`${key}-hit`} module="./card.tsx" width="100%" props={plain({ id: s.id, title } as CardProps)} />
              </Box>
              {title && (
                <Box position="absolute" top={0} right={0} flexDirection="row">
                  {iconHover(Box, Svg, Client, `fold-${s.id}`, chevronSvg(folded, ink), { fold: s.id }, themeMode)}
                  <Box width={1} />
                  {iconHover(Box, Svg, Client, `pin-${s.id}`, pinSvg(pinned, color ?? ink, ink), { pin: s.id }, themeMode)}
                </Box>
              )}
            </Box>
          )
          // Text that may be cut at the card's edge: clipped, with a soft fade at the right end
          const faded = (svg: any) => (
            <Box flexGrow={1} minWidth={0} overflow="hidden" position="relative">
              {svg}
              {cardBg !== '' && (
                <Box position="absolute" top={0} right={0}>
                  <Svg source={fadeSvg(cardBg)} alt="fade" width={FADE_PX} height={FOLDER_PX} />
                </Box>
              )}
              {cardBg !== '' && (
                <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex', scope: `card-${s.id}` }}>
                  <Svg source={fadeSvg(hoverColor(themeMode))} alt="fade" width={FADE_PX} height={FOLDER_PX} />
                </Box>
              )}
            </Box>
          )
          // The key holds the card's shape, so a fold or a new task makes a fresh card; left
          // alone, a reshaped card kept its old height (2026-10-26)
          const shape = `${folded ? 'mini' : 'full'}-${tasks.length}`
          return (
            // No border: a Box border reserves about half a row above and below its line, which
            // no margin could reach (test34). A lighter background and a status stripe instead
            <Box
              key={`card-${s.id}-${shape}`}
              flexDirection="row"
              flexShrink={0}
              backgroundColor={cardBg || undefined}
              hover={{ ...hoverBg(themeMode), scope: `card-${s.id}` }}
              paddingY={0.25}
              paddingRight={1}
              position="relative"
            >
              {paneBg !== '' &&
                (['tl', 'tr', 'bl', 'br'] as const).map(c => (
                  <Box
                    key={`corner-${c}`}
                    position="absolute"
                    top={c[0] === 't' ? 0 : undefined}
                    bottom={c[0] === 'b' ? 0 : undefined}
                    left={c[1] === 'l' ? 0 : undefined}
                    right={c[1] === 'r' ? 0 : undefined}
                  >
                    <Svg source={cornerSvg(c, paneBg)} alt="corner" width={CORNER_PX} height={CORNER_PX} />
                  </Box>
                ))}
              <Svg
                source={stripeSvg(border, cardPx(tasks.length, folded) - ROW_PX / 2, running, tones.rest ?? '#4a4a4a', asking, stripeTop)}
                alt="status"
                width={STRIPE_PX}
                height={cardPx(tasks.length, folded) - ROW_PX / 2}
                isInteractive={running}
              />
              <Box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1}>
              {row(
                `title-${s.id}`,
                true,
                <Box flexDirection="row" width="100%">
                  {prOpen(prStates[s.id]) && (
                    <Box flexShrink={0} width={1.75}>
                      <Svg source={prIconSvg()} alt="open pull request" width={14} height={16} />
                    </Box>
                  )}
                  {faded(<Svg source={lineSvg(s.title, color ?? ink)} alt={s.title || 'session'} height={FOLDER_PX} />)}
                  <Box flexDirection="row" flexShrink={0}>
                    <Svg source={chevronSvg(folded, ink)} alt={folded ? 'open' : 'fold'} width={14} height={16} />
                    <Box width={1} />
                    <Svg source={pinSvg(pinned, color ?? ink, ink)} alt={pinned ? 'pinned' : 'pin'} width={14} height={16} />
                  </Box>
                </Box>,
              )}
              {!folded &&
                row(`reply-${s.id}`, false, faded(<Svg source={lineSvg(info?.reply || '…', ink, 0.7)} alt="last reply" height={FOLDER_PX} />))}
              {!folded &&
                tasks.map((title, i) =>
                  row(`task-${s.id}-${i}`, false, faded(<Svg source={lineSvg(title, ink, 0.7, color ?? ink)} alt={title || 'task'} height={FOLDER_PX} />)),
                )}
              {!folded &&
                row(
                  `meta-${s.id}`,
                  false,
                  <Svg
                    source={lineSvg(`${shortModel(info?.model)} · ${timeLabel(s.lastActivityAt)}`, ink, 0.7)}
                    alt="model and time"
                    height={FOLDER_PX}
                  />,
                )}
              <Box flexDirection="row" height={0.25} marginTop={0.25}>
                <Svg source={capSvg('left', percent > 0 ? limitColor(percent) : tones.rest ?? '#555555', '')} alt="bar end" width={CAP_PX} height={BAR_PX} />
                <Box flexGrow={1} flexDirection="row" backgroundColor={tones.rest ?? '#555555'}>
                  <Box width={`${percent}%`} backgroundColor={limitColor(percent)} />
                  {percent > 0 && percent < 100 && (
                    <Svg source={capSvg('right', limitColor(percent), tones.rest ?? '#555555')} alt="bar end" width={CAP_PX} height={BAR_PX} />
                  )}
                </Box>
                <Svg source={capSvg('right', percent >= 100 ? limitColor(100) : tones.rest ?? '#555555', '')} alt="bar end" width={CAP_PX} height={BAR_PX} />
              </Box>
              </Box>
            </Box>
          )
        })}
        </Box>
        </Box>
        {/* The pager, only when the cards need more than one page: ‹ page / pages ›, each
            arrow an SVG with hit.tsx on top */}
        {starts.length > 1 && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0} marginTop={0.25}>
            {pageArrow('prev')}
            <Box key="page-number">
              <Svg source={pageNumberSvg(`${page + 1} / ${starts.length}`, tones.ink ?? '#8a8a8a')} alt={`page ${page + 1} of ${starts.length}`} width={60} height={FOLDER_PX} />
            </Box>
            {pageArrow('next')}
          </Box>
        )}
        </Box>
        {/* Easter egg: fireworks over the whole panel, laid over everything, for one minute */}
        {showFireworks && (
          <Box position="absolute" top={0} left={0} right={0} bottom={0}>
            <Svg
              source={fireworksSvg(fireworksW, fireworksH)}
              alt="fireworks"
              width={fireworksW}
              height={fireworksH}
              isInteractive
            />
          </Box>
        )}
      </Box>
    )
  })
}
