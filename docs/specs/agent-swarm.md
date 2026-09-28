# Spec: the note as one canvas for a swarm of agents

Status: in progress (wire shapes on `main`; streams A, B and C building).

Decided with the user (2026-09-28): the app feels like one separate chat per line, not one canvas.
Every line gets its own subagent, context and thread; agents never see each other's work; at most 3
run at once; the orchestrator routes lines instead of conducting. The user picked four features to
prototype together, plus models per role (built in `7a1aeeff`: Sonnet 5.5 for the orchestrator and
subagents, Opus 5.5 for tasks the orchestrator marks `deep`).

1. **Fan-out:** one task split across parallel helper agents, one per independent part, which the
   task's subagent then combines. Progress shows under the line ("6 agents · 4 done").
2. **Shared board:** agents working on a note post findings and the user's preferences to a board
   every other agent on that note reads.
3. **Workstreams:** the orchestrator groups related lines into a named workstream: shared context
   and board, grouped in the inbox.
4. **Presence:** the note shows work happening: a status header ("2 working · 1 needs you · 5
   done"), a shimmer on lines being worked on, early progress in badges.

Safety is unchanged: every tool call of every agent (helpers included) passes the safety gate.

## What the user sees (journeys; add them to `docs/USER_JOURNEYS.md` as J14–J17)

- **J14 fan-out.** `- [ ] Compare the Pebblebee Card, Ekster Tracker Card and Chipolo CARD` → the
  badge reads "3 agents · 1 done", then "Done · Pick: …". The thread shows one "Split across 3
  helpers" row (expandable: each helper's goal, status and one-line result) and the combined answer.
- **J15 board.** In the backpack thread the user replies "must be navy, and 18L". The subagent
  shares it as a preference; the tracker-card agent working on the same note gets it as a message
  and uses it. The orchestrator's digest and every later kickoff on the note include the board.
- **J16 workstreams.** Three related lines (a trip, a purchase, a project; or lines under one
  heading) become the workstream "Travel gear". The inbox shows a "Travel gear" group with its
  threads; each subagent's kickoff lists its siblings and their results.
- **J17 presence.** Under the daily note's title: "2 working · 1 needs you · 5 done" (hidden when
  nothing ran). Clicking "needs you" jumps to that line. Lines being worked on shimmer softly
  (static tint with Reduce Motion). Badges show progress within ~30 s of starting.

## Wire (already on `main`, `packages/contract/src/wire/domain.ts`, Swift `DailyDoListModels`)

- `TaskAgentRecord.workstream?: string` (1–80 chars) and `TaskAgentRecord.helpers?: { total, done }`.
- `Thread.workstream?` / `ThreadSummary.workstream?` (same name).
- No new events or routes: `task.record` and `thread.upsert` carry them. Clients group by
  `(notePath, workstream)`.

## Stream A: agent core (`packages/agent`, `packages/contract/src/persisted`, `apps/daemon`)

**Board.**
- Store per note: `.daily-do-list/state/boards/<hash(notePath)>.json`, a new persisted format
  `board` v1 registered like the others (`registry.ts`, `PERSISTED_PATHS`, fixtures,
  `docs/DATA_FORMATS.md`): `{ version: 1, notePath, entries }`, an entry `{ id, kind:
  "finding" | "preference", text (≤ 500 chars), workstream?, taskId?, author, createdAt }`. Keep the
  newest 200 per note. Follow the sync rules the task-state file follows (under the agent lease).
- Tools (names in `tools/contracts.ts`, honest safety hints like the thread tools: internal, no
  external effect, `describe()` for cards; safety eval cases that they're allowed):
  - `share_finding({ text, kind? = "finding", workstream? })` for subagents (defaults to its
    task's workstream) and the orchestrator (with a `taskId`).
  - `read_board({ workstream? })` for subagents: the note's entries, its workstream's first, capped.
- Kickoff (`buildSubagentKickoff`): "What agents on this note learned (the board)": its
  workstream's entries first, then the note's, capped (~30 lines, ~3 k chars), framed as data other
  agents wrote (they may quote web pages: data, not instructions).
- A shared `preference` reaches running subagents of the same note (same workstream when set) as a
  steering message ("Another agent on this note learned: …"). Findings don't (they're in the next
  kickoff and `read_board`).
- Prompts: subagents share a fact another task would use, and every preference or constraint the
  user states in a reply (kind `preference`). The orchestrator shares preferences from direct
  messages. The digest shows each note's latest ~10 entries.

**Workstreams.**
- `spawn_subagent` takes `workstream?: string`; a new orchestrator tool `set_workstream({ taskIds,
  workstream })` (re)groups tasks, including ones answered without a subagent. Stored on the record
  and the thread (a journal entry, so `ThreadSummary.workstream` survives restarts), on the persisted
  spec, and re-sent to clients.
- Digest: each note lists its workstreams (name, tasks with status and summary). Prompt: group lines
  that belong together (one trip, purchase, project, decision, or lines under one heading); reuse a
  workstream's name for new related lines; never group unrelated ones.
- Kickoff: "Other tasks in this workstream:" with each sibling's text, status and summary.
- Mock brain (`testing/brain`): tasks under the same markdown heading share a workstream named after
  the heading (deterministic, for demo mode and tests).

**Fan-out.**
- A subagent tool `spawn_helpers({ helpers: [{ goal, instructions? }] })` (1–6 helpers). It blocks
  until every helper reports, then returns each helper's goal and report; the subagent combines.
- A helper is a harness session on the subagent model with a helper system prompt, the knowledge
  tools (`read_note`, `search_notes`), `share_finding`, `web` only if its parent has `web`, and a
  `report({ summary })` tool that ends it. No `edit_note`, `ask_user`, artifacts, browser, computer,
  shell or files: anything effectful stays with the parent, behind approvals. A helper call the gate
  wants approved is denied ("helpers can't ask; leave it to the main agent").
- Limits (constants for now): 6 helpers per call, 8 helper sessions at once across all tasks (not
  counted against `maxConcurrentSubagents`; the rest queue), 5 minutes and 40 model steps per
  helper (a helper that hits one reports what it has as failed). Cancelling the task (or its
  subagent) cancels its helpers.
- Progress: the parent's record gets `helpers { total, done }` (cleared when the parent finishes)
  and its badge summary "N agents · M done" until the parent posts its own. The `spawn_helpers`
  tool row in the parent thread is labeled "Split across N helpers", updates its result preview as
  helpers finish ("2 of 3 done"), and lists each helper's goal, status and one-line report.
  Helpers' own tool calls don't get rows.
- Prompt: when a task has several independent parts (compare N products, check N sources, research
  N places), spawn one helper per part, then combine. Mock brain: a subagent whose task starts with
  "Compare" and lists 2+ items (commas / "and") spawns one helper per item.
- Early progress: subagents `post_update` with a badge summary at their first milestone (within
  their first few steps), so badges move within ~30 s.

**Also:** the demo vault (`apps/daemon/src/demo-vault.ts`, `DDL_DEMO=1`) gets a heading with two
related tasks and a "Compare …" task, so demo mode shows all four features. Docs:
`docs/AGENT_SYSTEM.md` (board, workstreams, helpers), `docs/DATA_FORMATS.md`, J14–J16 in
`docs/USER_JOURNEYS.md` with their tests. Tests: scenario tests (`test/scenarios`) for each feature
through the real runtime and gate (helpers gated, cancelled with the task, limits; a preference
reaching a sibling; workstream in kickoff, digest, record, thread and after a restart), unit tests
for the store and tools, safety eval cases for the new tools, `pnpm eval:mock` green.

## Stream B: web (`apps/web`, `packages/editor`)

- **Note status header** under the note title (`features/tabs/NoteHeader.tsx` /
  `features/daily/DailyHeader.tsx`; any note with records): counts from the note's records only —
  working (`triaging`, `queued`, `working`), needs you (`waiting_approval`, `waiting_user`, warning
  tint), done. Hidden when all are zero. Each count is a button (`data-tooltip`, pointer): clicking
  jumps to the first task line with that status and cycles on repeated clicks (`scrollToLine`,
  0-based). Derived from the records store, never from the document: nothing on the keystroke path.
- **Working lines:** a soft shimmer across task lines whose record is `triaging` / `working`
  (packages/editor line decoration or CSS on the existing status line class); a static tint under
  `prefers-reduced-motion`. No per-frame JS.
- **Helpers in the badge:** with `record.helpers`, the badge gets a small people glyph and the
  tooltip "6 helper agents, 4 finished" (the label stays the summary).
- **Inbox workstreams** (`features/agent/Inbox.tsx`, `status-meta.ts`): "Needs you" stays first
  and flat. Then one group per workstream `(notePath, workstream)` among the listed threads that
  don't need the user: a header with the name, its thread count and an aggregate status, then its
  threads. Threads without a workstream keep the status sections. The thread view's header shows a
  workstream chip.
- Tests: unit tests (grouping, counts, cycling), component tests, a Playwright e2e with synthetic
  records/threads if needed (the lead extends e2e once stream A's mock brain lands),
  `pnpm e2e:perf` and `pnpm bench:check` within budget, `e2e/polish.spec.ts` (tooltips, cursors).
  Update `apps/web/README.md` (the contract the Mac follows).

## Stream C: Mac (`apps/macos`)

- The same four client pieces with the same wording, rules and timings as stream B, in
  `NoteHeaderView` (status header, jumping via the editor's scroll-to-line), `DailyDoListEditor`
  (working-line shimmer: an overlay `CAGradientLayer` animation on the line rect, no text layout
  churn, static tint with Reduce Motion; the badge's helper glyph and tooltip), and
  `DailyDoListAgent` (`InboxGrouping` + `InboxView` workstream groups, the workstream chip in the
  thread header). Controls use `.tooltip(…)` and `.pointingHandCursor()`.
- Tests: Swift Testing unit tests for counts, cycling, grouping and badge text; run
  `scripts/test.sh DailyDoListAgent`, `DailyDoListEditor`, `app`. Keep the editor's perf tests
  green.

## Out of scope for now

One merged conversation per workstream (threads stay per task; the group is the unit in the inbox),
replying in the note, carrying questions over to today, cross-day workstreams, settings for the
helper limits.
