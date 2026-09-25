/** Agent domain objects: task records, threads and their messages, approvals, artifacts, frames. */
import { ORCHESTRATOR_THREAD_ID } from "@ddl/core";
import { z } from "zod";
import {
  Base64Schema,
  CountSchema,
  EpochMsSchema,
  IdSchema,
  IsoDateSchema,
  NameSchema,
  RuntimeIdSchema,
  VaultPathSchema,
  WIRE_LIMITS,
} from "./primitives";
import { named } from "./registry";

export const TaskAgentStatusSchema = named(
  "TaskAgentStatus",
  "Lifecycle of the agent's work on one to-do item (drives the badge next to the task).",
  z.enum([
    "idle",
    "triaging",
    "queued",
    "working",
    "waiting_approval",
    "waiting_user",
    "done",
    "failed",
    "cancelled",
    "ignored",
  ]),
);

export const TaskAgentRecordSchema = named(
  "TaskAgentRecord",
  "Everything a client needs to render the agent badge for one task line.",
  z.looseObject({
    taskId: IdSchema,
    notePath: VaultPathSchema,
    date: IsoDateSchema.nullable().describe("Local ISO date when the note is a daily note."),
    text: z.string().describe("Latest task text."),
    line: CountSchema.describe("Last known 0-based line."),
    status: TaskAgentStatusSchema,
    summary: z.string().optional().describe("One-line status shown inline in the editor."),
    threadId: RuntimeIdSchema.nullable(),
    updatedAt: EpochMsSchema,
    unread: CountSchema.describe("Agent messages the user has not seen yet."),
    anchor: z
      .literal("line")
      .optional()
      .describe(
        "Present when the thread is attached to a non-task line (taskId is then the anchor id, text the line): clients highlight that line.",
      ),
  }),
);

export const RiskLevelSchema = named(
  "RiskLevel",
  "Safety evaluator's risk estimate for an action.",
  z.enum(["low", "medium", "high", "critical"]),
);

export const ActionCategorySchema = named(
  "ActionCategory",
  "Coarse effect category used by the safety evaluator and shown on approval cards.",
  z.enum([
    "read",
    "compute",
    "network",
    "file_write",
    "browser_input",
    "form_submission",
    "computer_control",
    "communication",
    "publishing",
    "payment",
    "booking",
    "account",
    "credentials",
    "privacy",
    "destructive",
    "system",
    "unknown",
  ]),
);

export const ApprovalScopeSchema = named(
  "ApprovalScope",
  "How far an approval reaches: this call, the rest of this task, or always.",
  z.enum(["once", "task", "always"]),
);

export const ApprovalDecisionSchema = named(
  "ApprovalDecision",
  "The user's answer to an approval request.",
  z.enum(["approve", "deny"]),
);

export const ApprovalStatusSchema = named(
  "ApprovalStatus",
  "Lifecycle of an approval request.",
  z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
);

export const ToolNameSchema = NameSchema.describe("Tool name, e.g. `browser_click`.");

export const ApprovalRequestSchema = named(
  "ApprovalRequest",
  "A risky action paused by the safety gate until the user decides.",
  z.looseObject({
    id: RuntimeIdSchema,
    threadId: RuntimeIdSchema.nullable(),
    taskId: IdSchema.nullable(),
    toolName: ToolNameSchema,
    toolLabel: z.string().optional(),
    input: z.unknown().describe("Tool arguments exactly as the agent proposed them."),
    summary: z.string().describe("Human-readable description of the action."),
    risk: RiskLevelSchema,
    categories: z.array(ActionCategorySchema),
    reason: z.string().describe("Why the safety evaluator wants a human in the loop."),
    status: ApprovalStatusSchema,
    scope: ApprovalScopeSchema.optional().describe("Scope the user granted when approving."),
    decisionNote: z.string().optional(),
    createdAt: EpochMsSchema,
    decidedAt: EpochMsSchema.optional(),
    expiresAt: EpochMsSchema.optional(),
  }),
);

export const ArtifactKindSchema = named(
  "ArtifactKind",
  "How a client should render an artifact.",
  z.enum(["markdown", "code", "html", "image", "json", "text", "file"]),
);

export const ArtifactMetaSchema = named(
  "ArtifactMeta",
  "An agent-produced file attached to a thread (bytes via `GET /api/artifacts/:threadId/:artifactId`).",
  z.looseObject({
    id: RuntimeIdSchema,
    threadId: RuntimeIdSchema,
    title: z.string(),
    kind: ArtifactKindSchema,
    mimeType: z.string().min(1).max(255),
    language: z.string().max(100).optional().describe("Code language hint for `code` artifacts."),
    path: VaultPathSchema.describe("Vault-relative sidecar path of the artifact body."),
    size: CountSchema,
    createdAt: EpochMsSchema,
  }),
);

export const MessageAuthorSchema = named(
  "MessageAuthor",
  "Who wrote a thread message: `you`, `orchestrator`, `system` or `subagent:<name>`.",
  z.union([
    z.literal("you"),
    z.literal("orchestrator"),
    z.literal("system"),
    z.templateLiteral(["subagent:", z.string().min(1).max(100)]),
  ]),
);

const messageBase = {
  id: IdSchema,
  author: MessageAuthorSchema,
  createdAt: EpochMsSchema,
};

export const TextMessageSchema = named(
  "TextMessage",
  "Markdown text from the agent, the user or the system.",
  z.looseObject({
    ...messageBase,
    kind: z.literal("text"),
    role: z.enum(["agent", "user", "system"]),
    text: z.string(),
    streaming: z
      .boolean()
      .optional()
      .describe("True while tokens are still streaming in (see `thread.delta`)."),
  }),
);

export const ToolCallStatusSchema = named(
  "ToolCallStatus",
  "`blocked`: the safety gate refused the call.",
  z.enum(["running", "ok", "error", "blocked"]),
);

export const ToolCallMessageSchema = named(
  "ToolCallMessage",
  "A tool call made by an agent, updated in place as it runs.",
  z.looseObject({
    ...messageBase,
    kind: z.literal("tool_call"),
    toolCallId: IdSchema,
    toolName: ToolNameSchema,
    label: z.string().optional(),
    input: z.unknown(),
    status: ToolCallStatusSchema,
    resultPreview: z.string().optional().describe("Short, UI-safe preview of the result."),
    endedAt: EpochMsSchema.optional(),
  }),
);

export const ApprovalMessageSchema = named(
  "ApprovalMessage",
  "Marks where in the thread an approval was requested.",
  z.looseObject({ ...messageBase, kind: z.literal("approval"), approvalId: RuntimeIdSchema }),
);

export const ArtifactMessageSchema = named(
  "ArtifactMessage",
  "Marks where in the thread an artifact was created.",
  z.looseObject({ ...messageBase, kind: z.literal("artifact"), artifactId: RuntimeIdSchema }),
);

export const StatusMessageSchema = named(
  "StatusMessage",
  "A task status change, with an optional note.",
  z.looseObject({
    ...messageBase,
    kind: z.literal("status"),
    status: TaskAgentStatusSchema,
    text: z.string().optional(),
  }),
);

export const ThreadMessageSchema = named(
  "ThreadMessage",
  "One entry of a task thread, discriminated by `kind`.",
  z.discriminatedUnion("kind", [
    TextMessageSchema,
    ToolCallMessageSchema,
    ApprovalMessageSchema,
    ArtifactMessageSchema,
    StatusMessageSchema,
  ]),
);

export const SurfaceKindSchema = named(
  "SurfaceKind",
  "A live visual surface a thread can expose.",
  z.enum(["browser", "computer"]),
);

const threadBase = {
  id: RuntimeIdSchema,
  taskId: IdSchema.nullable(),
  notePath: VaultPathSchema.nullable(),
  title: z.string().describe("Task text snapshot (kept in sync as the task is edited)."),
  status: TaskAgentStatusSchema,
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  surfaces: z.array(SurfaceKindSchema),
  routineId: RuntimeIdSchema.optional().describe(
    "Set on a routine's runs: the routine (`Routine.id`) this thread is one run of. Clients list these under their routine, not in the task inbox.",
  ),
};

export const CitedSourceSchema = named(
  "CitedSource",
  "A web page an agent found or read, as a citation preview.",
  z.looseObject({
    url: z.string(),
    title: z.string().optional(),
    snippet: z
      .string()
      .optional()
      .describe("A sentence or two from the search result or the page."),
  }),
);

export const OrchestratorThreadIdSchema = named(
  "OrchestratorThreadId",
  "The id of the orchestrator's own chat: a thread with `taskId` and `notePath` null that records each orchestrator turn (a `status` line saying what woke it, its streamed text, its tool calls, whose inputs carry the `taskId` they act on) and takes the user's direct messages (`POST /api/threads/:id/messages`). Its status is `working` during a turn, `idle` otherwise.",
  z.literal(ORCHESTRATOR_THREAD_ID),
);

// ── What the orchestrator is doing ───────────────────────────────────────

export const OrchestratorPhaseSchema = named(
  "OrchestratorPhase",
  "`noticed`: the watcher saw lines that may be requests (before they settle, before any turn); `reading`: a turn builds its digest; `thinking`: the model works on it; `acting`: its tools run; `idle`: nothing going on (right after a turn, with its outcome).",
  z.enum(["idle", "noticed", "reading", "thinking", "acting"]),
);

export const OrchestratorTriggerKindSchema = named(
  "OrchestratorTriggerKind",
  "What woke the orchestrator: lines of a note, tasks, a message (in its chat or a task's thread), a routine run, an approval, or something else (a subagent's report).",
  z.enum(["note", "task", "message", "routine", "approval", "other"]),
);

export const OrchestratorTriggerSchema = named(
  "OrchestratorTrigger",
  "What woke the orchestrator.",
  z.looseObject({
    kind: OrchestratorTriggerKindSchema,
    notePath: VaultPathSchema.optional(),
    lines: z
      .array(z.looseObject({ line: CountSchema, text: z.string() }))
      .optional()
      .describe(
        "The lines that woke it (0-based, as they were: trimmed text), for anchoring chips in the editor. At most 20, each at most 300 characters.",
      ),
    summary: z
      .string()
      .describe(
        "Short and human (at most 80 characters), e.g. `your note` or `“call mom tomorrow”`.",
      ),
  }),
);

export const OrchestratorOutcomeKindSchema = named(
  "OrchestratorOutcomeKind",
  "What a turn did: nothing, added tasks, edited the note, replied, started subagents, made a routine, or asked for approval.",
  z.enum([
    "no_action",
    "tasks_added",
    "note_edited",
    "replied",
    "delegated",
    "routine_created",
    "asked_approval",
  ]),
);

export const OrchestratorOutcomeSchema = named(
  "OrchestratorOutcome",
  "The result of a turn, for the chip shown briefly after it.",
  z.looseObject({
    kind: OrchestratorOutcomeKindSchema,
    count: CountSchema.optional(),
    threadId: RuntimeIdSchema.optional().describe(
      "The thread it created or acted in, when there is one.",
    ),
    text: z
      .string()
      .optional()
      .describe("One short line for the chip's tooltip (at most 160 characters)."),
  }),
);

export const OrchestratorActivitySchema = named(
  "OrchestratorActivity",
  "What the orchestrator is doing: noticed lines, a turn's phase, or idle with the outcome of the turn that just ended.",
  z.looseObject({
    phase: OrchestratorPhaseSchema,
    turnId: IdSchema.optional().describe(
      "The orchestrator chat message that starts this turn (to open it).",
    ),
    trigger: OrchestratorTriggerSchema.optional(),
    startedAt: EpochMsSchema.optional(),
    outcome: OrchestratorOutcomeSchema.optional().describe(
      "Present right after a turn ends (phase `idle`), shown briefly; also while the turn waits for the user's approval (phase `acting`, kind `asked_approval`).",
    ),
  }),
);

export const ThreadSchema = named(
  "Thread",
  "A task's full conversation: messages, artifacts and live surfaces. The orchestrator's own chat is a thread too (see `OrchestratorThreadId`).",
  z.looseObject({
    ...threadBase,
    messages: z.array(ThreadMessageSchema),
    artifacts: z.array(ArtifactMetaSchema),
    sources: z
      .array(CitedSourceSchema)
      .optional()
      .describe(
        "Web pages the thread cites, with what the agent saw of them: clients preview citations from here, never by fetching.",
      ),
  }),
);

export const ThreadSummarySchema = named(
  "ThreadSummary",
  "A thread without its messages, for lists and badges.",
  z.looseObject({
    ...threadBase,
    messageCount: CountSchema,
    lastMessagePreview: z.string().optional(),
    artifactCount: CountSchema,
    pendingApprovals: CountSchema,
  }),
);

// ── Routines ─────────────────────────────────────────────────────────────

export const RoutineNotifySchema = named(
  "RoutineNotify",
  "When a finished run notifies: `always`, `when_changed` (only when it found something new) or `never`. The file spells `when_changed` as `when changed`.",
  z.enum(["always", "when_changed", "never"]),
);

export const RoutineUseSchema = named(
  "RoutineUse",
  "A capability a routine's runs get (its file's `uses`).",
  z.enum(["web", "browser", "computer", "shell", "files", "connectors"]),
);

export const RoutineRunTriggerSchema = named(
  "RoutineRunTrigger",
  "What started a run: its schedule, a slot missed while the Mac slept or the daemon was down (`catch_up`, once however many were missed), or the user (`manual`).",
  z.enum(["schedule", "catch_up", "manual"]),
);

export const RoutineRunSchema = named(
  "RoutineRun",
  "One run of a routine; its thread holds the conversation.",
  z.looseObject({
    threadId: RuntimeIdSchema,
    trigger: RoutineRunTriggerSchema,
    status: TaskAgentStatusSchema,
    startedAt: EpochMsSchema,
    finishedAt: EpochMsSchema.optional(),
    summary: z.string().optional().describe("One line: the run's badge text."),
    changed: z
      .boolean()
      .optional()
      .describe("Whether the run found something new since the previous one."),
  }),
);

export const RoutineSchema = named(
  "Routine",
  "A standing job the agent runs on a schedule: the file `Routines/<name>.md` (schedule, notify, uses and paused in its frontmatter, the instructions as its body) plus the scheduler's state.",
  z.looseObject({
    id: RuntimeIdSchema.describe("Stable id derived from the file's path (`rtn_…`)."),
    path: VaultPathSchema,
    name: z.string().min(1).describe("The file name without `.md`."),
    schedule: z.string().describe("The schedule as written in the file."),
    scheduleText: z
      .string()
      .optional()
      .describe("The schedule in words; absent when it can't be read."),
    notify: RoutineNotifySchema,
    uses: z.array(RoutineUseSchema),
    paused: z.boolean(),
    instructions: z.string(),
    error: z.string().optional().describe("Why the routine can't run."),
    nextRunAt: EpochMsSchema.optional().describe("Absent while paused, invalid or unscheduled."),
    lastRun: RoutineRunSchema.optional(),
    runCount: CountSchema.describe("Runs kept (threads with this `routineId`)."),
    extraRunsLeft: CountSchema.describe("Runs that may still start today beyond the schedule."),
  }),
);

export const RoutineTemplateSchema = named(
  "RoutineTemplate",
  "A starter routine offered by “New routine”.",
  z.looseObject({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string(),
    schedule: z.string().min(1),
    notify: RoutineNotifySchema,
    uses: z.array(RoutineUseSchema),
    instructions: z.string().min(1),
  }),
);

export const RoutineNotificationSchema = named(
  "RoutineNotification",
  "A finished run to tell the user about (sent according to the routine's `notify`).",
  z.looseObject({
    routineId: RuntimeIdSchema,
    title: z.string().describe("The routine's name."),
    body: z.string().describe("The run's result in a line or two."),
    threadId: RuntimeIdSchema,
    status: TaskAgentStatusSchema,
    at: EpochMsSchema,
  }),
);

export const SurfaceFrameActionSchema = named(
  "SurfaceFrameAction",
  "The action that produced a frame, for overlays (x/y in frame pixels).",
  z.looseObject({
    kind: z.string().min(1).max(100),
    x: z.number().optional(),
    y: z.number().optional(),
    text: z.string().optional(),
  }),
);

const FrameSideSchema = z.int().min(1).max(WIRE_LIMITS.frameSide);

export const surfaceFrameShape = {
  threadId: RuntimeIdSchema,
  surface: SurfaceKindSchema,
  mimeType: z.enum(["image/jpeg", "image/png"]),
  data: Base64Schema.describe("Base64-encoded image bytes."),
  width: FrameSideSchema,
  height: FrameSideSchema,
  url: z.string().optional().describe("Browser only."),
  title: z.string().optional().describe("Browser only."),
  action: SurfaceFrameActionSchema.optional(),
  ts: EpochMsSchema,
};

export const SurfaceFrameSchema = named(
  "SurfaceFrame",
  "One frame of a live surface (browser screencast or desktop screenshot).",
  z.looseObject(surfaceFrameShape),
);
