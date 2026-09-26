# Spec: showing what the orchestrator is doing while you write

Status: built (`3f69ea2`).

Read `AGENTS.md` first (invariant 8: nothing on the keystroke path; anchors mapped through
editor transactions; wire changes in core + contract + Swift together; web and macOS control
rules).

## Decided with the user (2026-09-25)

The fast "triaging" badge on task lines is loved, but it only appears for checkbox tasks. When the
user just writes, they want to see when the orchestrator notices, works, and what it concluded,
on any line.

Today a non-task line that may be addressed to the agent (`mayBeRequest` in
`packages/core/src/markdown/prose.ts`) wakes the orchestrator by itself, and every other line
reaches it in the next digest, but nothing in the editor shows it.

## Wire (`packages/core/src/protocol.ts` and `agent-types.ts`, contract, Swift models)

```ts
export type OrchestratorPhase = "idle" | "noticed" | "reading" | "thinking" | "acting";

export interface OrchestratorTrigger {
  kind: "note" | "task" | "message" | "routine" | "approval" | "other";
  notePath?: string;
  /** The lines that woke it (0-based, as they were), for anchoring chips in the editor. */
  lines?: Array<{ line: number; text: string }>;
  /** Short and human: "your note", "“call mom tomorrow”". */
  summary: string;
}

export type OrchestratorOutcomeKind =
  | "no_action" | "tasks_added" | "note_edited" | "replied" | "delegated"
  | "routine_created" | "asked_approval";

export interface OrchestratorOutcome {
  kind: OrchestratorOutcomeKind;
  count?: number;
  /** The thread it created or acted in, when there is one. */
  threadId?: string;
  /** One short line for the chip's tooltip. */
  text?: string;
}

export interface OrchestratorActivity {
  phase: OrchestratorPhase;
  /** The orchestrator chat message that starts this turn (to open it). */
  turnId?: string;
  trigger?: OrchestratorTrigger;
  startedAt?: number;
  /** Present right after a turn ends (phase "idle"), shown briefly. */
  outcome?: OrchestratorOutcome;
}

// ServerEvent gains  { type: "orchestrator.activity"; activity: OrchestratorActivity }
// AgentStatusResponse gains  orchestrator?: OrchestratorActivity   (a client joining mid-turn)
```

- `noticed` is emitted as soon as the watcher sees lines that may be requests, before the settle
  delay and before any model turn, so the chip appears as fast as the task badge does.
- `reading` while it builds the digest, `thinking` during the model turn, `acting` while its tools
  run; then `idle` with an `outcome`.
- The relay (`apps/daemon/src/relay/`) forwards `orchestrator.activity` from the always-on machine.
- The daemon's mock agent and `InMemoryDaemonClient` emit plausible sequences.

## Editor (web and Mac, the same behavior and wording)

- **A chip at the end of each line that woke it,** styled like the task triage badge:
  a quiet dot for `noticed`; "Orchestrator is looking…" for `reading`/`thinking`; "Working…" for
  `acting`; then the outcome ("Added a task ↗", "Added 3 tasks ↗", "Replied ↗", "Started a task ↗",
  "Made a routine ↗", "Needs your approval ↗", "Nothing to do"), fading after a few seconds
  ("Nothing to do" sooner). Clicking opens the orchestrator chat at `turnId` (or the thread in
  `outcome.threadId`). Chips anchor by line and text and map through edits; a line edited beyond
  recognition drops its chip. Reduced motion: no pulsing.
- **A note-level indicator** in the note header while the orchestrator works on the open note
  ("Orchestrator: reading this note…", "thinking…", "working…"), and in the status bar what it is
  doing elsewhere ("Orchestrator: working on 2026-09-24").
- Nothing on the keystroke path: chips update on events and map through transactions only.
- Tooltips and commands follow the control rules; the polish audit and `TooltipTests` cover them.

## Tests

Agent: the activity sequence per trigger kind (prose line, task, message, routine), `noticed`
before the settle delay, outcomes from the turn's tool calls, bounded summaries. Daemon: the event
and the status field, relay forwarding. Web: unit tests for chip anchoring and mapping, e2e with
the real keyboard (write a request-like line, see the dot, then the outcome; write plain prose,
see "Nothing to do" or no chip), perf e2e unchanged. Mac: store and view tests with fakes,
snapshots, tooltip tests.
