# Agent system

The agent system lives in `packages/agent`. The daemon creates it with
`createAgentRuntime({ mode, storage, settings, home, llm, execution, connectors, logger })`.

```
storage.watch ─▶ TaskWatcher ─▶ Orchestrator ──spawn_subagent──▶ SubagentManager
                  (parse, track,     (control plane +                (one harness session
                   settle)            orchestrator agent)             per task)
                                          │                               │
                                          └──────────── every tool call ──┘
                                                          ▼
                                              SafetyGate → SafetyEvaluator
                                                   │ require_approval
                                                   ▼
                                             ApprovalBroker ──▶ UI approval card
```

## Modes

| Mode | Harness | Safety | Network |
| --- | --- | --- | --- |
| `live` | `settings.agent.harness`: `pi` — the Pi coding-agent SDK on OpenRouter (`deepseek/deepseek-v4.1-flash` by default) — or `cursor` — the Cursor CLI's agent (Claude Opus 5.5, `claude-opus-5-5`, by default, see below) | rules + LLM judge | yes |
| `mock` | `ScriptedHarness` with a deterministic script | rules only | no |
| `off` | — (no watcher) | — | no |

`src/harness/registry.ts` picks the harness and checks what it needs: Pi an OpenRouter key that
OpenRouter accepts, Cursor the CLI installed and signed in. When that's missing, `live` starts
degraded and `status().problem` explains how to fix it. Changing `agent.harness` in Settings
switches harnesses at runtime: running work finishes on the old one, new and idle sessions move to
the new one. The safety judge and our `web_search` use OpenRouter with either harness; without a
key the judge is off (uncertain actions ask you) and web search comes from the Cursor CLI. A key
OpenRouter rejects counts as none: it's checked once at startup (the check is shared with the Pi
harness's), instead of every judge call and search failing with a 401.

## 1. Watching the list (TaskWatcher)

- Reacts to every change of a daily note inside the watch window (default: today … +7 days),
  whether it came from the UI, Obsidian, sync or anywhere else; duplicate versions are skipped.
- Parses tasks (`parseTasks`: checkboxes with statuses `[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, nested
  sub-bullets as context, wikilinks) and matches them against the previous state with
  `trackTasks`, so a task keeps its id while you rewrite it (prefix extension while typing, fuzzy
  Dice similarity for edits, positional fallback). Tracker state persists in the sidecar.
- Each changed task gets its own **settle timer** (`settleMs`, default 2.5 s), extended while the
  editor reports you typing on that line, and shortened to ~0.7 s once your cursor leaves the line
  (e.g. you pressed Enter). When one settles, every other task of the note that's due settles with
  it, top to bottom, so tasks written together reach the orchestrator as one batch in note order.
  Blank template tasks are ignored until they have text.
- Emits `added`, `updated`, `completed`, `reopened`, `removed` events.
- The rest of the note settles too: new or edited lines that aren't tasks become one `note` event
  per pause, but only when a line could be addressed to the agent (`orchestrator/prose.ts`: a
  question, `@agent`, `TODO`, a line opening with a request verb). Journaling never wakes the
  orchestrator by itself; it still sees those lines in the whole-note view of its next digest.
- The agent's own lines (ending in `%%agent:<thread>%%`) never count: its tasks aren't announced,
  its prose isn't news. Deleting the marker makes a task the user's, and it is triaged then.
- Keeps each note's latest content for the orchestrator (`getContent`) and tells the agent's edits
  when the user has paused typing in a note (`waitForPause`).

## 2. Deciding (Orchestrator)

- Pure control-plane reactions need no model: a new task immediately shows *triaging*; checking
  off or deleting a task with active work cancels it (session aborted, approvals cancelled); edits
  to a task whose subagent is running are forwarded to that subagent.
- Everything else is batched (~150 ms) into one **event digest** for the day's orchestrator
  session (`orchestrator:<date>`, restarted every 30 turns, 180 s turn timeout). The digest has the
  local time, changed tasks with sub-bullets and previous text, changed lines (prose addressed to
  it), the rest of the list, **the whole note** numbered (`12| line  ⟪tsk_… · working — "badge" ·
  yours⟫`: ids, agent status and badge, and which lines the agent wrote), thread replies, subagent
  reports, running work and the capabilities available. Replies and reports bring their note's
  view along. With computer use it also lists the Mac's desktop apps (running ones first, at most
  80, never protected ones; cached) and whether computer access is allowed, and for which app.
- A task that names a desktop app no connector covers ("ask Grok Bot…", "message Mom on
  WhatsApp…") gets the `computer` capability. When computer access is missing, the orchestrator
  doesn't delegate it: it asks the user to allow access in Settings → Computer Use and waits.
- The orchestrator's tools: `spawn_subagent`, `post_comment`, `ask_user`, `set_task_status`,
  `message_subagent`, `cancel_subagent`, `list_tasks`, `anchor_line`, `edit_note`, `read_note`,
  `search_notes`, `web_search`, `web_fetch`, and the routine tools (`create_routine`,
  `update_routine`, `run_routine`, `list_routines`; see [Routines](#routines)).
- **Anchors**: `anchor_line` attaches a thread to any line that isn't a task (a question, a
  heading…). It becomes a record with `anchor: "line"` and an `anc_…` id that every task tool
  accepts, so the line gets a badge and its own thread like a task. Anchors follow their line as
  the note changes (`resolveLineAnchors`, the task tracker's identity rules); one whose line is
  gone for twice the settle delay is removed and its work stops, like a deleted task's. An anchor
  the model created but never used in its turn is dropped.
- Its prompt (`src/prompts/orchestrator.ts`) defines exactly four outcomes per task: **delegate**
  (default for anything digital), **answer** (quick facts/lookups), **ask** (only when genuinely
  ambiguous), **ignore** (chores, exercise, personal calls — silently). It knows the list
  conventions: `task -> outcome`, sub-bullets as context, `[[Daily/…]]` links as deferral.

### The orchestrator's chat

The orchestrator has a thread of its own, `thr_orchestrator` (`ORCHESTRATOR_THREAD_ID` in
`@ddl/core`; `taskId` and `notePath` null, title "Orchestrator"), created when the runtime starts
and kept to its newest 500 messages. `src/orchestrator/chat.ts` records every turn in it:

- a `status` line (author `system`) saying what woke it: "Daily/2026-09-24.md changed: 2 tasks,
  1 line", "You replied in “Book the dentist”", "“Research desks” finished", "You asked to retry
  …", "You wrote to me", joined with " · " when a turn batches several;
- its text, streamed like a subagent's (`thread.delta`), author `orchestrator`;
- its tool calls with status and a result preview (`spawn_subagent` with the capabilities it
  granted, `post_comment`, `ask_user`, `set_task_status` including `ignored`,
  `message_subagent`/`cancel_subagent`, the web and note tools). Their inputs carry the `taskId`,
  so clients link each decision to the task's thread;
- one `status` line authored by `orchestrator`, "Thought for N s", when the harness sent thinking
  deltas (the total for the turn; the thinking itself is never stored).

Its status is `working` during a turn and `idle` otherwise; a failed or stopped turn ends with a
`failed`/`cancelled` status line. Approvals its own tool calls need (changing your lines with
`edit_note`) appear in this chat.

**Talking to it.** `POST /api/threads/thr_orchestrator/messages` is a direct message. It queues an
event like any other (answered in the next turn, after the one running now); the digest carries it
under "## Messages to you" with today's note in view, and "## Your recent chat with the user" (the
last 8 messages of the chat, their times relative) whenever the user wrote or the session is fresh,
so a restarted or rotated session still knows the conversation. The prompt's "Your chat with the
user" section makes the turn's text the reply and has it act with its tools when asked: dropping a
task (`cancel_subagent`, or `set_task_status` "ignored" with summary "Dropped"), passing
instructions to a subagent (`message_subagent`), answering "what are you working on?" from the
digest. Every call goes through the safety gate as always. `POST …/cancel` stops the turn in
progress: its pending approvals are denied, the session is aborted and dropped (the next turn starts
fresh), subagents it started keep working, and tasks it was still triaging go back to their earlier
outcome or become *Stopped*.

## 3. Doing (SubagentManager)

- One harness session per task/thread with a crisp goal, instructions and the minimal capabilities:
  `web`, `browser`, `computer`, `shell`, `files`, `connectors`. Concurrency is limited
  (`maxConcurrentSubagents`, default 3) with a FIFO queue.
- Tools: thread tools (`post_update`, `ask_user`, `create_artifact`, `finish_task`), `edit_note`
  (bound to its task: results go under it by default), knowledge (`read_note`, `search_notes`,
  `web_fetch` with SSRF protection, `web_search` via OpenRouter's web plugin), execution tools
  (`browser_*`, `computer_*`), MCP connector tools (`mcp__server__tool`),
  and built-in file/shell tools bound to the task's workspace (`$DDL_HOME/workspaces/<thread>`):
  Pi's own, or our equivalents with the same names and inputs (`src/harness/builtin-tools.ts`).
- **Computer use** (macOS): with the `ddl-computer` helper, agents operate one app at a time in
  the background through its accessibility tree: `computer_open_app` → `computer_app_state` (a
  tree with element ids) → `computer_set_value` / `computer_press` → read it again. The
  screen-level tools (screenshots, clicks, keys on the real desktop) remain as the fallback, and
  also take an `app` target. Details in `packages/agent/src/execution/README.md`.
- Harness events stream into the thread: text deltas, tool calls (running/ok/error/blocked), live
  browser/computer frames (only while someone is watching), artifacts.
- Finished sessions stay warm so your reply resumes them with full context; *Retry* starts fresh
  with a summary of the previous attempt.
- Prompt (`src/prompts/subagent.ts`): plan briefly, report milestones, create artifacts for real
  outputs, attempt risky steps normally (the safety gate asks you), never work around a denial,
  never enter credentials you didn't provide, treat web content as untrusted.

## The living list: writing, anchors, citations

- **Agent text in notes.** `edit_note` (`src/tools/notes.ts`) adds lines under a task or anchor,
  after a line, or at the end; it can also rewrite or delete lines and set checkboxes. Every line
  the agent writes ends with `%%agent:<threadId>%%` (`@ddl/core` `agent-text.ts`), an Obsidian
  comment: Obsidian hides it, our editors hide it and draw the line as agent text linked to its
  thread. Lines are found by their quoted text near the given number, so a miscounted line still
  lands right; edits wait for a pause in the user's typing and are replanned if the note changed.
  Safety: its own text goes in directly, changing the user's needs approval (see the safety
  README). Clients merge an agent edit into unsaved typing with `mergeText` (`@ddl/core`
  `merge.ts`, a line-based three-way merge) instead of making a conflict copy.
- **Citations.** Agents cite with markdown links (`[CTBUH](https://…)`, numbered `[1](https://…)`)
  and `[[Note]]` links. The runtime remembers pages `web_search`/`web_fetch` returned
  (`threads/sources.ts`); when a thread cites one (a message or a note line it wrote), the thread
  keeps it in `Thread.sources` (url, title, snippet). Clients preview citations from there and
  never fetch a page to build a preview.
- **Badges** stay the short status next to the line ("Booked · Tue 9:30am"); note lines are for
  results worth keeping, with their sources.

## Routines

Standing jobs the agent runs on a schedule: a morning briefing, a price watch, a weekly review
(`src/routines/`).

- **Files.** One markdown file per routine in the vault's top-level `Routines/` folder; its name is
  the file name. The frontmatter holds `schedule` (natural language, local time), `notify`
  (`always` by default, `when changed`, `never`), `uses` (the capabilities its runs get; without
  it, runs are triaged like a task) and `paused`; the body is the instructions. `@ddl/core` reads
  the file (`routines.ts`, which never throws: problems are listed on the routine) and parses the
  schedule into a recurrence (`routine-schedule.ts`: every day, weekdays, given weekdays, every N
  hours or minutes (at least 15), monthly on a day, at listed times) with the next run computed
  in local time across DST changes. A phrase it can't read is an error on the routine, never a
  guess.
- **Catalog and library.** `RoutineCatalog` reads `Routines/*.md` and follows edits made anywhere
  (the app, Obsidian, sync) through storage events; invalid or unreadable files are listed with
  their problems. `RoutineLibrary` joins each file with the scheduler's state into the wire
  `Routine` (schedule in words, next run, last run, run count, extra runs left today), and writes
  the files for create, pause and resume (`files.ts`: checks the name, schedule and instructions,
  never overwrites a routine, and changes only the frontmatter lines it sets).
- **State.** `.daily-do-list/state/routines.json` (`RoutineStateStore`, format in `@ddl/contract`):
  per routine the planned next run and the schedule it was planned from, the last run (status,
  compact result, `changed`, whether it notified), recent run threads and today's extra runs.
  Nothing of it goes in the routine file. A corrupt file is moved to `.daily-do-list/corrupt/`, a
  newer app's file is left alone, and concurrent saves (another device) merge per routine.
- **Scheduler.** `RoutineScheduler` runs in the agent runtime and is active exactly while the agent
  can run here and is enabled. It looks at least once a minute, and at the next due slot. A slot
  found more than 2 minutes late (the Mac slept, the daemon was down) runs once, as a `catch_up`
  run, however many slots went by; switching the agent back on isn't missing anything, so routines
  start again from their next slot. A slot that comes while the previous run is still going is
  skipped. Paused and invalid routines aren't planned; a resumed one starts from its next slot.
- **Runs.** A run is a task-like record `run_…` (never listed with a note's tasks) with a thread
  that has `routineId`, titled with the routine's name: it streams, asks, waits for approvals and
  takes replies like a task's thread, and clients list it under its routine, not in the inbox.
  With `uses`, a subagent starts with those capabilities (those available here; if none is, the run
  fails "Can't run here"); without, the orchestrator triages it from "## Routine runs" in its
  digest. The run's kickoff (`RoutineBrief`) has the instructions, what started it, and the
  previous run's status and result, so it can say what's new.
- **Notify.** When a run's first turn ends, its result is saved and `routine.notification` goes out
  at most once per run: failures and questions unless `notify` is `never`; results with `always`,
  and with `when changed` only when the run's `finish_task` said `changed: true` (a run that
  doesn't say counts as changed). A run waiting on approval surfaces like any approval.
- **Budget.** Run now (`POST /api/routines/:id/run`, or the orchestrator's `run_routine`) may start
  `EXTRA_RUNS_PER_DAY` (5) runs of a routine per local day, beyond its schedule; scheduled and
  catch-up runs don't count, and a routine never has two runs at once. A run stops after 15
  minutes of working time (`MAX_ROUTINE_RUN_MS`; waiting for approval doesn't count) and fails
  "Took too long".
- **Lease.** With the sync service only the device holding the agent lease has a real runtime, so
  only it schedules. The other devices list, create, pause and resume routines through the files
  (a read-only library that follows the synced state file) and answer Run now with 503. The
  handover saves the state before the next device loads it, so a slot runs on one device only, and
  one missed while no device held the lease catches up once on the next holder.
- **Creation by saying it.** The digest lists the user's routines under "## Routines", and the
  prompt turns "every morning, brief me on…" (a task, a line or a chat message) into
  `create_routine`: a short name, a schedule the parser reads (a vague "every morning" becomes a
  time, which it says), instructions a future run can follow alone, `notify: when_changed` for
  watches, and the fewest `uses`. An existing routine for the same thing is changed with
  `update_routine`, which also pauses and resumes.
- **Safety.** Nothing about routines bypasses the gate: every tool call of every run is gated like
  any agent's. The routine tools have their own rules (`safety/rules/routines.ts`): creating a
  routine, changing what or when it runs, and resuming it are `require_approval` at medium risk,
  so the approval policy decides as for any action; pausing, running now (its actions are gated
  one by one) and listing are allowed. A run editing a file in `Routines/` asks too. The
  scheduler's state is sidecar state: writing, moving or deleting it is a hard deny under every
  policy (`src/routines/state-protection.test.ts`).
- **Wire.** `GET`/`POST /api/routines`, `GET /api/routines/:id`, `POST …/run`, `…/pause`,
  `…/resume`, `?routineId=` on `/api/threads`, and the `routines.changed` and
  `routine.notification` events (status codes in `apps/daemon/README.md`).

## 4. Staying safe (SafetyGate)

Every tool call — orchestrator or subagent, built-in, execution, or MCP — goes through
`beforeToolCall` before it executes. The Pi adapter refuses to start a session if the gate is not
installed, and only executes a tool call the gate approved (by call id, once). The Cursor adapter
serves every tool itself and gates each call before running it; see below for the CLI's own tools.

Pipeline (details and the full rule table in `packages/agent/src/safety/README.md`):

1. **Policy & grants** — always-deny/allow/require lists; standing grants from "approve for this
   task" (narrowed by category and risk; a computer action's grant covers every computer action
   in the app it targeted, and only that app).
2. **Hints** — internal and read-only tools take a fast path unless a risky rule matches. A tool
   that knows the real target (`subject`: the app's real name, the element's real label) adds it to
   the model's words; it can only make the verdict stricter.
3. **Rules** — 140 rules across payment, booking, communication, publishing, account,
   credentials, privacy, destructive, system, computer control, forms, file writes and network,
   including a real shell parser (pipelines, subshells, `bash -c`, heredocs…). Catastrophic
   commands, and operating Daily Do List itself, System Settings, password managers or
   authenticators, are **hard-denied** even with approval.
4. **LLM judge** — for uncertain effectful actions: a separate, tool-less model call with a strict
   JSON schema and prompt-injection defenses; it can only escalate, and falls back to
   `require_approval` on timeout or bad output.
5. **Most restrictive wins; fail closed.** Any internal error means `require_approval`.

`require_approval` pauses the agent and shows an approval card (Approve once / Approve for this
task / Deny with a note). Pending approvals time out (default 12 h → denied) and are cancelled when
the task is removed or completed.

**Approval policies.** The user's `settings.agent.approvalPolicy` (Settings → Agent → Approvals)
decides which verdicts ask; the gate applies it after the evaluation, reading it on every call:

- `ask_every_action` — every effectful action asks, even ones the evaluator allows (thread tools,
  note reads, web search/fetch and read-only file, browser and computer tools never ask).
- `ask_risky` (default) — the evaluator decides, as above.
- `ask_high_risk` — only `require_approval` verdicts of high or critical risk ask; the rest run.
- `run_everything` — nothing asks.

`deny` verdicts are blocked under every policy. A looser policy approves the pending approvals it
wouldn't ask about ("Approved by your approval policy"); a stricter one leaves them waiting.
Agents can't change the policy: the settings file and the rest of the sidecar, `$DDL_HOME`, the
daemon, the web dev server and the app itself are hard denies. Web and Mac show a policy other
than the default in the status bar ("Runs everything" in the warning color), and "Run everything"
asks for confirmation.

## 5. The Cursor CLI harness

`@ddl/agent/cursor` (`src/harness/cursor/`) runs conversations on the Cursor CLI's agent
(`agent acp`, the Agent Client Protocol: JSON-RPC over stdio), signed in with your own Cursor
account — no API key. One CLI process per session; the model is `agent.cursorModel`, matched
against the CLI's model list by id, base id (`gpt-5.5` for `gpt-5.5[…]`) or display name.

**Tools.** The CLI runs its own tools (read, grep/glob, shell, edit, delete, web fetch, subagents)
without asking the client, so none of them is used. Every tool the agent has is ours, served over
a local MCP endpoint (the "bridge", one per harness on 127.0.0.1 with a per-session path and bearer
token): the ToolSpecs of the session plus, when `builtinTools` asks for them, `read`/`write`/`edit`
(or `read`/`grep`/`find`/`ls`) confined to the task workspace and `bash` through the
ShellExecutor — the names and inputs Pi uses, gated without a spec so the built-in safety rules
apply. Each MCP call is validated against the tool's schema, then gated, then executed, with the
same events as Pi; side-effecting calls run one at a time.

**Keeping the CLI's tools off.** Layered, each layer enough on its own for what it covers:

1. A private CLI config (`CURSOR_CONFIG_DIR=$DDL_HOME/cursor/config`): allowlist approvals with an
   empty allowlist except our MCP server, web search always asks, sandboxed shell, and a deny
   list — `Read(**)`, `Write(**)` (and `/**`), `Shell(*)`, `WebFetch(*)` and `Mcp(<name>:*)` for
   each server in your `~/.cursor/mcp.json`. Your own CLI config (allowlists, approval mode) never
   applies. The same deny list is the session workspace's `.cursor/cli.json`.
2. Permission requests the CLI still sends go through the gate: its web search and fetch as
   `web_search {query}` / `web_fetch {url}` (only for agents with web access), answered
   allow-once / reject-once, never "always"; calls to our own server are allowed (the bridge gates
   them); everything else, including the CLI's question prompts, is rejected.
3. A policy monitor watches every tool call the CLI reports. Blocked calls are reported as
   completed too, but without a result; a disabled tool that produced one (file content, command
   output, a diff, results of an unapproved web request, output of another MCP server) stops the
   session with an error. grep/glob are tolerated: the CLI confines them to the session workspace,
   which holds only our `AGENTS.md` and `.cursor/cli.json`.

**Sessions.** The CLI's cwd is `$DDL_HOME/cursor/sessions/<id>/workspace` (0700) with `AGENTS.md` —
the system prompt, tool guidance and the tools' prompt guidelines — not the task workspace. Its
data dir sits next to it; both, and the CLI's transcript store, are deleted with the session, and
stale ones when the harness starts. The CLI gets a minimal environment (paths, locale, proxies,
CA bundles; never API keys) and runs in its own process group, so disposing ends it and its helper
processes. `prompt` queues follow-ups; `steer` is delivered at the next turn boundary as a
follow-up within the same run (ACP can't inject into a running turn); `abort` sends
`session/cancel` and stops the CLI if the turn doesn't end within 10 s. Idle sessions end their
process after 5 minutes (each is 100–500 MB) and resume with `session/load` on the next prompt, as
does a session whose CLI crashed. Resuming takes ~5 s, so typing in a watched note warms the
harness: the orchestrator's suspended session resumes right away, and a spare CLI starts for the
next new session (it gets that session's `AGENTS.md` before its first `session/new` and is stopped
after 2 idle minutes). See `docs/PERFORMANCE.md` for the numbers. Each session records its CLI's pid in its folder (`cli.pid`):
a daemon that was killed can leave CLI processes running (the CLI doesn't always exit when its
input closes), so the next daemon stops the process of every session folder no live session owns —
only while that process still works inside the folder, so a reused pid is never signalled — and
then removes the folder.

**Long calls.** The CLI's MCP client gives up on a request after 60 s. A call still running after
45 s — typically waiting for your approval — is answered "still running, end your turn" and
finishes in the background; its outcome is sent to the model as a follow-up in the same run.

**Limits.** Browser and computer use come from our execution tools over MCP (the CLI has no
browser tool, and Cursor's computer use is cloud-only). The CLI's agent mode lists one preset per
model (Opus 5.5 runs with medium effort, not fast) and rejects every other variant, flat
(`claude-opus-5-5-high-fast`) or bracketed; a configured variant runs as its model's preset, with
a warning in the log. `thinking` is ignored for the same reason. No token usage events. The CLI may
add your account's user and team rules to the prompt. Session creation takes ~4–8 s and each turn a
few seconds more than Pi because of process start and the CLI's own tool loop.

Try it: `pnpm --filter @ddl/agent exec tsx scripts/smoke-cursor.ts` (real CLI, a little usage).
Tests use a fake CLI (`src/harness/cursor/testing/fake-cursor-cli.ts`) that speaks the same ACP
and calls the bridge like the real one.

## Evals

`evals/` holds datasets and suites:

- **safety** (280 cases, 160+ marked critical, the routine tools and the scheduler's state
  included): mock mode runs the rules-only evaluator and requires **zero false allows**; live mode
  adds the LLM judge. Cases can carry a `subject` (what the tool knows about the real target).
- **triage** (75+ synthetic tasks, including desktop-app tasks with and without computer access,
  recurring requests that should become routines, and messages written to the orchestrator in its
  chat — drop, pass on, just reply, or create a routine): live mode runs the real orchestrator
  prompt on Pi with recorded (stubbed) tools and scores decision accuracy, capability recall (a
  routine's `uses`), a routine's schedule and `notify`, and time-to-first-action; mock mode
  validates the dataset with a deterministic baseline.

```bash
pnpm eval:mock                         # deterministic, runs in CI
pnpm eval -- --suite triage            # real model (needs OPENROUTER_API_KEY)
```

## Extending

- New tool: name it in `src/tools/contracts.ts`, implement a `ToolSpec` with honest safety hints
  and a `describe()` (plus a `subject()` when it knows the real target better than the model's
  words), add safety eval cases.
- New execution backend: implement `ExecutionProvider` and register it in `createExecutionProvider`.
- New harness: implement `Harness` in `src/harness/<name>/` (only that directory may import its
  SDK or know its CLI), add an entry to `src/harness/registry.ts` that checks its requirements and
  loads it with `import()`, and a value to `AgentHarnessKind` in `@ddl/core` settings.

## Testing with the fake agent

The real model is never used in tests. `@ddl/agent/testing` (see
`packages/agent/src/testing/README.md`) provides a **FakeBrain** — a deterministic stand-in for
the model that plays the orchestrator (parses the digest, triages every task, answers messages
written to it in its chat), subagents (a
step-by-step plan that reacts to tool results, blocks and steering), the safety judge (schema-valid
verdicts) and web search — and runs it two ways:

- **In-process** (`createFakeAgentScript` on `ScriptedHarness`): what `DDL_AGENT_MODE=mock` uses, and
  the breadth of the scenario matrix in `packages/agent/test/scenarios/` (≈100 end-to-end runtime
  scenarios in a few seconds: triage, approvals, cancellation, steering, retries, concurrency,
  restarts, vault changes, midnight, contract checks on every event and sidecar file).
- **Over HTTP** (`startFakeOpenRouter`): a local OpenAI-compatible server (streaming SSE, tool calls,
  `/key`, `/models`, fault injection) that the real Pi harness and OpenRouter client talk to.

`createFakeAgentRuntime({ via: "scripted" | "pi-http" })` wires either into the real runtime and
safety stack, with helpers to write notes, wait for statuses, decide approvals and reply, and an
audit that every executed tool passed the safety gate.

Point the whole app at the fake — the real daemon and harness at zero cost:

```bash
pnpm dev:fake                             # daemon + web, live mode, sandboxed fake agent
pnpm dev:fake -- --scratch                # …with a throwaway DDL_HOME and vault
pnpm --filter @ddl/agent fake-openrouter  # just the server; prints the env to use
pnpm --filter @ddl/web e2e:fullstack      # Playwright against daemon + fake model
```

Plumbing: `DDL_OPENROUTER_BASE_URL` redirects the Pi harness, the key check and the daemon's
OpenRouter client to another OpenAI-compatible endpoint; `DDL_AGENT_MOCK_ACTIONS=1` gives live-mode
subagents the simulated `mock_irreversible_action` so approvals can be exercised safely.
