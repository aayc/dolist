/** Agent domain objects: task records, threads and their messages, approvals, artifacts, frames. */
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

export const ThreadSchema = named(
  "Thread",
  "A task's full conversation: messages, artifacts and live surfaces.",
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
