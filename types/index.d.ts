export type RecentSession = {
  id: string
  title: string
  cwd: string
  lastActivityAt: string
  link: string
  isRunning: boolean
  isSelf: boolean
  group: { id: string; name: string } | null // the project folder: id = full path, name = last part
}

// One running background task
export type TaskInfo = {
  description: string
  output?: string // its output file; a file not written for 10 min = probably dead
}

// One usage limit bar in the header
export type UsageLimit = {
  label: string // '5 hours' or 'weekly'
  percent: number
  resetsAt?: string // ISO time
}

// What each session writes about itself to `$.store` under `info.<local_ id>`
export type SessionInfo = {
  model?: string
  contextPercent?: number
  contextTokens?: number // tokens the last reply was answered over
  contextWindow?: number // the model's context window, in tokens
  reply?: string
  tasks: Record<string, TaskInfo | string> // background task id → task (a plain string = older save)
  asking?: boolean // waiting for the person: a question panel, plan approval, or an end-of-turn ask
  seenAt?: string // when the person last opened or left this session; newer activity = unseen
  at?: string
}

declare module 'claude-code' {
  interface PluginState {
    'fdcd-smart-active-session-panel': {
      sessions: RecentSession[]
      updatedAt: string
      error: string
      listOffset: number
      filter: string // 'all', or a group id
      groupColors: Record<string, string> // group id → '#rrggbb'
      pins: string[] // pinned session ids (our own pin, not the sidebar's)
      expanded: string[] // session ids whose card the person opened; every other card is folded
      sortMode: 'pinned' | 'time' // pinned first, or only by last activity
      theme: string // 'light', 'dark', or '' when unknown (read from the desktop app's config)
      limits: UsageLimit[] // the account's 5-hour and weekly usage, from $.session.usage()
      plain: boolean // folder colors drawn in the text color (the saved colors are kept)
      pinsOpen: boolean // the pinned group (sort by pinned) is open (else its cards are folded away)
      foldersOpen: boolean // the folder list in the header is open (else only the chosen folder)
      connecting: boolean // the app's session tools are not connected yet (a new session)
      onScreen: string[] // session ids shown in the main window's panes now (split view)
      prs: Record<string, string> // session id -> its PR state ('' = no PR), from ccd_pr get_status
    }
  }
}
