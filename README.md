## Developer Rawr Zone

This is project is come up because of while I working in company so my team lead told me about Claude App release claude mod so maybe try to make some panel that solve the session panel on left side issue about too much session and can not find what work we are doing when do like multi session in same time

Setup requirement
- Claude App with plugin
- OS support Windows and Mac

Panel design
- make it minimal and clean

This panel feature
- Show active session from 24 hours to 7 days depend on setting
- Show 5 hour limit
- Show weekly limit
- Color the group for easy category
- Pin session that use in long term
- New session on panel
- Session card context limit
- Session card can show task and agent on time when another session call
- Session card status, each status show what that session doing (green = wait for read,slow flash yellow = working, fast flash blue = wait for answer, slow flash red = open task or agent)
- Minimize to small panel with new session, 5 hours limit, weekly limit, context limit

I will try to update from feedback I got and I feel like it useful to do (when I have time QwQ)

What is "fdcd" ?
- "futaradragon & claude derg" my name and my friend claude name use for prefix 

## Claude Rawr Zone

# Smart Active Sessions

A side panel for the **Claude desktop app** (Code tab). It lists the sessions you worked in
recently (**the last 2 days** by default, 1 to 7 to choose) as cards, so you can see what is going on and jump to a session in one
click, without scrolling through the sidebar.

By FutaraDragon & Claude Derg.

## What a card shows

```
▌ Session title                    ⌄ 📌   title in its folder's color · fold · pin
▌ The last reply, on one line, fading…
▌ ● Count 1 to 60, one per second         running background tasks, one row each
▌ opus-5-5 · 11:54                        model · last activity
▌ ━━━━━━━━━━━━━━──────────────────        context use
```

- **Click a card** to open that session.
- **The stripe on the left:** light blue and flashing while the session **asks you something**
  (a question box, plan approval, or answer buttons); yellow and breathing while Claude is
  working; **red-orange** and breathing while a **subagent or background task** runs (it wins
  over yellow); green when it finished and you have not looked yet;
  white (black in light mode) for the sessions on screen; gray otherwise. A session on screen
  that is also busy or asking shows white on top and its status below.
- **Pin:** a pinned session stays in the list however old it is, and its card is a little
  lighter (darker in light mode).
- **› / ⌄:** cards start folded to their title and context bar; open the ones you want, and
  the panel remembers them.
- **Context bar:** blue, yellow from 75%, red from 90%.
- **Hover:** every button, card and card icon (› and pin) lights up under the pointer, so you can
  see what is clickable. Cards have round corners (dark and light theme).
- **Green PR mark** before the title: the session has an open pull request. It goes away once
  the PR is merged or closed (read from the app's own PR cache, no tokens).

At the top: **updated hh:mm ↻** (click it to refresh now), the account's **5-hour** and
**weekly** usage bars (the same numbers as the app's usage card, with the time until each
resets), the **color dot** (click to draw every folder in plain white / black; click again
for the colors), **show: last N days** (click to choose 1d to 7d, counted in 24-hour steps
from now; pinned sessions always stay), **All**, **folders** (show or hide the folder list), one row per project
folder (click to filter; hover and click the **↻** at the right end to roll a new color),
**sort by: pinned / time**, and a long **+** button that opens a new session. Sorted by
pinned, the pinned cards sit under a **pinned (n)** row that folds them away. When the cards need more than one page, **‹ 1 / 3 ›** under the
list flips through them.

## Install

**In the desktop app** (tested):

1. Download the zip from the
   [Releases page](https://github.com/FutaraDragon/claude-fdcd-smart-active-session-panel/releases).
2. Open **Directory → Plugins**, press **+**, and choose the zip file itself (no need to
   unzip it).
3. Type `/reload-plugins` (or restart the app). The panel opens by itself in new sessions.

**Or in a terminal** (not the desktop Code tab, where `/plugin` opens the Directory instead):
start `claude` and type:

```
/plugin marketplace add FutaraDragon/claude-fdcd-smart-active-session-panel
/plugin install fdcd-smart-active-session-panel@fdcd-smart-active-session-panel
```

or, from an unzipped copy, with your own path:

```
/plugin install fdcd-smart-active-session-panel --marketplace D:\Tools\fdcd-smart-active-session-panel
```

Answer `y` to *Add marketplace?*, then press Enter for the **user** scope.

**Update:** install the new zip the same way, then `/reload-plugins`; it replaces the old one. Pins, colors and opened
cards are kept.

## Use

In any desktop Code tab session, type:

```
/fdcd-smart-active-session-panel
```

The panel opens on the right. It updates within about a second when any session changes
(a reply, a question, a background task), and when you switch sessions; it does not rebuild
the list on a timer.

It also **opens by itself in every new session**. To turn that off, change the plugin's setting
**Open the panel in every new session** (in the plugin's settings / config menu); the command
above still opens it any time.

## Good to know

- **One panel at a time:** only the session you are looking at shows the panel; the others
  close theirs and do no work, and it opens again when you come back. In a split view the
  right-most session shows it.
- **Closing the panel** (✕) turns it off in every session, and a small **band above the chat
  input** takes its place in every session on screen: **⤢** opens the panel again, **+** opens a
  new session, then the **5-hour** and **weekly** bars and this session's **context** bar (hover
  a bar for its name, reset time or token count), and the green PR mark for an open PR. While
  the panel is open there is no band. `/fdcd-smart-active-session-panel` also turns it on again.
- **Placing the panel:** drag the **Move** handle at the top of the panel (or of another
  pane, such as the browser or an artifact) to put it where you want. The app remembers this
  for each session separately; a mod cannot set it.
- **Desktop app only.** The cards are drawn with the desktop's own elements; the panel does
  not draw in the terminal or VS Code.
- **Sessions fill in as they are used.** Each session writes its own model, context use, last
  reply and tasks when it runs this mod. A session started before the install shows `model ?`,
  `…` and an empty context bar until it is restarted.
- **Windows and macOS.** On macOS the panel runs; opening a session and
  the + button (`open <link>`) are not confirmed there yet.
- **Light, dark and system themes** are read from the desktop app's settings (also for the
  Microsoft Store version of the app, which keeps them in another folder; and, under
  "system", from the operating system) so hover colors fade smoothly. This reads files the app
  owns; if a future app update changes them, the colors simply stop fading.
- **No tokens, no internet.** The session list comes from the desktop app's own local tools.
- **Where it saves.** Your clicks (pins, folds, colors, sort) are kept in the app's plugin
  store. Each session's info goes in its own file, and the usage limits and PR states in one
  shared file, both under `~/.claude/plugins/store/fdcd-smart-active-session-panel-data/`. Only
  one session at a time writes the shared file, so sessions no longer write over each other.
- **Broken settings heal themselves.** If the saved settings file is ever left broken (a power
  cut mid-save), the panel keeps a copy as `….json.broken`, starts fresh, and tells you once.
  Only pins, folds and colors are lost.
- **How it stays live without polling.** Each session that changes writes the time into a tiny
  `pulse.json` in the same folder; the panel reads that one file every second (local, cheap) and
  refreshes only when it changed. A broken or missing file just triggers one refresh and is
  written again. Sessions without the mod update when you click them.

## License

MIT. See [LICENSE](LICENSE).
