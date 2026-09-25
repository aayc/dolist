# User journeys: the living to-do list

The daily note is alive: one orchestrator watches the whole note, attaches threads to whatever
line needs one, sends subagents to do the work, and writes results back into the note in its own
color. These journeys are the product's contract. Each one names the tests that keep it working.

How it works underneath: [AGENT_SYSTEM.md](AGENT_SYSTEM.md) ("The living list" and sections 1–3).

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

Tests: agent journeys J2 (three tests), `packages/agent/src/orchestrator/prose.test.ts`,
`test/task-watcher.test.ts` ("the rest of the note"), web e2e and Mac `LivingListTests` (anchored
line band and badge).

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

1. You open a task's thread while its agent works. The agent's replies type out at a steady pace
   with a soft caret at the end, markdown forming as it goes; text that was already there when you
   opened the thread is simply there.
2. At the end of the chat a small row says what's happening now: *Searching the web for
   “espresso grinders”…*, *Opening Safari…*, *Thinking…*, with the step's time after a few
   seconds. Finished tool calls fold into *Used 4 tools*, which opens to show each one.
3. When the agent needs you, the row reads *Waiting for your approval*; clicking it brings the
   approval card into view, and the reply box suggests *Approve above, or reply to change
   course…*.
4. You reply from the chat bar: Enter sends (Shift+Enter adds a line), your message shows at once,
   and a failed send offers Retry. **Stop** beside Send stops the agent (on the web, ⌘. too).
5. Scrolled up to reread something, nothing pulls you down; a *Jump to latest* pill counts what
   arrived and glides you back. With Reduce Motion on, text appears as it arrives and nothing
   bounces or blinks.

The pace of the typing and the wording of the activity row are the same on the web and the Mac
(`apps/web/README.md`, "The agent chat").

Tests: `apps/web/e2e/chat.spec.ts`, the table tests `reveal.test.ts` and `activity.test.ts` (and
their Mac counterparts), `Composer.test.tsx`, `agent-text-view.test.ts`.
