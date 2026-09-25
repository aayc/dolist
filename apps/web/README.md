# @ddl/web

The browser client: React 19 + Vite. It talks to the daemon over REST + WebSocket, or to the
in-browser mock daemon with `?mock=1` (`&mockSpeed=4` speeds its agent up), which the e2e and perf
tests use.

```sh
pnpm --filter @ddl/web test        # unit tests (Vitest; happy-dom where a test needs a DOM)
pnpm --filter @ddl/web e2e         # Playwright, functional (real keyboard and mouse, mock daemon)
pnpm --filter @ddl/web e2e:perf    # Playwright, performance budgets (docs/PERFORMANCE.md)
pnpm --filter @ddl/web e2e:fullstack  # Playwright against the real daemon and the fake model
```

Code map: `src/app` (startup, services, actions), `src/state` (zustand stores and pure reducers),
`src/features/*` (UI by feature), `src/commands` (the command registry and shortcuts), `src/api`
(clients and the mock). The rules for controls (tooltips, keycaps from the registry, the pointer)
are in `AGENTS.md`.

## The agent chat

`src/features/agent/`: `ChatTab` lists a thread's messages above the chat bar (`Composer`). What
follows is also the contract for the macOS agent panel: the pacing and the activity wording must
stay the same on both platforms, with the same table tests (`reveal.test.ts`,
`activity.test.ts`).

### Typing reveal

Agent text (`kind: "text"`, `role: "agent"`) that arrives while the thread is on screen, streamed
deltas or a whole new message, types out. Messages already there when the chat opens are history
and show at once; so does the part of a streaming message that had arrived. Your own messages
never animate.

- **Pacing** (`reveal.ts`): each animation frame, with `backlog` = grapheme clusters received but
  not shown and `dt` = seconds since the last frame (0 on a reveal's first frame), show
  `max(1, round(speed × dt))` more, never more than the backlog, at
  `speed = clamp(backlog / 1 s, 45, 3000)` per second. A steady stream trails what arrived by
  about a second; below 45/s it's one cluster per frame; long text catches up at up to 3000/s.
- **Grapheme clusters**, never code units: an emoji, a flag or a combining sequence is revealed
  whole, even when it arrives split across two deltas (the last pending cluster is re-segmented
  with the new text).
- A message that finishes streaming keeps revealing until caught up. A final text that doesn't
  extend what streamed (a repaired gap) keeps the shown part it still starts with.
- **Markdown renders progressively**, at most once per frame, block by block
  (`progressive-markdown.ts`): each frame re-lexes the revealed prefix and re-renders only the
  blocks that changed, usually the last. Incomplete syntax is left alone (`**bold` shows raw until
  its `**` is typed) except a trailing run of `*`, `_`, `~` or `` ` ``, held back until the next
  character so half of a closing `**` never flashes as italics. The final text then stays as
  rendered: no swap, no reflow.
- **Caret**: a 2 px accent bar at the reveal point while the text types out or streams. It's
  re-inserted each frame it moves, so it's solid while typing and blinks slowly while waiting.
- Nothing re-renders through React per character: `AgentTextView` paints the message's DOM from a
  store subscription, and one `requestAnimationFrame` loop (`lib/frame-loop.ts`) serves every
  message, stopping when nothing reveals.

### What the agent is doing

The live activity row ends the chat while the thread's agent is `queued` or running (`triaging`,
`working`, `waiting_approval`), first match wins (`deriveActivity`):

1. a pending approval for the thread: "Waiting for your approval" (the shield pulses; clicking
   the row scrolls to the card, which asks for attention again);
2. the latest running tool call: its activity label (below);
3. text streaming or typing out: no row (the caret says it);
4. otherwise "Thinking…" with three dots;
5. `queued`: "Waiting to start…".

The current step's elapsed time follows after 3 s ("· 12s", "· 1m 5s"), ticking once a second
while shown. Tool calls and approvals count from their `createdAt`; thinking and queued from when
the row showed them.

Activity labels (`activityLabel`):

| Tool | Label |
| --- | --- |
| `computer_open_app` | Opening {app}… (no app: "Opening an app…") |
| `computer_app_state`, `computer_screenshot` | Looking at {app}… (no app: "Looking at the screen…") |
| `computer_press` | Pressing “{element}” in {app}… (no element: "a control"; no app: no "in") |
| `computer_set_value`, `computer_type` | Typing in {app}… (no app: "Typing…") |
| `computer_key` | Pressing {combo} in {app}… (no combo: "a key"; no app: no "in") |
| `computer_click` | Clicking in {app}… (no app: "Clicking on the screen…") |
| `computer_scroll` | Scrolling in {app}… (no app: "Scrolling on the screen…") |
| `browser_navigate` | Opening {host}… (no host: "Opening a page…") |
| `browser_snapshot`, `browser_extract_text` | Reading the page… |
| other `browser_*` | Working in the browser… |
| `web_search` | Searching the web for “{query}”… (no query: "Searching the web…") |
| `web_fetch` | Reading {host}… (no host: "Reading a page…") |
| `read_note`, `search_notes` | Reading your notes… |
| `edit_note` | Editing your note… |
| `bash` | Running a command… |
| `read`, `grep`, `find`, `ls` | Looking through files… |
| `write`, `edit` | Writing files… |
| `mcp__{server}__{tool}` | Using {server}… |
| anything else | the call's `label`, else its name humanized (`post_update` → "Post update"), plus "…" |

Values come from the call's `input` (already redacted by the daemon; typed text is never shown).
Each is whitespace-collapsed, trimmed and clipped to 40 grapheme clusters (longer: the first 39 and
"…"); non-strings count as missing. A host is the URL's hostname without `www.` (`https://`
assumed when there's no scheme). A label ends with exactly one "…", even when a clipped value
already does.

Tool call rows spin while running and land on ✓, ✕ or a shield with a quick pop (only when seen
running). Consecutive calls that finished fine fold into one row, "Used 6 tools", that opens to
show them; running and failed calls stay visible, and so does a call that just finished while it's
the thread's last message, until the next step folds it in (`chat-items.ts`). The header's status
chip ripples while the agent works, and an approval card that arrives while you watch glows once.

### The chat bar

- The input grows with its text from one line to eight (the height animates), then scrolls.
- Enter sends; Shift+Enter adds a line (keycaps from the key table show while you type, and in
  the Send tooltip). Send is disabled while the input is empty.
- While the agent works, Stop sits beside Send: the `agent:stop` command (⌘. / Ctrl+.), which the
  thread header's Stop runs too. It applies while the panel shows a thread whose agent works.
- Replies are optimistic: the message shows at once, faded while sending; the input clears and
  keeps focus. A failed send stays in the chat with Retry and Discard. A pending reply is
  confirmed once the thread has more user messages with its text than when it was sent.
- Placeholder: "Reply to the agent…"; while an approval waits, "Approve above, or reply to change
  course…"; once the thread is done, failed or stopped, "Ask a follow-up…".

### Messages and scrolling

- Rows that arrive while you watch fade and slide in (180 ms); history doesn't.
- Hovering a message shows a copy button (the agent's markdown, or your text) and, for your
  messages, the time. Code blocks in agent messages get a copy button.
- At the bottom (within 48 px) the chat follows new content. Scrolled up, it never moves you: a
  "Jump to latest" pill counts the agent messages, approvals and artifacts that arrived since, and
  glides you down.

### Reduced motion

With `prefers-reduced-motion`, text appears as it arrives (no typing), and every indicator holds
still: no blinking caret, bouncing dots, pulses, ripples, pops or entrance slides; jumps are
instant.

### Tests

Unit: `reveal.test.ts` (pacing table, grapheme cuts), `activity.test.ts` (label table, priority),
`chat-items.test.ts` (grouping), `agent-text-view.test.ts` (typing, caret, idle frames, block
re-renders, reduced motion), `Composer.test.tsx`, `agent-commands.test.ts`,
`state/outbox-store.test.ts`. E2E: `e2e/chat.spec.ts` (reveal, history, activity and approval,
tool groups, chat bar, Stop and its shortcut, optimistic send and retry, jump to latest, copy,
reduced motion, an idle chat asking for no frames). In mock mode, `__ddlDebug.holdReplies({ ms,
fail })` delays or fails chat replies.

## What the orchestrator is doing while you write

`orchestrator.activity` events (see `docs/AGENT_SYSTEM.md`) become three things in the note view.
This section is the contract for the macOS editor too: the wording, the timings and the rules below
must stay the same on both platforms. The pure logic is `src/features/editor/activity-chips.ts`,
with its tables in `activity-chips.test.ts`; `state/activity-store.ts` holds the chips and
`features/editor/activity-sync.ts` hands them to the editor (`setActivityChips`).

### Chips on lines

A chip at the end of each line that woke the orchestrator, after the line's badge when it has one,
styled like the task triage badge (`cm-ddl-badge` tones, `data-kind` for styling and tests):

| Activity | Label | Tone | Fades |
| --- | --- | --- | --- |
| `noticed` | (a quiet dot) | quiet, pulsing | after 60 s without its turn |
| `reading`, `thinking` | Orchestrator is looking… | working, pulsing | — |
| `acting` | Working… | working, pulsing | — |
| `acting` with outcome `asked_approval` | Needs your approval ↗ | needs you | — |
| `idle`, `tasks_added` | Added a task ↗ / Added 3 tasks ↗ | quiet | after 6 s |
| `idle`, `replied` | Replied ↗ | quiet | after 6 s |
| `idle`, `delegated` | Started a task ↗ / Started 2 tasks ↗ | quiet | after 6 s |
| `idle`, `routine_created` | Made a routine ↗ | quiet | after 6 s |
| `idle`, `note_edited` | Edited the note ↗ | quiet | after 6 s |
| `idle`, `asked_approval` | Needs your approval ↗ | needs you | after 6 s |
| `idle`, `no_action` | Nothing to do | quiet | after 2.5 s |

Fading takes 600 ms. The tooltip (and accessible name) is the outcome's line when it has one
("Started a task: Find a plumber available on Saturday"), else a sentence ("The orchestrator
noticed this line", "The orchestrator is looking at this line", "The orchestrator is working on
this line", "Nothing for the orchestrator to do here"…). Clicking (or Enter/Space) opens the
outcome's thread when it acted in one (not the orchestrator's own), else the orchestrator's chat
scrolled to the turn (`turnId`, whose opening line flashes); a noticed dot opens the chat.

Rules, applied per event, keyed by the trigger's `notePath` and `lines`:

- `noticed` replaces the note's earlier dots with its lines (a dot whose line is still being typed
  keeps its chip).
- A turn's `reading`/`thinking`/`acting` puts its phase on the chips of its lines, taking over a
  dot or an earlier outcome on the same line; its `idle` gives them its outcome, or removes them
  when it has none (the turn failed or was stopped).
- An `idle` without a `turnId` withdraws the note's dots (all of them when `lines` is empty); a
  bare `{ phase: "idle" }` clears everything in progress (outcomes finish fading).
- A chip is matched to a line by line number and text: the reported line while it still reads as
  that text, else the nearest line with that exact text, else the nearest similar one
  (`findEditedLine`: a prefix while typing, or Dice similarity ≥ 0.5, the task tracker's rule).
  Task lines get no chip: their badge already shows triage.
- In the editor, chips are anchored at their line's start and mapped through every edit (typing,
  Enter, lines added above, undo); a chip is dropped once its line is edited beyond recognition
  (`isSameLineEdited` against the line as it was when the chip was set) or deleted. Nothing runs
  on the keystroke path: chips are recomputed on the next frame after an event or a fade, never
  after an edit.
- A client joining mid-turn seeds from `AgentStatusResponse.orchestrator` (at startup and after a
  reconnect), unless an event arrived meanwhile.

### The note header and the status bar

While a turn's trigger is about the open note, the note header shows "Orchestrator: reading this
note…", "Orchestrator: thinking…" or "Orchestrator: working…" ("Orchestrator: needs your approval"
while it waits for one), floating at the header's bottom right so it never moves the text. While it
works on anything else, the status bar says "Orchestrator: working on 2026-09-24" (the note's name)
or "Orchestrator: working on your message" (the trigger's summary). Both open the orchestrator's
chat at the turn.

With `prefers-reduced-motion` nothing pulses or fades: chips and indicators change in place.

### Tests

Unit: `features/editor/activity-chips.test.ts` (rules, wording table, fading, anchoring,
indicators), `packages/editor/src/activity/field.test.ts` (mapping through edits, dropping).
E2E: `e2e/orchestrator-activity.spec.ts` (real keyboard: a request line's dot before it settles,
then its outcome and thread; plain prose; "Nothing to do" fading; editing beyond recognition; the
status bar; reduced motion) and the chips in `e2e/polish.spec.ts`'s cursor audit. The mock daemon
simulates the daemon's activity for prose lines (`api/mock/mock-agent.ts`).

## Routines

`src/features/routines/`, in the agent panel: the ribbon's Routines button, the "Show routines"
command, or the row pinned under the orchestrator's chat in the inbox (it previews the routine that
runs next). A routine is a vault file, `Routines/<name>.md`; the daemon pushes every routine in
`routines.changed` whenever one changes, and `state/routines-store.ts` replaces its list with it.
`app/routine-actions.ts` loads the list and the starter templates the first time something shows
them, fetches a routine's runs (`GET /api/threads?routineId=`), and runs, pauses, resumes, creates
and opens routines. The wording below is meant to match the Mac app's.

- **The list**, by name: the name (the file name), the schedule in words (as written when the
  daemon can't read it), "Next run {when}", the last run's status and time (or "No runs yet"),
  "Paused", and the file's problem in place of the schedule.
- **A routine** is its own inbox: "Next run" (or why it won't run: "It can't run until its file is
  fixed.", "Paused: it won't run until you resume it."), "Tells you" (After every run, When
  something changed, Never), how many extra runs are left today, what it uses, its instructions,
  then its runs, newest first, each named by when it started ("Today at 7:31 AM") and opening in
  the usual thread view with its typing reveal and activity row.
- **Run now** shows the daemon's reason in place when it can't start: 409 "It can't run right now"
  (a run is going, the file has a problem, or today's extra runs are used up), 503 "The agent
  can't run here" (the agent is paused or can't run on this device), 404 "This routine is gone".
  The reason goes away once a run starts or ends.
- **Pause/Resume** changes at once and puts it back with a toast if the daemon refuses. **Edit**
  opens the file in the editor.
- **A run's thread** goes back to its routine and has no Retry: running again is Run now, which
  counts against the day's extra runs. Its note button opens the routine's file.
- **The inbox** leaves a routine's runs under their routine, except while one needs you (an
  approval or a question): then it's listed under "Needs you" as a "Routine run". An approval from a
  run toasts like any other.
- **New routine…** offers the daemon's starter templates, then a name ("Saved as
  Routines/<name>.md"), a schedule in words (previewed as you type with `@ddl/core`'s parser),
  instructions, and when to be told. The daemon has the last word: its 400 message shows under the
  schedule (or the name or instructions, when those are what it rejected), and a 409 (the name is
  taken) under the name. Enter in a field, or Mod+Enter in the instructions, creates it.
- **Repeat this**, on a finished task's thread, opens the dialog with the task's text as the name
  and the instructions, without templates, focused on the empty schedule: the user gives it.
- **Notifications**: `routine.notification` (sent per the routine's `notify`) toasts the
  routine's name and the run's result, unless that run or its routine is on screen; clicking it
  opens the run. The web app has no desktop notifications.
- **Commands**: "Show routines" (`routines:show`) and "New routine…" (`routine:new`), in the
  palette and on their controls, without shortcuts: the free combinations clash with the
  browser's.

The screens are in the agent panel's chunk and the dialog (with the schedule parser) in its own,
both prefetched when idle; startup only carries the store, the actions and the toast (~1.6 kB gz).
With `?mock=1`, `api/mock/mock-routines.ts` keeps routines like the daemon (files in the mock
vault, Run now with a short scripted run, the extra-runs budget, notify rules, the daemon's error
bodies), but schedules don't fire.

### Tests

Unit: `state/routines-store.test.ts`, `app/routine-actions.test.ts` (against the mock daemon),
`app/routine-toasts.test.ts` (notifications and event routing), `routine-errors.test.ts` and
`create-problem.test.ts` (error mapping), `routine-format.test.ts`, `repeat.test.ts`,
`RoutinesView.test.tsx`, `RoutineView.test.tsx` (runs, Run now's reasons, Pause, Edit, a run's
header, Repeat this), `NewRoutineDialog.test.tsx`, `commands/routine-commands.test.ts`, and the
mock's contract test. E2E: `e2e/fullstack/routines.spec.ts` against the real daemon (New routine
from a template, a routine's runs, Run now, Pause, the notification, Repeat this), and the cursor
audit of every routines screen in `e2e/polish.spec.ts`.
