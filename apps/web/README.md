# @ddl/web

The browser client: React 19 + Vite. It talks to the daemon over REST + WebSocket. `pnpm dev:mock`
runs it against a real daemon with the mock agent on a throwaway demo vault.

```sh
pnpm --filter @ddl/web test        # unit tests (Vitest; happy-dom where a test needs a DOM)
pnpm --filter @ddl/web e2e         # Playwright, functional (real keyboard and mouse, real daemons)
pnpm --filter @ddl/web e2e:perf    # Playwright, performance budgets (docs/PERFORMANCE.md)
```

Code map: `src/app` (startup, services, actions), `src/state` (zustand stores and pure reducers),
`src/features/*` (UI by feature), `src/commands` (the command registry and shortcuts), `src/api`
(the daemon client, page auth, pairing). The rules for controls (tooltips, keycaps from the
registry, the pointer) are in `AGENTS.md`. Unit tests sit next to the code; the Playwright specs
are in `e2e/` (one per feature, plus `polish.spec.ts`, the cursor and tooltip audit of every
screen) and `e2e/perf/`.

Several sections below are also the contract for the Mac app: the chat's pacing and activity
wording, the orchestrator's chips, and the wording of routines and the remote settings must stay
the same on both platforms, pinned by the same table tests on each side.

## End-to-end tests

Playwright's web server is `packages/agent/scripts/e2e-daemons.ts` (after `vite build`): a loopback
control API that starts real daemons in its process, each with its own temporary `DDL_HOME` and
vault seeded with the demo vault (`apps/daemon/src/demo-vault.ts`: daily notes, drawings,
yesterday's note with agent lines, an anchored question and cited sources), and removes them after.
It also runs a fake OpenRouter and a sync service. `e2e/fixtures.ts` gives every test its own
daemon (`daemon`; `test.use({ daemonSpec })` picks the vault, files, settings, `config.json`, env
variables, the agent) and more for the ones that need them (`launch`: another device, the
always-on machine; `e2e/remote.ts` pairs and hands over as users do). Tests read and edit the vault
through the files (`daemon.read`, `daemon.write`, as another app would) and call the API with its
token (`daemon.api`).

- **Agents**: `agent: "mock"` (default) is the daemon's scripted mock agent, done in a few hundred
  milliseconds; `agent: "live"` is the Pi harness against the fake OpenRouter (the fake brain,
  sandboxed: web and files only, `mock_irreversible_action` for risky steps), about ten seconds a
  task with streaming, tool calls and approvals. Nothing reaches the network.
- **Ports and logs**: the control API is on `DDL_E2E_PORT` (default 4173; daemons take free
  ports), and the daemons log only with `DDL_E2E_LOG_LEVEL` set.
- **Hooks**: `window.__ddlDebug` (open a note, hold writes and replies — `holdReplies({ ms, fail })`
  —, run a command) installs with `?debug=1` (`openApp` adds it). `DDL_TEST_HOOKS=1` only where a
  spec needs a Mac's computer access (`apps/daemon/src/test-hooks.ts`).

## The agent chat

`src/features/agent/`: `ChatTab` lists a thread's messages above the chat bar (`Composer`).

**Typing reveal.** Agent text that arrives while the thread is on screen (streamed deltas or a
whole new message) types out; messages already there when the chat opens, and your own, show at
once. The pacing is in `reveal.ts` (a steady stream trails about a second behind; long text catches
up), counted in grapheme clusters so an emoji or flag split across deltas is revealed whole.
Markdown renders progressively, block by block, at most once per frame
(`progressive-markdown.ts`): incomplete syntax stays raw, and a trailing run of `*`, `_`, `~` or
`` ` `` is held back so half a closing `**` never flashes as italics; the final text then stays as
rendered. A 2 px caret marks the reveal point. Nothing re-renders through React per character:
`AgentTextView` paints from a store subscription, and one `requestAnimationFrame` loop
(`lib/frame-loop.ts`) serves every message, stopping when nothing reveals.

**What the agent is doing.** While the thread's agent is queued or running, a row ends the chat,
first match wins (`deriveActivity`): a pending approval ("Waiting for your approval"; clicking
scrolls to the card), the latest running tool call's label, nothing while text streams or types
out, else "Thinking…", or "Waiting to start…" while queued. The step's elapsed time follows after
3 s ("· 12s"). The labels ("Opening Safari…", "Searching the web for “espresso”…") and their
clipping rules are the table in `activity.test.ts`, which the Mac replays. Finished calls fold into
"Used 6 tools" (`chat-items.ts`); running and failed ones stay visible. Tool rows spin while running
and land with a pop, the header's status chip ripples while the agent works, and an approval card
that arrives while you watch glows once.

**The chat bar.** It grows from one line to eight. Enter sends, Shift+Enter adds a line; while the
agent works, Stop sits beside Send (`agent:stop`, ⌘. / Ctrl+.). Replies are optimistic: shown at
once, faded while sending, with Retry and Discard if the send fails (`state/outbox-store.ts`). The
placeholder says "Approve above, or reply to change course…" while an approval waits and "Ask a
follow-up…" once the thread ended.

**Scrolling.** Within 48 px of the bottom the chat follows new content; scrolled up, it never
moves, and a "Jump to latest" pill counts what arrived. Rows that arrive while you watch fade in;
history doesn't. Messages and code blocks have copy buttons.

With `prefers-reduced-motion`, text appears as it arrives and nothing blinks, bounces, pulses or
slides.

## Drawings

`src/features/drawings/`: Excalidraw drawings on notes, in the Obsidian Excalidraw plugin's format
(`@ddl/core`'s, see `docs/DATA_FORMATS.md`). The Mac editor mirrors this with its own engine.

- **In a note**, `![[Name.excalidraw|360|right-wrap]]` alone on its line is a box of the editor's
  embed layer (`packages/editor`, "Embeds": float, move, resize, delete) showing a static SVG from
  Excalidraw's `exportToSvg`, cached by the file's content hash (`render-cache.ts`). The dark theme
  inverts it with a CSS filter, as Excalidraw's dark mode does.
- **Insert drawing** (`drawing:insert`; the palette, the note header and the context menu) creates
  `Excalidraw/Drawing <date>.excalidraw.md`, embeds it on the caret's line floated right at 360 px
  and starts editing it. Following a link to a missing drawing creates it too.
- **Editing in place** (`drawing-overlay.ts`): the real Excalidraw in a card over the note (at
  least 760 × 520 px when the pane allows), zoomed so the drawing sits where its preview was.
  Escape (unless Excalidraw uses it), a click outside or Done ends it once saved. Opening the file
  itself shows Excalidraw over the pane (`DrawingPane.tsx`).
- **Saving** (`drawing-session.ts`): debounced (500 ms, and on leaving, blur or ⌘S) through the
  notes API with `baseVersion`, written with `serializeDrawingFile(scene, previous)` so what
  Excalidraw doesn't know survives; opening a file never rewrites it. A 409 or a change pushed from
  elsewhere is merged element by element (`mergeDrawingElements` in `@ddl/core`). Excalidraw's
  element ids become the plugin's 8-character ones (`element-ids.ts`). An unreadable file is never
  written over.
- **Loading** (`excalidraw-loader.ts`): one lazy chunk, fonts served from our build
  (`excalidraw-assets.ts`), never a CDN (the daemon's CSP would block it). The parts the build
  replaces are listed in `docs/PERFORMANCE.md`: exports embed whole fonts, images are picked with a
  file input, Mermaid import isn't available.

The demo vault's `Sketches.md` embeds a drawing.

## What the orchestrator is doing while you write

`orchestrator.activity` events (see `docs/AGENT_SYSTEM.md`) become chips, a note header indicator
and a status bar item. The logic is `features/editor/activity-chips.ts`, with the wording,
timings (`CHIP_TIMING`) and rules in its test tables; `state/activity-store.ts` holds the chips.

**Chips** sit at the end of each line that woke the orchestrator, after the line's badge, styled
like it: a quiet pulsing dot for `noticed` (gone after 60 s without its turn), "Orchestrator is
looking…" while reading or thinking, "Working…" while acting, "Needs your approval ↗" while one
waits, then the outcome ("Added a task ↗", "Replied ↗", "Started 2 tasks ↗", "Made a routine ↗",
"Edited the note ↗") fading after 6 s, or "Nothing to do" after 2.5 s. Clicking opens the thread
the outcome acted in, else the orchestrator's chat at the turn (`turnId`).

- `noticed` replaces the note's earlier dots; a turn's phases take over the chips of its lines; its
  `idle` gives them its outcome, or removes them when it has none. An `idle` without a `turnId`
  withdraws dots, and a bare `{ phase: "idle" }` clears everything in progress.
- A chip is matched to its line by number and text (else the nearest line with that text, else a
  similar one: `findEditedLine`), then mapped through every edit and dropped once the line is
  edited beyond recognition. Task lines get no chip: their badge shows triage. Nothing runs on the
  keystroke path.
- A client joining mid-turn seeds from `AgentStatusResponse.orchestrator`.

The **note header** says "Orchestrator: reading this note…", "…thinking…" or "…working…" while a
turn is about the open note; otherwise the **status bar** says "Orchestrator: working on
2026-09-24" (or "…on your message"). Both open the chat at the turn. With reduced motion nothing
pulses or fades.

## Routines

`src/features/routines/`, in the agent panel (the ribbon's Routines button, "Show routines", or the
row under the orchestrator's chat in the inbox). The daemon pushes every routine in
`routines.changed` (`state/routines-store.ts`); `app/routine-actions.ts` loads templates, a
routine's runs (`GET /api/threads?routineId=`), and runs, pauses, resumes, creates and opens them.

- **The list**: name, schedule in words (or the file's problem), next run, last run's status.
- **A routine** is its own inbox: next run (or why it won't run), when it tells you, extra runs
  left today, what it uses, its instructions, then its runs, newest first, in the usual thread view.
  A run's thread has no Retry (running again is Run now).
- **Run now** shows the daemon's reason in place: 409 "It can't run right now", 503 "The agent
  can't run here", 404 "This routine is gone". **Pause/Resume** changes at once and reverts with a
  toast if refused. **Edit** opens the file.
- **The inbox** keeps runs under their routine unless one needs you (then it's under "Needs you").
- **New routine…** offers the starter templates, then name, schedule (previewed with `@ddl/core`'s
  parser), instructions and when to be told; the daemon's 400 or 409 shows under the field it
  rejected. **Repeat this** on a finished task's thread opens it with the task's text, focused on
  the empty schedule.
- **Notifications**: `routine.notification` toasts unless that run or routine is on screen (no
  desktop notifications on the web). The commands (`routines:show`, `routine:new`) have no shortcuts:
  the free combinations clash with the browser's.

## Where the agent runs, other devices, pairing

`src/features/remote/`, per [docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md) ("Where the agent runs",
"Settings").

- **The orchestrator toggle**, under the inbox's header: "Orchestrator … Remote" with a switch, on
  for the always-on machine (`PATCH /api/device { placement }`). The line under it follows the
  agent status's `placement`: the handover note, where it runs, "Run it on this device instead"
  when the relay is `unreachable`, "Pair it" when `not_paired`, a warning when this device's
  `readiness` says it can't run the agent. While `heldHere` is set (or `lockedByEnv`, or a change is
  on its way) the switch is disabled with the reason and a link to Settings. A daemon that doesn't
  report placement shows no toggle.
- **Read-only**: while this device can't act on the agent (`readOnlyReason`), a banner says why and
  agent actions are disabled with the reason as their tooltip (`components/DisabledReason`, since
  the tooltip layer skips disabled controls). A 503 `agent_unavailable` that gets through is
  toasted. A relay that is still `connecting` forwards requests, so it isn't read-only. When the
  relay state or the device running the agent changes, the panel refetches threads, approvals,
  records and open threads (the daemon pushes summaries, not thread details or records).
- **Settings** (`features/remote/settings`): Agent location, Always-on machine (pair, status,
  Check now, Forget, "Pair again…"), Sync (a write-only token shown as "Saved"), Devices (pair a new
  device with a code and its countdown; revoke; no QR code yet) and Remote access. Fields set by
  environment variables are read-only. Inputs use `@ddl/core`'s validators (`inputs.ts`), and
  `remote-errors.ts` words every daemon error code per action.
- **Page auth** (`api/auth.ts`, `api/select-client.ts`): a loopback page carries
  `<meta name="ddl-token">`. On a remote host the page says `ddl-auth` `cookie` (requests carry the
  HttpOnly cookie, no Authorization header, no token in the WebSocket URL) or `pairing`: the page
  first checks whether its cookie works anyway, else shows the **pairing screen**
  (`features/pairing`): the code as XXXX-XXXX and this browser's name, posted to `/api/pair`, then
  a reload. In cookie mode a 401 (the device was revoked) brings the pairing screen back. Pairing a
  browser over https is `test.fixme` in e2e (the harness has no TLS proxy).

## Settings → Vault and importing from Obsidian

`src/features/obsidian-import/` (not `vault/`: the repo ignores folders by that name).
**Settings → Vault** shows the vault the daemon serves (`GET /api/device/vault`), and once it was
imported, where from and when, **Update from Obsidian** and the previous vault kept as the backup.
"Import from Obsidian…" (`vault:import-obsidian`) opens it from the palette. The steps:

1. **The Obsidian vault's path**, pasted; the daemon's 400 shows under the field.
2. **The report** (`ImportReport.tsx`): counts, warnings, settings found, each plugin with a chip
   (Works here, Partly, Doesn't run), canvases and drawings, the carry-over plan, and a callout for
   `watchedOpenTasks` (what the agent does with them depends on "Act on existing tasks").
3. **The destination**, the report's `defaultDestination` to start with.
4. **Import** with progress (`state/obsidian-import-store.ts` follows `import.progress`, and
   `GET /api/import/obsidian` after a reconnect) and **Cancel**. A job that ends while the section
   isn't showing toasts.
5. **Switch to the new vault** (`vault-switch.ts`): open notes are flushed, `PUT /api/device/vault`,
   then an overlay nobody can close polls until the daemon answers with the new path (or, for
   `restart: "manual"`, says how to start it), and the page reloads so nothing of the old vault can
   be written into the new one; a toast then says where the old vault is.

Sync on or `DDL_VAULT` block the switch with the reason; a paired device gets 403
`forbidden_device`, and the section says only the Mac running Daily Do List can import.
