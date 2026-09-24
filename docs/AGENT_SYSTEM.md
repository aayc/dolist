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
| `live` | Pi coding-agent SDK on OpenRouter (`deepseek/deepseek-v4.1-flash` by default) | rules + LLM judge | yes |
| `mock` | `ScriptedHarness` with a deterministic script | rules only | no |
| `off` | — (no watcher) | — | no |

Without an API key, `live` starts degraded and `status().problem` explains how to fix it.

## 1. Watching the list (TaskWatcher)

- Reacts to every change of a daily note inside the watch window (default: today … +7 days),
  whether it came from the UI, Obsidian, sync or anywhere else; duplicate versions are skipped.
- Parses tasks (`parseTasks`: checkboxes with statuses `[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, nested
  sub-bullets as context, wikilinks) and matches them against the previous state with
  `trackTasks`, so a task keeps its id while you rewrite it (prefix extension while typing, fuzzy
  Dice similarity for edits, positional fallback). Tracker state persists in the sidecar.
- Each changed task gets its own **settle timer** (`settleMs`, default 2.5 s), extended while the
  editor reports you typing on that line, and shortened to ~0.7 s once your cursor leaves the line
  (e.g. you pressed Enter). Blank template tasks are ignored until they have text.
- Emits `added`, `updated`, `completed`, `reopened`, `removed` events.

## 2. Deciding (Orchestrator)

- Pure control-plane reactions need no model: a new task immediately shows *triaging*; checking
  off or deleting a task with active work cancels it (session aborted, approvals cancelled); edits
  to a task whose subagent is running are forwarded to that subagent.
- Everything else is batched (~150 ms) into one **event digest** for the day's orchestrator
  session (`orchestrator:<date>`, restarted every 30 turns, 180 s turn timeout). The digest has the
  local time, changed tasks with sub-bullets and previous text, the rest of the list, thread
  replies, subagent reports, running work and the capabilities available.
- The orchestrator's tools: `spawn_subagent`, `post_comment`, `ask_user`, `set_task_status`,
  `message_subagent`, `cancel_subagent`, `list_tasks`, `read_note`, `web_search`, `web_fetch`.
- Its prompt (`src/prompts/orchestrator.ts`) defines exactly four outcomes per task: **delegate**
  (default for anything digital), **answer** (quick facts/lookups), **ask** (only when genuinely
  ambiguous), **ignore** (chores, exercise, personal calls — silently). It knows the list
  conventions: `task -> outcome`, sub-bullets as context, `[[Daily/…]]` links as deferral.

## 3. Doing (SubagentManager)

- One harness session per task/thread with a crisp goal, instructions and the minimal capabilities:
  `web`, `browser`, `computer`, `shell`, `files`, `connectors`. Concurrency is limited
  (`maxConcurrentSubagents`, default 3) with a FIFO queue.
- Tools: thread tools (`post_update`, `ask_user`, `create_artifact`, `finish_task`), knowledge
  (`read_note`, `search_notes`, `web_fetch` with SSRF protection, `web_search` via OpenRouter's web
  plugin), execution tools (`browser_*`, `computer_*`), MCP connector tools (`mcp__server__tool`),
  and Pi's built-in file/shell tools bound to the task's workspace (`$DDL_HOME/workspaces/<thread>`).
- Harness events stream into the thread: text deltas, tool calls (running/ok/error/blocked), live
  browser/computer frames (only while someone is watching), artifacts.
- Finished sessions stay warm so your reply resumes them with full context; *Retry* starts fresh
  with a summary of the previous attempt.
- Prompt (`src/prompts/subagent.ts`): plan briefly, report milestones, create artifacts for real
  outputs, attempt risky steps normally (the safety gate asks you), never work around a denial,
  never enter credentials you didn't provide, treat web content as untrusted.

## 4. Staying safe (SafetyGate)

Every tool call — orchestrator or subagent, built-in, execution, or MCP — goes through
`beforeToolCall` before it executes. The Pi adapter refuses to start a session if the gate is not
installed, and only executes a tool call the gate approved (by call id, once).

Pipeline (details and the full rule table in `packages/agent/src/safety/README.md`):

1. **Policy & grants** — always-deny/allow/require lists; standing grants from "approve for this
   task" (narrowed by category and risk).
2. **Hints** — internal and read-only tools take a fast path unless a risky rule matches.
3. **Rules** — ~130 rules across payment, booking, communication, publishing, account,
   credentials, privacy, destructive, system, computer control, forms, file writes and network,
   including a real shell parser (pipelines, subshells, `bash -c`, heredocs…). Catastrophic
   commands are **hard-denied** even with approval.
4. **LLM judge** — for uncertain effectful actions: a separate, tool-less model call with a strict
   JSON schema and prompt-injection defenses; it can only escalate, and falls back to
   `require_approval` on timeout or bad output.
5. **Most restrictive wins; fail closed.** Any internal error means `require_approval`.

`require_approval` pauses the agent and shows an approval card (Approve once / Approve for this
task / Deny with a note). Pending approvals time out (default 12 h → denied) and are cancelled when
the task is removed or completed.

## Evals

`evals/` holds datasets and suites:

- **safety** (170+ cases, 90 marked critical): mock mode runs the rules-only evaluator and requires
  **zero false allows**; live mode adds the LLM judge.
- **triage** (50+ synthetic tasks): live mode runs the real orchestrator prompt on Pi with recorded
  (stubbed) tools and scores decision accuracy, capability recall and time-to-first-action;
  mock mode validates the dataset with a deterministic baseline.

```bash
pnpm eval:mock                         # deterministic, runs in CI
pnpm eval -- --suite triage            # real model (needs OPENROUTER_API_KEY)
```

## Extending

- New tool: name it in `src/tools/contracts.ts`, implement a `ToolSpec` with honest safety hints
  and a `describe()`, add safety eval cases.
- New execution backend: implement `ExecutionProvider` and register it in `createExecutionProvider`.
- New harness: implement `Harness` in `src/harness/` (only that directory may import Pi).

## Testing with the fake agent

The real model is never used in tests. `@ddl/agent/testing` (see
`packages/agent/src/testing/README.md`) provides a **FakeBrain** — a deterministic stand-in for
the model that plays the orchestrator (parses the digest, triages every task), subagents (a
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
