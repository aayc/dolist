# User journeys: the living to-do list

The daily note is alive: one orchestrator watches the whole note, attaches threads to whatever
line needs one, sends subagents to do the work, and writes results back into the note in its own
color. These journeys are the product's contract. Each one names the tests that keep it working.

How it works underneath: [AGENT_SYSTEM.md](AGENT_SYSTEM.md) ("The living list", "Routines" and
sections 1–3).

## J1. A task comes alive

1. You type `- [ ] Research the best espresso grinders under $300` and keep going.
2. About 2.5 s after you stop typing on that line (0.7 s once you press Enter), a *Triaging…*
   badge appears at the end of the line, then *On it* while a subagent researches.
3. When it's done, the badge reads *Done · Summary ready*, and a sub-bullet appears under the
   task in the agent's blue, ending in a small ✦:
   `- Summary ready — best source: example.com`. The link is a citation.
4. Clicking the ✦ or the badge opens the task's thread. Hovering the link previews the page (title,
   site, snippet) from what the agent read.

The agent's sub-bullet never counts as a new request.

Tests: `packages/agent/test/journeys/living-list.test.ts` (J1), `test/scenarios/live.test.ts`,
`apps/web/e2e/living-list.spec.ts`, Mac `LivingListTests` / `AgentLineTests`.

## J2. A question written as plain text

1. You write `What's the capital of Australia?` as a plain line, not a task.
2. The orchestrator attaches a thread to that line. The line gets a soft blue band and a badge
   (*Done · Canberra*), and the answer appears on the next line in the agent's color.
3. Clicking the badge opens the thread, titled with your question.
4. If you write new lines above it, the badge follows the question. Delete the question and its
   thread leaves the note (it stays in the inbox).
5. An answer from the web cites its source. Hovering the citation shows what the agent saw of the
   page, and nothing is fetched on hover.

Only lines that read as addressed to the agent wake it: a question, `@agent …`, `TODO …`, or a line
starting with a request verb ("Find…", "Book…", "Remind me…").

While you write, the orchestrator shows what it's doing about such a line: a quiet dot at its end
as soon as it notices it, "Orchestrator is looking…", "Working…", then what it did ("Replied ↗",
"Started a task ↗") or "Nothing to do", which fades; the note's header says when it works on the
note (see `apps/web/README.md`).

Tests: agent journeys J2 (three tests), `packages/core/src/markdown/prose.test.ts`,
`test/task-watcher.test.ts` ("the rest of the note"), web e2e (`orchestrator-activity.spec.ts`
for the chips) and Mac `LivingListTests` (anchored line band and badge).

## J3. Your own words stay yours

1. Journaling ("Slept badly, lots of meetings.") never wakes the agent: no turns, no badges.
2. If an agent wants to change a line you wrote, check one of your tasks off, or delete your
   text, it has to ask first. You get an approval card like *Edit Daily/2026-09-24.md: change
   "- budget $2k" to "- budget $2,500"*.
3. Deny it and your line stays exactly as it was. Approve it and the new line goes in marked as
   the agent's.
4. The agent's own lines go in directly: new lines, and lines it wrote earlier.

Tests: agent journeys J3 (three tests); safety rules `notes.edit.*`
(`packages/agent/src/tools/notes.test.ts`); eval cases `note-*` in `evals/datasets/safety.jsonl`.

## J4. The agent's own tasks

1. The agent can add follow-ups only you can do, like `- [ ] Call the restaurant to confirm`, shown
   as its own.
2. They aren't treated as requests, so the agent never works on its own suggestions.
3. Delete the marker (in source mode, `%%agent:…%%` at the end of the line) and the task becomes
   yours. It's triaged like any task you write.

Tests: agent journeys J4, `test/task-watcher.test.ts` ("never announces the agent's own tasks").

## J5. The orchestrator sees the whole note

Every orchestrator turn gets the entire note, numbered, with what the agent knows about each line:
`3| - [ ] Research espresso grinders  ⟪tsk_… · working — "Researching…"⟫`, and `⟪yours⟫` on lines
it wrote. Headings, paragraphs and your notes under a task are all context.

Tests: agent journeys J5, the digest round-trip property test
(`packages/agent/src/testing/brain/digest.test.ts`).

## J6. Typing while the agent writes

1. The agent waits until you pause typing in that note (1.5 s) before writing.
2. If its edit arrives while you still have unsaved changes, it's merged into your editor line by
   line. Your cursor and your edits stay put, with no conflict copy.
3. A conflict copy happens only when you and the agent changed the same line.

Tests: `packages/core/src/merge.test.ts` (unit and property tests), `test/task-watcher.test.ts`
("wait for a pause"), `packages/agent/src/tools/notes.test.ts` ("replans on the new note"), web
e2e "an agent edit arriving while the user types is merged" and "a save that meets an agent edit
is merged too", Mac `TextMergeTests` / `NotesStoreTests`.

## J7. Citations everywhere

- In threads, `[1](https://…)` shows as a small numbered chip and other links as links. Hovering
  either shows the source card, and `[[Note]]` links preview the note's first lines.
- In the note, hovering a link or a `[[wikilink]]` shows the same preview.
- Previews come only from what the agent saw (`Thread.sources`) or the vault. The app never loads
  a page just because you hovered.

Tests: agent journeys J2 (web answer), `test/scenarios/live.test.ts` (sources on the thread), web
e2e "numbered citations are chips with a preview of the cited source" and "hovering a wikilink in
the editor previews the note", Mac `CitationTests`.

## J8. Badges stay short

The badge is the one-glance status next to the line ("Booked · Tue 9:30am", "3 desks compared").
Anything worth keeping goes into the note as the agent's line, with its source.

Tests: the scenario matrix in `packages/agent/test/scenarios/` and the journeys above.

## J9. Letting the agent use your apps (Mac)

1. While computer use isn't set up and the agent is on, a banner under the tabs says *Let the
   agent use your apps*. **Set Up…** (or **Set Up Computer Use…** in the Agent menu or the
   palette) opens Settings → Computer Use: what agents can do in other apps, the guardrails (they
   ask before every action there, and never touch Daily Do List, System Settings or password
   managers), and a row for Accessibility and one for Screen Recording.
2. **Allow…** shows macOS's prompt, then opens System Settings on that exact list. A small panel
   beside it says *Turn on **Daily Do List** under Accessibility*, with the app's icon to drag into
   the list if it isn't there.
3. The moment the switch is on, the panel checks it off and offers **Next: Screen Recording**.
4. Screen Recording applies after a relaunch: choose **Quit & Reopen** in macOS's dialog or
   **Relaunch Now** in the panel. Daily Do List comes back on Settings → Computer Use with both
   permissions on. Once everything is on, the panel says *All set* and gets out of the way.

Tests: Mac `ComputerAccessTests` (prompt before the link, the links' fallbacks, the check while
polling, polling that stops, Next, the relaunch's order and the setup resuming after it), the
banner's rules and its dismissal (`ComputerAccessBannerTests`), the command
(`ComputerAccessAppTests`), and the snapshots `settings-computer-use-*`,
`computer-access-guide-*` and `computer-access-banner-*`.

## J10. Watching the agent work

1. You open a task's thread while its agent works. What was already there shows at once; new
   replies type out behind a soft caret, even when they arrive in one piece, with bold, links and
   lists forming as they go.
2. At the end of the chat a row says what's happening now: *Opening Safari…*, *Searching the web
   for “espresso grinders”…*, *Thinking…*, with the step's time after a few seconds (*· 12s*).
   Finished tool calls fold into *Used 4 tools*, which opens to show each one; a failure stays
   visible.
3. When the agent needs you, the row reads *Waiting for your approval*; clicking it brings the
   approval card into view, and the reply box suggests *Approve above, or reply to change
   course…*.
4. You reply from the chat bar: Enter sends (Shift+Enter adds a line), your message shows at once
   and the input keeps the focus, and a failed send offers *Retry*. **Stop** beside Send stops the
   agent (⌘. too).
5. Scrolled up to reread something, nothing pulls you down; a *Jump to latest* pill counts what
   arrived and brings you back. With Reduce Motion on, text appears as it arrives and nothing
   bounces, blinks or pulses.

The pace of the typing and the wording of the activity row are the same on the web and the Mac
(`apps/web/README.md`, "The agent chat").

Tests: web `apps/web/e2e/chat.spec.ts`, the table tests `reveal.test.ts` and `activity.test.ts`,
`Composer.test.tsx`, `agent-text-view.test.ts`; Mac `RevealTests`, `ChatActivityTests`,
`MarkdownChunkTests`, `ChatViewTests`, `ComposerTests`, `MotionTests`, and the `chat-*` and
`composer-states` snapshots.

## J11. Asking the orchestrator what it's doing, and redirecting it

1. The inbox's first row is always **Orchestrator**, pinned above the task threads: its status
   (*Working* while it decides, *Idle* otherwise) and its latest message. The palette's *Open the
   orchestrator's chat* opens it too; on the Mac, **Agent → Orchestrator Chat** opens it in a
   window of its own (choosing it again brings that window forward).
2. The chat shows every time it woke up and why ("Daily/2026-09-24.md changed: 2 tasks", "“Research
   desks” finished"), each decision as a tool call (*Delegate to subagent* with the capabilities it
   granted, *Set task status → ignored*…) with a link to the task's thread under it, and *Thought
   for 3 s* when it reasoned.
3. You write *What are you working on?* and press Return. *You wrote to me* marks its turn, and
   its answer streams in: what's running, what waits on you, what's done.
4. You write *Drop the desk research*. It stops that task's subagent (the badge turns *Stopped*)
   and says so. *Also check prices at IKEA* goes to the subagent working on the task, and it
   tells you it passed it on.
5. **Stop** in the chat's header ends a turn in progress. The chat, and what it knows of your
   conversation, survive restarts.

Tests: `packages/agent/test/scenarios/orchestrator-chat.test.ts` (turns recorded, direct messages
answered and acted on through the gate, approvals in the chat, recent exchanges in the digest,
Stop, restarts), `src/orchestrator/chat.test.ts` (thinking, retention), the brain's direct-message
tests and the `direct-*` triage eval cases, web e2e `orchestrator.spec.ts`, Mac
`OrchestratorChatTests`, `OrchestratorWindowTests`, `InMemoryOrchestratorTests` and the snapshots
`orchestrator-chat-*`, `orchestrator-window-*`.

## J12. A morning briefing, created by saying it

1. You add `- [ ] Every morning at 7:30, brief me on my calendar and the SF weather` to today's
   note (or write it to the orchestrator in its chat).
2. The orchestrator doesn't do it once: it proposes a routine. Under the default approval policy
   an approval card asks *Create routine “Morning briefing”: every day at 7:30 (Every day at 7:30
   AM) — Brief me on my calendar and the SF weather.* With *Run everything* it's created without
   asking; *Deny* and nothing is written, and the task says *Okay — I won't set up that routine.*
3. Approved, the file `Routines/Morning briefing.md` appears in the vault (schedule, notify and
   uses in its frontmatter, the instructions below), editable in Obsidian like any note. The
   task's badge reads *Routine created*, with a comment naming the schedule.
4. The Routines section lists it: its schedule in words, its next run, and after each run its
   status. Each morning at 7:30 a run starts in a thread of its own under the routine (never in the
   task inbox), told what the previous run found; when it finishes, a notification shows the
   first lines of the briefing. You can reply in the run's thread like in any task's.
5. The Mac slept through 7:30? The briefing runs once when it wakes, marked as a catch-up. Switched
   the agent off for the weekend? Routines start again from their next slot. **Run now**,
   **Pause** and **Resume** work from the routine's page; pausing and resuming change `paused` in
   the file, and work even while the agent runs on another device.

The UI parts (the Routines section, a routine's runs, Run now, Pause, New routine from a template,
Repeat this) are covered by the web and Mac work on routines.

Tests: `packages/agent/test/scenarios/routines.test.ts` (created by saying it under each policy,
declined), `src/routines/scheduler.test.ts` (next runs, catch-up once, the budget, run threads with
the previous result), `src/routines/tools.test.ts` (the routine tools through the gate under every
policy), the `routine-*` triage and safety eval cases, the daemon's `routes/routines.test.ts` and
`leased-runtime.test.ts` (routine files editable without the agent, scheduling only under the
lease).

## J13. A watch that only notifies on change

1. You write `- [ ] Check the price of the Fellow Stagg kettle every 2 hours and tell me when it
   drops below $120`.
2. The orchestrator creates the routine *Price watch* with `notify: when changed` and only the web
   capability.
3. Every two hours a run checks the price and reports in its thread. When nothing changed, it says
   so in one line and sets `changed: false`: no notification. When the price drops, it says what's
   new and a notification tells you (*Price watch — Now $109: below your $120*).
4. A run that fails, or needs you, notifies even when nothing changed; with `notify: never`
   nothing ever does. A run stops after 15 minutes of work (waiting for your approval doesn't
   count), and **Run now** allows a few extra runs a day.

The UI parts (the notification, the watch's runs under its routine) are covered by the web and Mac
work on routines.

Tests: `packages/agent/test/scenarios/routines.test.ts` (a watch that notifies only for the run
that found something new), `src/routines/scheduler.test.ts` (`shouldNotify`, notified once per run,
the time limit), and the `routine-price-watch` and `routine-back-in-stock` triage eval cases.
