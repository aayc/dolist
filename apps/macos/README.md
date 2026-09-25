# Daily Do List for macOS

A native SwiftUI/AppKit client for the local Daily Do List daemon. The Mac app does what the web UI
does (daily notes, the editor with agent badges, threads, approvals, search, settings), and adds
what only a native app can: it starts and supervises the daemon itself, opens today's note from a
global shortcut, launches at login, shows agent activity in the menu bar and the Dock, and sends
native notifications for approvals.

![Screenshot placeholder: the main window with today's note, agent badges and a thread](../../docs/images/approval-thread-dark.png)

> Screenshot placeholder. It shows the web UI until native screenshots exist.

## Requirements

- macOS 14 (Sonoma) or later. Builds target the building Mac's architecture (the CI artifact is
  Apple silicon).
- **Node.js 24.4+** for the managed daemon. The app runs the daemon with the system Node; it
  doesn't bundle Node.
- To build: Swift 6 with the Command Line Tools (`xcode-select --install`) or Xcode. Building the
  daemon or a bundled daemon also needs pnpm 10 (see the root [README](../../README.md)).

## Quick start

```sh
pnpm install && pnpm --filter @ddl/daemon build   # the daemon the app will run
apps/macos/scripts/run-app.sh                      # build (debug) and open the app
apps/macos/scripts/run-app.sh --demo               # in-memory demo data, no daemon, no Node
```

`run-app.sh --env DDL_AGENT_MODE=mock` passes environment variables to the app, and from there to
the daemon it starts (here: the scripted agent, no API key).

## Layout

The app is one SwiftPM package (the shell) that composes independent local packages. Each package
builds and tests on its own. The packages marked "iOS" are Foundation-only and meant for the
future iPhone app too.

| Path | Responsibility |
| --- | --- |
| `Package.swift`, `Sources/DailyDoList` | The executable: `@main` and nothing else. |
| `Sources/DailyDoListApp` | The app shell: scenes, `AppModel`, stores, workspace, settings panes, commands, the command palette. |
| `Sources/DailyDoListApp/System` | OS integration: launch at login (`SMAppService`), the global hotkey (Carbon), shortcut parsing, conflicts with macOS shortcuts, and the computer-use permissions with their guide panel. |
| `Packages/DailyDoListModels` (iOS) | Swift mirror of the wire protocol (`packages/core/src/protocol.ts`), checked against the `@ddl/contract` fixtures. |
| `Packages/DailyDoListClient` (iOS) | `DaemonClient`: `HTTPDaemonClient` (REST + WebSocket, reconnects and resyncs) and `InMemoryDaemonClient` (the demo and test fake). |
| `Packages/DailyDoListDomain` (iOS) | Pure domain logic ported from `@ddl/core`: dates and daily notes, task parsing and tracking, line anchors, agent-line markers, three-way merges, wikilinks, paths, fuzzy matching. |
| `Packages/DailyDoListEditor` | The TextKit markdown editor: live preview, clickable checkboxes, agent badges, drawings embedded in notes (floats the text wraps around, edited in place with `DailyDoListDrawing`'s canvas), and vim mode (it hosts `DailyDoListVim`). |
| `Packages/DailyDoListVim` (iOS) | Vim mode: a port of the web editor's vim.js and its CodeMirror 6 adapter, checked against the web app's vim vectors; hosts implement `VimEditor` ([README](Packages/DailyDoListVim/README.md)). |
| `Packages/DailyDoListDrawing` (model: iOS) | The native drawing engine: Excalidraw scenes in Obsidian's `.excalidraw.md` files (`DailyDoListDrawingModel`, Foundation only, checked against `@ddl/core`'s shared fixtures), a Rough.js port, the CoreGraphics renderer, Excalidraw's tools and shortcuts, and `DrawingCanvasView`, the canvas the editor embeds ([README](Packages/DailyDoListDrawing/README.md)). |
| `Packages/DailyDoListAgent` | Agent state and UI: inbox, threads (the live chat: [The agent chat](#the-agent-chat)), the orchestrator's chat ([The orchestrator's chat](#the-orchestrators-chat)), routines ([Routines](#routines)), approval cards, artifacts, notifications, menu bar, Dock badge. |
| `Packages/DailyDoListUI` | What the shell, the agent UI and the editor share: the app's one tooltip (`TooltipCenter`, `.tooltip(…)`), keycaps (`KeyShortcut`, `Keycaps`), `.pointingHandCursor()`, `IconButton`, and the chrome and accent button styles. `DailyDoListUITestSupport` finds tooltips in tests and draws them into snapshots. |
| `Packages/DailyDoListDaemon` | `DaemonSupervisor`: finds Node and the daemon, attaches or launches, health-checks, restarts, stops. |
| `Packages/DailyDoListComputer` | `ddl-computer`, the helper the daemon spawns so agents can operate other apps through their accessibility tree ([The computer use helper](#the-computer-use-helper-ddl-computer)). Not linked into the app. |
| `IntegrationTests/` | End-to-end tests against the real daemon (a separate package). |
| `Resources/` | `Info.plist.template` and the rendered 1024 px icon (`AppIcon-1024.png`). |
| `scripts/` | `test.sh`, `build-app.sh`, `run-app.sh`, `make-icon.swift`. |

## Commands

| Task | Command |
| --- | --- |
| Build (debug) | `swift build --package-path apps/macos` |
| Run | `apps/macos/scripts/run-app.sh [--demo] [--release] [--with-daemon] [--env VAR=value]` |
| Test every package and the shell | `apps/macos/scripts/test.sh` |
| Test one package | `apps/macos/scripts/test.sh DailyDoListDaemon` (or `app`) |
| Filter tests | `apps/macos/scripts/test.sh DailyDoListModels -- --filter ContractFixture` |
| Integration tests | `pnpm --filter @ddl/daemon build && apps/macos/scripts/test.sh integration` |
| Format / lint Swift (swift-format, `.swift-format`) | `pnpm lint:fix` / `node scripts/lint.mjs --all --only swift` |
| Package the app | `apps/macos/scripts/build-app.sh [--release] [--with-daemon] [--zip] [--output DIR] [--open]` |
| Re-render the icon source | `swift apps/macos/scripts/make-icon.swift --png apps/macos/Resources/AppIcon-1024.png` |

## Calm by default

- **One grid.** The window has no title bar: the sidebar, the tabs and the agent panel each start
  with a 40 pt header row (the traffic lights sit in the sidebar's, centered by an empty compact
  toolbar), and their bottom lines meet. Every line is the same one-pixel separator; panes
  resize by dragging the line between them (double-click restores the default width). Empty
  header space drags the window like a title bar. Layout rules: `Views/Chrome/PaneLayout.swift`.
- **Daily notes** are titled by their date ("Thursday, September 24"; the year only when it isn't
  this year's), with "‹ Today ›" at the end of the title row. The date isn't editable: **Rename
  Note…** on a daily note renames it in the file explorer. Tabs and the sidebar keep showing the
  file name.
- **The status line** under the note has no bar or border and only shows what needs attention:
  the save state while the note isn't saved, the connection while it isn't connected (a small
  "Demo" marker in demo mode), and the agent's mode when it isn't `live`. The agent item says
  what the agent can do right now: "Agent on" / "Agent paused" (click to toggle), "Agent off",
  or "Agent unavailable" when the daemon reports a problem (click for the reason and a way to
  Settings → Agent). It never shows "on" next to a problem. An approval policy other than the
  default shows too ("Runs everything" in the warning color, "Asks only for high-risk" or "Asks
  before every action"); clicking it runs Agent → Approval Policy… (Settings → Agent).
- **Settings → Agent → Approvals** chooses when agents ask before acting, with the web app's four
  choices and descriptions; "Run everything" is saved only after a confirmation alert.
- **Agent badges** are loud only when they need you, and move gently (fade-ins, crossfades, the
  triaging pulse, checkmarks popping in) unless Reduce Motion is on. See the
  [editor README](Packages/DailyDoListEditor/README.md#behavior).
- **Tooltips** (the same rules and timings as the web app's): icon buttons, controls with a
  shortcut, status items whose meaning isn't obvious, and text only while it's truncated. One
  tooltip for the whole app opens after half a second of hover, then glides from control to
  control (for 300 ms after one hides); a click, a key, a scroll or switching windows hides it at
  once. It fades and scales in (3 pt away from its target: below header controls, above anything
  else), only fades with Reduce Motion, and floats in a child panel that ignores the mouse, so
  panes don't clip it. Shortcuts show as keycaps ([⇧][⌘][D]) looked up in the command catalog
  (`CommandID.shortcut`), never written into text; the palette, the quick switcher, the empty note,
  Settings and the menu bar window draw them the same way.
- **Pointer and feedback:** everything clickable that isn't a text field shows the pointing hand
  (disabled controls don't, and fade to 40%); every custom control tints under the pointer within
  about 110 ms and deepens when pressed; counts pop when they change. Text stays an I-beam, pane
  edges a resize cursor.
- **Dark by default**, in the app's blue palette (the web app's `--ddl-*` tokens: `Theme`,
  `AgentTheme`, `EditorColors`). Settings → Appearance switches to light or the system's.

## The agent in your notes

- **Lines the agent wrote** end with `%%agent:<thread>%%` (an Obsidian comment). The editor hides
  the marker, draws the line in the agent color and ends it with a sparkle that opens the thread
  (the marker shows faintly on the line you're editing and in source mode).
- **Threads anchored to a line** that isn't a task (a question written as prose) put their badge on
  that line and give it a soft accent band with a bar at its left edge.
- **Citations**: in a thread, `[1](url)` links are small chips, and hovering a link shows a card
  (the page's title, hostname and snippet from the thread's `sources`, never fetched) or, for a
  `[[wikilink]]`, the note's first lines. In the editor, links show the same preview as a tooltip.
- **Merging**: when the agent (or anyone) changes a note you have unsaved edits in, the two are
  merged line by line (`TextMerge`); the editor only receives their lines, your caret and undo
  stay, and the result is saved on top of their version. Changes to the same lines keep yours and
  save theirs as a conflict copy, as before.

## Drawings in notes

Excalidraw drawings, in the Obsidian Excalidraw plugin's files (`Excalidraw/<Name>.excalidraw.md`),
drawn and edited by the native engine (`DailyDoListDrawing`) and embedded with the plugin's syntax
([spec](../../docs/specs/drawings.md)); the web app does the same with the real Excalidraw.

- **In a note**, a line that is one `![[Plan.excalidraw|360|right-wrap]]` (also `left-wrap`,
  `left`, `right`, `center`, `WxH`, `50%`; none is full width) shows the drawing, unless the
  caret is on it (then its syntax shows, as in source mode). A float's text wraps around it. See
  the [editor README](Packages/DailyDoListEditor/README.md#drawings).
- **Select, move, resize**: click a drawing to select it; drag it to another line (the left or
  right third of the column floats it there, the middle makes it full width), drag its corner to
  resize it, press Delete to remove the embed (the file stays). Each is one undoable edit.
- **Edit in place**: double-click, or Return while selected. The drawing's box becomes the canvas,
  with its tool bar next to it (Excalidraw's tools and shortcuts), and grows while you draw.
  Escape or a click outside ends editing. Vim and the note's shortcuts don't see its keys.
- **Insert Drawing** (⇧⌘X; the palette, the Edit menu, the editor's context menu, vim's
  `:obcommand editor:insert-drawing`) creates `Excalidraw/Drawing <date time>.excalidraw.md`
  through the daemon, embeds it at the caret's line floating right, 360 wide, and starts editing.
- **Saving** (`Stores/DrawingStore.swift`): edits save debounced through the daemon with the
  version they were read at. When the file changed elsewhere (a 409, or a change announced while
  edits are unsaved), the two scenes are merged element by element (newer versions win, both
  sides' new elements stay) and the merge is saved on top of theirs. Changes from the web app,
  Obsidian or sync update the drawing on screen, in place too. A file that can't be read is
  never written over.
- **Opening a `.excalidraw.md`** shows the drawing full size in the pane, edited in the canvas;
  the button at its top right shows the Markdown source (and back).

## The agent chat

A thread's Chat tab shows what the agent is doing as it does it. Everything comes from what the
daemon already sends (messages, tool calls and their status, approvals, the thread's status): no
extra protocol. The web app's chat follows the same rules and wording.

- **Typing:** agent text that arrives while the chat is open types out, whether it streams or
  arrives whole (comments, summaries). Each frame reveals `max(1, round(speed × dt))`
  characters, with `speed = clamp(backlog / 1 s, 45, 3000)` per second (`RevealPacing`), counted in
  grapheme clusters, so text never trails what arrived by much more than a second. Messages that
  were there when the chat opened, and your own, show at once. Markdown renders as it types: the
  finished parts of a message are cached chunks (`MarkdownChunks`, which parse the same apart as
  together), only the chunk being typed re-parses, and half-typed markup at the end (`**`, a
  link's URL, a list marker) never flashes (`MarkdownTail`). A soft caret follows the last
  character while text types or streams.
- **What's happening now:** while the agent is queued or running, the last row says what it's
  doing: "Waiting for your approval" (click it to scroll to the card), the running tool call in
  words ("Opening Safari…", "Searching the web for “espresso grinders”…", from `ChatActivity`),
  or "Thinking…", with the step's time once it passes 3 s. Text typing out needs no row: the caret
  says it. The header's status pulses while the agent works; a new approval card glows twice.
- **Tool calls** show a spinner, then pop to ✓, ✕ or a shield. Calls that succeeded in a row
  collapse into "Used 6 tools"; a running call and failures stay visible.
- **Scrolling:** the chat follows new text while you're at the bottom and never moves while you
  read further up; a "Jump to latest" pill counts what arrived and scrolls down.
- **The chat bar** grows from one line to eight, then scrolls. Return sends, Shift-Return adds a
  line. A sent message shows at once (a quiet "Sending…"), the input clears and keeps the focus,
  and a message that didn't go out stays with Retry and Remove. While the agent works, Stop sits
  beside Send (**Stop Task**, ⌘., also in the Agent menu). The placeholder says what a reply does:
  "Reply to the agent…", "Approve above, or reply to change course…", "Ask a follow-up…".
- **Messages** fade and rise in; under the pointer they show their time and a copy button, and
  code blocks get a copy button.
- **Cost:** a frame only re-renders the text of the message that's typing; the looping animations
  (caret, dots, pulses) run on Core Animation, and the display link runs only while text is
  behind. An idle chat does no work. With Reduce Motion, text appears as it arrives and the
  indicators hold still.

Tests: `RevealTests` (the pacing table, grapheme cuts, the reveal with a manual frame clock and
Reduce Motion), `ChatActivityTests` (labels, the live row, rows of tool calls, scrolling),
`MarkdownChunkTests` (every prefix renders the same in chunks), `ComposerTests`, `ChatViewTests`,
`MotionTests`, and the `chat-*` and `composer-states` snapshots.

## The orchestrator's chat

The inbox pins **Orchestrator** above the task threads: the orchestrator's own chat
(`OrchestratorThread.id`, loaded on every refresh whatever the inbox's note filter), with its live
status and latest message. It opens in the agent panel, or in a window of its own from
**Agent → Orchestrator Chat**, the palette's "Open the orchestrator's chat", `:obcommand
agent.orchestrator` (or the web app's `agent:orchestrator`), or the panel header's window button.
That window is a single `Window` scene: choosing the command again brings it forward.

`OrchestratorChatView` (in `DailyDoListAgent`) composes the thread's `MessageRow`s and `Composer`:
each turn's status line, *Thought for N s*, the decisions as tool calls with a link to their task's
thread under each (it opens in the main window's agent panel), the user's messages and the
streamed replies. **Stop** in its header ends a turn in progress. The in-memory daemon of demo mode
simulates it: a turn per delegated task and finished report, and a streamed reply when you write.

## Routines

A routine is a job the agent does on a schedule ("every weekday at 7:30, brief me for the day"):
one note per routine in the vault's `Routines/` folder, run by the daemon's scheduler. Each run is
a thread, so a routine has its own inbox of runs, and a finished run can notify you.

- **Where:** the agent panel's header switches between **Inbox** and **Routines** (**Agent → Show
  Routines**, ⇧⌘R, the palette's "Show routines", or `:obcommand routines:show`). The list shows
  each routine's name (its file name), schedule in words, next run (or its last result while
  paused), the last run's status, whether it's paused, and what's wrong with it (a schedule the
  daemon can't read, a broken file). Its context menu has Run Now, Pause/Resume and Edit File.
- **A routine's inbox:** selecting one shows its runs, newest first, titled by when they ran;
  a run opens in the thread view with the chat's polish (typing, the activity row, replies), and
  **‹ Morning briefing** goes back to its runs. A run's thread has no Show in Note or Repeat This.
  Runs stay out of the task inbox, except one waiting on an approval or an answer, which shows
  under "Needs you" like any other (its approval also notifies and sits in the menu bar window).
- **Actions:** **Run Now** opens the new run; when the daemon refuses (409: a run is going, the
  routine has a problem, today's extra runs are used up; 503: the agent can't run on this Mac),
  its reason shows on the routine as a callout until dismissed. **Pause/Resume** flips at once
  (and rolls back if the daemon says no). **Edit File** opens `Routines/<name>.md` in the editor.
- **New Routine…** (⌥⌘N, the Agent menu, the palette, the list's button): a sheet with the
  starter templates from the daemon, then the name, the schedule in your words, what to do, and
  when to notify (every run, when something changed, never). The schedule is checked by the
  daemon only: its message shows under the field that's wrong (a taken name under Name).
  Creating it shows the new routine.
- **Repeat This:** a finished task's thread offers it in its header; the sheet opens with the
  task as the name and the instructions, and you pick the schedule.
- **Notifications:** the daemon sends `routine.notification` when a run ends and the routine's
  `notify` says so; the app posts it through the same notification center as approvals (grouped
  per routine, "Run failed" or "Needs you" as the subtitle). Clicking it opens that run.
- **Code:** `AgentStore+Routines` (list, runs, actions, `RoutineDraft`), `RoutineAlert` (409/503
  reasons, form errors), `Views/Routines/`, and in the app `UIState.agentSection`,
  `showRoutines()`/`showRoutine(_:)`/`showRoutineRun(routineId:threadId:)` and the sheet in
  `MainWindowView`. Demo mode has four routines (one paused, one with a schedule it can't read)
  with past runs, and runs Run Now like the daemon.

## Vim mode

Turn it on with **Vim key bindings** in Settings → Appearance, View → Vim Key Bindings, or "Toggle
Vim key bindings" in the command palette. The editor then does what the web app's vim mode does,
which is Obsidian's: `DailyDoListVim` is a port of the same engine (vim.js), and the web app's
11,491 recorded vim behaviors replay through the real Mac editor in the tests.

- **Looks:** a block cursor in normal, visual and replace mode (an outline while the window isn't
  active), the command line (`:`, `/`, `?`) and vim's messages under the editor, highlighted
  search matches, and the mode in the status bar with the keys of a command being typed (`2d`,
  `"a`) and `recording @q`.
- **App commands:** `:w`, `:wa`, `:q`, `:q!`, `:qa`, `:wq`, `:x`, `:wqa`, `:xa`, `:e <note>`
  (a bare `:e` opens the quick switcher), `:tabe[dit] <note>`, `:tabnew`, `:tabc[lose]`,
  `:tabn[ext] [N]`, `:tabp[revious]`/`:tabN[ext] [N]`, `:bn`, `:bp`, `:bN`, `:bd`, `gt`/`gT`
  (`3gt` goes to the third tab), and `:obcommand <id>` for any palette command. It takes the
  app's ids (`daily.today`, `editor.vim`) or the web app's (`daily:today`, `panel:left`), so one
  vimrc works in both apps. A command that can't run here says so in the command line.
- **Clipboard:** `"+` and `"*` are the system clipboard; `:set clipboard=unnamed` (or
  `unnamedplus`) makes plain `y`, `d` and `p` use it too.
- **vimrc:** Settings → Appearance shows a vimrc editor while vim is on. It runs at launch and
  whenever it changes (one ex command per line, `"` comments, `let mapleader = …`, and
  Obsidian's `exmap name command`); rejected lines are listed under it with vim's message.
- **Keys:** ⌘ shortcuts keep working in every mode. In normal and visual mode vim gets the Ctrl
  keys it binds (and those a vimrc maps) before the menus, and no key reaches the text view or
  the press-and-hold accent popup. In insert mode, keys vim doesn't use keep their macOS
  behavior, so list continuation, Tab and the Ctrl-A/Ctrl-E line motions still work. While an
  input method is composing, keys go to it.
- **Undo:** `u`, `<C-r>`, ⌘Z and ⇧⌘Z share one history per note, grouped the way the web app
  groups it (one step per command, typing merged until the cursor moves).
- **Notes and windows:** one vim instance serves every editor, so registers, macros, search and
  command history, mappings and options are shared. Each note you open starts in normal mode with
  its own marks, and switching notes never carries a pending command or a visual selection over.

## Demo mode

`--demo` (or `DDL_DEMO=1`) runs the whole UI against `InMemoryDaemonClient`: sample notes, routines
with past runs, and a simulated agent that streams, asks for approvals and finishes tasks and runs
in real time. There's no
daemon, no Node and no network, which makes it good for trying the app, UI work and screenshots.
Connection settings apply on the next normal launch.

## Managed vs. external daemon

Settings → General → Daemon chooses how the app gets a daemon.

- **Managed** (default): `DaemonSupervisor` attaches to a daemon that already answers on the port
  (for example `pnpm dev`) and never stops it. Otherwise it launches its own. Settings default to
  what a terminal would use (`DDL_HOME`, `DDL_VAULT`, `DDL_PORT`, `DDL_AGENT_MODE` from the
  environment, the port from `$DDL_HOME/config.json`), with overrides from Settings.
- **External**: connect to a daemon at a URL, with the token from `$DDL_HOME/daemon-token`.

How a managed daemon is found and run:

1. **Node:** `DaemonLaunchConfiguration.nodePath` if set, `DDL_NODE`, every `node` on your login shell's PATH
   (`/bin/zsh -lc`), the inherited PATH, `/opt/homebrew/bin`, `/usr/local/bin`, mise and Volta
   shims, then nvm, fnm and asdf. The first one reporting `node --version` ≥ 24.4.0 wins; an older
   Node earlier on the PATH doesn't hide a newer one. The answer (with the login shell's PATH) is
   remembered in `$DDL_HOME/node-location.json` while that binary is unchanged, so later launches
   skip the ~300 ms lookup; it's re-checked in the background after each launch and forgotten if
   a launch from it fails.
2. **Daemon:** `daemonEntry` if set, `DDL_DAEMON_ENTRY`, the copy bundled in the app
   (`Contents/Resources/daemon/dist/main.js`), then a repository checkout (`DDL_REPO_ROOT`, or
   walking up from the app and from the current directory).
3. **Launch:** `node <entry>` in the daemon's package directory, with your environment plus the
   daemon settings. Its PATH starts with Node's folder and includes your login shell's PATH, so
   connectors started with `npx` or `uvx` work when the app was opened from Finder. The supervisor
   waits up to 20 s for the token file and a healthy `GET /api/health`.
4. **Supervision:** an unexpected exit restarts the daemon after 1, 2, 4, 8… s (capped at 30 s).
   After 5 failures within 2 minutes it gives up and shows the daemon's last output. An attached
   daemon is health-checked every 5 s; if it goes away, the app starts its own.
5. **Stop:** SIGTERM to the daemon's process group, then SIGKILL after 5 s. Quitting the app stops
   the managed daemon. If the app crashes, the daemon notices its stdin closing and shuts itself
   down (a small `--import` preload), so no orphan lingers.

Settings → General → Status shows the daemon's version, API version and vault, and its log. The
supervisor keeps the last 1,000 lines; you can copy or clear them there. **Restart Daemon**
restarts a managed daemon in place, and connected clients reconnect and resync.

## Packaging

`scripts/build-app.sh` assembles `Daily Do List.app` in `apps/macos/build/` (gitignored):

- `swift build` of the `DailyDoList` product (`--release` for an optimized build).
- `Contents/Info.plist` from `Resources/Info.plist.template`: bundle id `app.dailydolist.mac`,
  version from `apps/macos/VERSION` if present, else the root `package.json`, and build number from
  the git commit count (else a timestamp). It also sets macOS 14 minimum, local-networking ATS, and
  no sudden termination.
- `Contents/Resources/AppIcon.icns`: `make-icon.swift` renders the icon (a blue squircle with a
  white checkbox) at every size with CoreGraphics, then `iconutil` packs it. The result is cached
  in `build/.work` until the script changes.
- `--with-daemon`: `pnpm --filter @ddl/daemon build`, then
  `pnpm --filter @ddl/daemon deploy --prod --legacy --ignore-scripts` into a scratch folder. pnpm 10
  refuses a plain deploy without `inject-workspace-packages`, and `--legacy` keeps the lockfile
  as is. `dist/`, `package.json` and the production `node_modules` (about 200 MB) are copied into
  `Contents/Resources/daemon/`. Workspace packages (already inlined into `dist/`), bin
  shims, pnpm metadata and dangling links are removed. The bundled daemon still needs the
  system's Node 24.4+. `ddl-computer` is built with the same configuration and copied to
  `Contents/Resources/daemon/bin/`, where the daemon looks for it, and signed with the app's
  identity before the app is.
- Signature: the local identity "Daily Do List Local Signing" when
  `scripts/signing-identity.sh --create` has made it (or `--sign ID`, or `DDL_SIGN_IDENTITY`), else
  ad hoc (`--adhoc` forces it). Verified with `codesign --verify --deep --strict`. `--zip` writes
  `Daily Do List.zip` with `ditto`.

SwiftPM resource bundles are copied into `Contents/Resources`. The generated `Bundle.module`
accessor looks next to the `.app` instead, where codesign forbids files, so packages should load
resources through `Bundle.main.resourceURL`.

### Keeping permissions across builds

macOS ties the permissions you grant an app (Accessibility, Screen Recording) to its signature. An
ad-hoc signature changes with every build, so each build looks like a new app and the old grants
stop applying: the toggle in System Settings stays on but does nothing until you remove and re-add
the app. Run `apps/macos/scripts/signing-identity.sh --create` once to fix that. It makes a
self-signed certificate in your login keychain, trusted for code signing only (macOS asks for your
password once), and `build-app.sh` signs with it from then on. Anything signed with it gets the
permissions granted to Daily Do List, so the key stays in your login keychain, where only
`codesign` may use it. Delete the certificate in Keychain Access to revoke it. CI has no identity
and signs ad hoc.

Neither signature is notarized. A downloaded copy (for example the CI artifact) is quarantined:
right-click → Open, or `xattr -dr com.apple.quarantine "Daily Do List.app"`.

## Permissions

| Feature | What macOS needs |
| --- | --- |
| Notifications (approval requests, finished tasks, routine runs) | The standard notification prompt on first use; manage it in System Settings → Notifications. |
| Launch at login | Only works from a signed `.app` (`build-app.sh`; a `swift run` build explains why it's unavailable). When macOS says it needs approval, the toggle offers **Open Login Items Settings…**. |
| Global shortcut (off by default; default ⌃⌥⌘D: open today's note) | No permission (Carbon hotkeys). ⌃⌥⌘D is free on a stock Mac; ⌥⌘D would clash with macOS's own "Turn Dock hiding on/off". The app detects clashes with common system shortcuts and says which setting to turn off, or pick another shortcut in Settings → General. |
| Computer use and browser automation by agents | The daemon is the app's child process, so Accessibility and Screen Recording prompts name **Daily Do List**, and Settings → Computer Use walks you through both ([Computer use access](#computer-use-access)). Grants survive rebuilds only when builds are signed with the local identity ([Keeping permissions across builds](#keeping-permissions-across-builds)); after an ad-hoc build, grant them again. |

## Computer use access

Agents that work in other apps need two macOS permissions: **Accessibility** (read other apps'
controls, click and type in them) and **Screen Recording** (see their windows). macOS checks them
on the app that started the daemon, so Daily Do List asks for them for itself.

- **Where:** Settings → Computer Use says what agents can do there and the guardrails, with a row
  per permission. **Set Up Computer Use…** (Agent menu, command palette) opens it, and so does the
  main window's banner, "Let the agent use your apps", shown while access is missing, the agent
  is on and the app runs its own daemon. Dismissing the banner is remembered.
- **Allow…** shows macOS's own prompt first (it adds Daily Do List to the list, switched off),
  then opens System Settings on that exact list: `x-apple.systempreferences:` links to
  `Privacy_Accessibility` or `Privacy_ScreenCapture` under the pane's older and newer names, then
  Privacy & Security itself. The first link that opens wins.
- **The guide:** a small floating panel at the right edge of the screen that never takes the focus
  from System Settings. It says "Turn on **Daily Do List** under Accessibility", offers the app's
  icon to drag into the list when it isn't there, and checks the permission off the moment the
  switch flips. After Accessibility it offers **Next: Screen Recording**. When everything is on it
  says "All set", closes after 1.5 s and brings Daily Do List back.
- **Polling** (every 0.5 s) only runs while the guide or the Computer Use tab is showing, or System
  Settings is in front, and stops once both are granted. The app also re-checks whenever it
  becomes active.
- **Screen Recording applies after a relaunch.** macOS offers **Quit & Reopen** itself; the guide,
  the tab and the banner offer **Relaunch Now**. That saves your notes, stops the managed daemon,
  opens a new instance (`createsNewApplicationInstance`, with this one's arguments and `DDL_*`
  variables) and quits, so the new instance starts its own daemon and the grant reaches it. A
  launch within 10 minutes of asking reopens Settings → Computer Use, so you see the result.
- **Only the app's own daemon gets them.** When the app uses a daemon it didn't start (`pnpm dev`
  in a terminal, or an external one), macOS checks the app that started that daemon, such as your
  terminal, and the tab says so. It also warns when the app is signed ad hoc, which loses the
  grants on every rebuild ([Keeping permissions across builds](#keeping-permissions-across-builds)).
- **Code:** `Sources/DailyDoListApp/System/ComputerAccess*.swift` and `ComputerPermission.swift`.
  Every OS call (the TCC checks and prompts, `NSWorkspace`, System Settings' state, the panel,
  relaunching) is behind a protocol in `ComputerAccessSystem`, and time behind `AppScheduler`, so
  the tests drive the whole flow with fakes and never prompt.

## The computer use helper (`ddl-computer`)

`Packages/DailyDoListComputer` builds `ddl-computer`, which lets agents operate native apps that
have no connector or website (a chat app, Grok Bot, WhatsApp) one app at a time, in the background,
through their accessibility tree: it reads the tree with element ids, presses buttons, sets text
fields, types and presses keys at one process, and captures one app's window. The daemon spawns
it, so macOS checks its Accessibility and Screen Recording against the app hosting the daemon
([Computer use access](#computer-use-access)).

- **Running:** `ddl-computer serve` reads one JSON request per line on stdin and writes one
  response per line on stdout: `{"id": 1, "method": "snapshot", "params": {"pid": 42}}` gets
  `{"id": 1, "result": {…}}` or `{"id": 1, "error": {"code": "stale", "message": "…"}}`. Requests
  run one at a time, in order (clients may pipeline them and match responses by id). It exits
  once stdin closes and what it read is answered (at most 10 s later), or as soon as stdout
  closes, so it can't outlive the daemon. Its stderr log has method names, durations and error
  codes only: never params, UI content or typed text.
- **Errors:** `permission` (names the missing permission), `not_found` (app, window or element),
  `stale` (read the app again), `protected`, `unsupported` (a value that can't be set, an action
  the element lacks), `invalid` (bad or unknown params, or an ambiguous app name, with the
  candidates listed) and `failed`. A line that isn't a request gets `"id": null`.
- **Where the daemon finds it:** `<directory of dist/main.js>/../bin/ddl-computer`, which is
  `Contents/Resources/daemon/bin/ddl-computer` in an app built with `build-app.sh --with-daemon`.
  By itself: `swift build --package-path apps/macos/Packages/DailyDoListComputer -c release
  --product ddl-computer`. `ddl-computer --version` prints the protocol version.

| Method | Params | Result |
| --- | --- | --- |
| `hello` | | `{version: 1, pid}` |
| `permissions` | | `{accessibility, screenRecording}`, checked without prompting |
| `apps` | | `{apps: [{name, bundleId, pid, active, hidden}]}`: Dock apps, frontmost first; needs no permission |
| `installedApps` | | `{apps: [{name, bundleId, path}]}`: `/Applications`, `~/Applications` and `/System/Applications`, and one folder level below them (`Utilities`), deduped by bundle id, by name |
| `resolveApp` | one of `name`, `bundleId`, `pid` | `{name, bundleId, pid, launched}`. A name matches exactly (localized, bundle or file name), else by a unique prefix, else by a unique substring. An app that isn't running launches in the background (up to 10 s). |
| `activate` | `pid` | `{ok}`: like clicking the app in the Dock, and only when asked |
| `snapshot` | `pid`, `maxNodes` (400), `maxDepth` (30); `snapshotId` + `elementId` expand an element | `{snapshotId, app, window, text, elements, truncated}` |
| `screenshot` | `pid` (else the main display), `maxWidth` (1280) | `{image, mimeType, width, height, scale, origin, app, window}`: a base64 JPEG whose longer side is at most `maxWidth`; `scale` is pixels per point |
| `press` | `pid`, `snapshotId`, `elementId`, `action`: `press` (default), `show-menu`, `confirm`, `cancel`, `increment`, `decrement`, `raise`, `pick`, `scroll-to-visible` | `{ok, stale}` |
| `setValue` | `pid`, `snapshotId`, `elementId`, `value` | `{ok, value, stale}`, the value read back |
| `typeText` | `pid`, `text` (up to 10,000); `snapshotId` + `elementId` focus an element first | `{ok, stale}`. Each line break presses Return once, a tab presses Tab. |
| `key` | `pid`, `combo`: `return`, `cmd+k`, `shift+tab` (the key names of `computer-keys.ts`) | `{ok, stale}` |
| `click` | `pid`, `x`, `y`, `button` (`left`), `count` (1) | `{ok, stale}`; the point must be in one of the app's windows |
| `scroll` | `pid`, `x`, `y`, `dx`, `dy` (lines; positive `dy` scrolls down) | `{ok}` |

Points are global screen points (origin at the top-left of the main display). Params are checked
strictly: unknown keys, wrong types, out-of-range numbers and text over the caps are `invalid`.

- **Snapshots** read the app's focused window (else its main window, else its first; the app
  itself when it has none) breadth-first, so the node budget covers the whole window before one
  deep branch, and print it in document order, one element per line, two spaces per level:
  `[e12] AXButton name="Send" actions=press,show-menu`. The name is the first non-empty of
  `AXTitle`, `AXDescription`, `AXLabel`/`AXLabelValue`, `AXPlaceholderValue` and `AXHelp` (up to
  120 characters), values are cut at 200, and a secure text field's value is never read
  (`value=•••`). A line cut for size ends with `(+N descendants omitted)`, N being the children
  left out; expanding that element adds its subtree to the same snapshot, under new ids.
- **Staleness:** the helper keeps the latest snapshot of each app. A new snapshot, or an action
  that can change the UI (all but `scroll` and `activate`), retires it: its ids then answer
  `stale`, and the action returns `stale: true`. Before acting, the element is read again, and one
  that's gone or whose role or name changed is `stale` too, so an action always hits the control
  whose label the caller saw.
- **Protected targets** are refused with `protected` before anything else, from the real process
  and never from a name the model supplies (`ProtectedTargets.swift` is the one list): Daily Do
  List, System Settings and its extensions, security prompts (`SecurityAgent`, `loginwindow`,
  Touch ID sheets), Keychain Access, Passwords, password managers (1Password, Bitwarden, Dashlane,
  LastPass, KeePassXC) and authenticators (Okta Verify, Yubico Authenticator), by bundle id and by
  their real names; the apps the helper runs under (its parent processes: the app or terminal
  hosting the daemon), and anything a protected app started; and any window showing Daily Do
  List's web UI, a web area whose `AXURL` is on `127.0.0.1`, `localhost`, `::1` or `0.0.0.0` at
  port 5173, 7331 or `$DDL_PORT`, or a window titled with "Daily Do List". Reads check the window
  they read.
  Input checks every window of the app, since keys and clicks can land in any of them, and a
  window that can't be checked in time is refused.
- **Limits:** `press` and `setValue` work with the app in the background. Keys, clicks and
  scrolls only reach the app in front (macOS routes them to the key window, and an inactive app
  has none), so `typeText`, `key`, `click` and `scroll` bring the app to the front first and send
  nothing if it doesn't come. Their events still go to that one process (`CGEventPostToPid`), so
  they never land in another app and the cursor doesn't move, but some apps ignore events that
  don't come from the keyboard and mouse, or hit-test with the real cursor. Typed
  text travels in key events with keycode 0, which apps that read keycodes see as "a". Electron
  apps only show their content to accessibility clients that ask (`AXManualAccessibility`, set on
  the first read, which then waits 0.5 s), and setting a web text field's value may not reach the
  page's state (`typeText` does). Each accessibility call has 2 s before the app counts as not
  responding, and a snapshot returns what it has after 6 s (`truncated`). Window screenshots use
  ScreenCaptureKit (the window alone, even when covered) and fall back to `screencapture -l`.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Node.js 24 is required" | Install Node 24 (`brew install node`, or nodejs.org), or set `DDL_NODE` to a Node 24.4+ binary (for apps opened from Finder: `launchctl setenv DDL_NODE /path/to/node`, then relaunch). The message lists what was found. |
| "The daemon wasn't found" | Run `pnpm --filter @ddl/daemon build` in the checkout, build the app with `--with-daemon`, or set `DDL_DAEMON_ENTRY`. |
| "The daemon rejected this app" | A daemon on the port uses another token: it was started with a different `DDL_HOME`, or `daemon-token` was rotated while it ran. Restart that daemon, or match `DDL_HOME` in Settings. |
| "The daemon's port is taken" | Something that isn't the daemon listens on 127.0.0.1:7331. Quit it, or choose another port (Settings or `DDL_PORT`). `lsof -nP -iTCP:7331 -sTCP:LISTEN` shows who. |
| "This app and the daemon don't match" | The major API versions differ (`/api/health` → `apiVersion`). Update whichever side is older; rebuild the daemon after pulling. |
| The daemon keeps crashing | The failure shows its last output; Settings → General → Status → Daemon log has more. Run `node apps/daemon/dist/main.js` in a terminal to see it directly. |
| The shortcut does nothing | Check the warning under the shortcut setting (a macOS shortcut may take precedence), then System Settings → Keyboard → Keyboard Shortcuts. |
| Launch feels slow | Run the binary with `DDL_BOOT_TRACE=1` (`DDL_BOOT_TRACE=1 "Daily Do List.app/Contents/MacOS/DailyDoList"`): each boot phase prints to stderr with the milliseconds since the process started. A warm launch reaches `app: ready` in ~500 ms (see `docs/PERFORMANCE.md`). |

## Testing

- **Unit tests** live in each package (`Tests/`) and use Swift Testing. `scripts/test.sh` runs
  them. With only the Command Line Tools there's no XCTest and plain `swift test` can't find
  `Testing.framework`, so the script adds the framework and rpath flags. With Xcode selected it
  adds nothing.
- **Fakes first.** Supervisor logic runs against injected fakes (process launcher, health
  checker, files, commands, and a clock whose sleeps finish instantly), so crash loops, backoff,
  timeouts and stop escalation are tested in milliseconds. A few tests start real processes: a
  tiny fake daemon script (`Packages/DailyDoListDaemon/Tests/.../Fixtures/fake-daemon.mjs`).
- **Integration tests** (`IntegrationTests/`, `scripts/test.sh integration`): `DaemonSupervisor`
  launches the real `apps/daemon/dist/main.js` (mock agent, temporary `DDL_HOME` and vault, a free
  port) and the tests drive `HTTPDaemonClient`. They cover REST (daily notes from templates,
  optimistic concurrency and 409s, soft deletes, folders, search, settings), WebSocket events
  (hello, echo tagging, external edits), agent flows (streamed threads, artifacts, approve, deny,
  retry, cancel), and a supervisor restart mid-stream (reconnect + resync). They're skipped with
  a message when Node 24.4+ or the built daemon is missing.
- **Vim**: `DailyDoListVim` replays the web app's vim vectors against its reference buffer, and
  `DailyDoListEditor` replays all of them again through the real editor, with live preview both
  off and on. Vim-mode tests drive the editor with real `NSEvent`s (typing, undo grouping, IME,
  prompts, the block cursor's pixels, mouse selections, paste, badges, switching notes), and
  `VimAppTests` cover ex commands, the status bar, the vimrc and the clipboard in the app. See the
  [editor README](Packages/DailyDoListEditor/README.md#vim-mode).
- **CI**: `.github/workflows/macos.yml` builds the daemon, runs every package's tests and the
  integration tests, builds a release app with the bundled daemon, and uploads the zip.
- **Tooltips**: the timing runs on a manual clock with fake event monitors and a recording
  presenter (`DailyDoListUI`), the real panel's placement and animations are checked without
  sleeping, and the app's tests lay the workspace out and check every tooltip: controls that run a
  command show the catalog's keys, and no string in the sources spells a shortcut out. Snapshots
  draw the real bubble where it would show (`app-snapshots/tooltip-*`, `editor-snapshots/tooltip-*`,
  `ui-snapshots/`).
- **Routines**: `StoreRoutineTests` (the list and its events, runs kept out of the inbox, Run
  Now's 409/503 alerts, optimistic pause, form errors, drafts), `RoutineNotifierTests`,
  `RoutineViewTests` (what each screen offers, and the `routines-*` snapshots), the client's
  `InMemoryRoutineTests` and REST cases, and in the app `RoutineCommandTests`, the tooltip checks
  and the `main-window-routine*` snapshots.
- **Computer use access**: `ComputerAccessTests` run the permission flow against fakes (the
  prompt before the System Settings link, the links' fallbacks, the guide's steps, polling that
  stops, the relaunch's order, the banner's rules and its dismissal), and the snapshots draw the
  Computer Use tab, the guide and the banner (`app-snapshots/settings-computer-use-*`,
  `computer-access-guide-*`, `computer-access-banner-*`). Nothing in the tests prompts, opens
  System Settings or relaunches.
- **Drawings**: `DailyDoListDrawing` replays `@ddl/core`'s shared drawing fixtures (when they're
  in the checkout), checks its Rough.js port against samples from Rough.js itself, drives its
  editor and canvas with pointer sequences and real `NSEvent`s, renders snapshots of every element
  type in both themes (`.build/drawing-snapshots/`), and holds 2,000-element drawings to 60 fps
  budgets ([README](Packages/DailyDoListDrawing/README.md#testing)). `DailyDoListEditor` drives
  embeds with real `NSEvent`s in an offscreen window (wrapping, select, move, resize, insert,
  editing in place, vim), renders them light and dark (`editor-snapshots/drawings-*`) and times
  typing in a note with six drawings; the app's `DrawingTests` cover saving, the 409 merge,
  changes from elsewhere and Insert Drawing against the fake daemon.
- **Computer use helper**: `DailyDoListComputer`'s tests run the helper against fakes for
  accessibility (a fake tree that records every read and action), apps, windows, input, capture,
  permissions, parent processes and time: the codec and every error code, strict params, the tree
  text, snapshots and staleness, every protected target, app resolution, key combos (their tables
  are checked against `computer-keys.ts`), typing and clicks. They never read, capture or act on
  a real app.
- The web UI's e2e and perf budgets don't cover this app. Check UI changes by hand
  (`run-app.sh --demo` is quickest).
