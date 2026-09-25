/**
 * WebSocket messages. Server events tolerate unknown keys (a newer daemon may add fields), and
 * clients ignore event types they don't know. Client events are strict.
 */
import { z } from "zod";
import {
  ApprovalRequestSchema,
  RoutineNotificationSchema,
  RoutineSchema,
  SurfaceKindSchema,
  surfaceFrameShape,
  TaskAgentRecordSchema,
  ThreadMessageSchema,
  ThreadSummarySchema,
} from "./domain";
import { ObsidianImportJobSchema } from "./imports";
import {
  ClientIdSchema,
  ContentVersionSchema,
  CountSchema,
  IdSchema,
  RequestPathSchema,
  RuntimeIdSchema,
  VaultPathSchema,
} from "./primitives";
import { named } from "./registry";
import { AgentStatusResponseSchema } from "./rest";
import { AppSettingsSchema } from "./settings";

export const VaultChangeOriginSchema = named(
  "VaultChangeOrigin",
  "Who changed the vault: another program, a client (see `clientId`), the agent, or sync.",
  z.enum(["external", "client", "agent", "sync"]),
);

export const VaultChangeSchema = named(
  "VaultChange",
  "One changed path.",
  z.looseObject({
    path: VaultPathSchema,
    kind: z.enum(["created", "modified", "deleted"]),
    version: ContentVersionSchema.optional(),
  }),
);

export const WsErrorCodeSchema = named(
  "WsErrorCode",
  "Machine-readable reason of a server `error` event.",
  z.enum([
    "invalid_json",
    "invalid_message",
    "binary_unsupported",
    "too_many_subscriptions",
    "subscribe_failed",
    "incompatible_api_version",
  ]),
);

// ── Server → client ──────────────────────────────────────────────────────

export const ServerHelloEventSchema = named(
  "ServerHelloEvent",
  "First event on every connection.",
  z.looseObject({
    type: z.literal("hello"),
    serverVersion: z.string().min(1).max(100),
    apiVersion: z.int().min(1),
  }),
);

export const VaultChangedEventSchema = named(
  "VaultChangedEvent",
  "Vault paths changed (coalesced). Clients skip batches carrying their own `clientId`.",
  z.looseObject({
    type: z.literal("vault.changed"),
    changes: z.array(VaultChangeSchema),
    origin: VaultChangeOriginSchema,
    clientId: ClientIdSchema.optional(),
  }),
);

export const TaskRecordsEventSchema = named(
  "TaskRecordsEvent",
  "Snapshot of a note's task records.",
  z.looseObject({
    type: z.literal("task.records"),
    notePath: VaultPathSchema,
    records: z.array(TaskAgentRecordSchema),
  }),
);

export const TaskRecordEventSchema = named(
  "TaskRecordEvent",
  "One task record changed.",
  z.looseObject({ type: z.literal("task.record"), record: TaskAgentRecordSchema }),
);

export const ThreadUpsertEventSchema = named(
  "ThreadUpsertEvent",
  "A thread was created or its summary changed.",
  z.looseObject({ type: z.literal("thread.upsert"), thread: ThreadSummarySchema }),
);

export const ThreadMessageEventSchema = named(
  "ThreadMessageEvent",
  "A message was added or replaced (same `id`) in a thread.",
  z.looseObject({
    type: z.literal("thread.message"),
    threadId: RuntimeIdSchema,
    message: ThreadMessageSchema,
  }),
);

export const ThreadDeltaEventSchema = named(
  "ThreadDeltaEvent",
  "Streaming text appended to a `streaming` text message (droppable; the final message repairs gaps).",
  z.looseObject({
    type: z.literal("thread.delta"),
    threadId: RuntimeIdSchema,
    messageId: IdSchema,
    delta: z.string(),
  }),
);

export const ApprovalUpsertEventSchema = named(
  "ApprovalUpsertEvent",
  "An approval request was created or decided.",
  z.looseObject({ type: z.literal("approval.upsert"), approval: ApprovalRequestSchema }),
);

export const AgentStatusEventSchema = named(
  "AgentStatusEvent",
  "The agent status changed.",
  z.looseObject({ type: z.literal("agent.status"), status: AgentStatusResponseSchema }),
);

export const SurfaceFrameEventSchema = named(
  "SurfaceFrameEvent",
  "A live surface frame; only sent to clients subscribed to that thread's surface (droppable).",
  z.looseObject({ type: z.literal("surface.frame"), ...surfaceFrameShape }),
);

export const SettingsChangedEventSchema = named(
  "SettingsChangedEvent",
  "The effective settings changed.",
  z.looseObject({ type: z.literal("settings.changed"), settings: AppSettingsSchema }),
);

export const RoutinesChangedEventSchema = named(
  "RoutinesChangedEvent",
  "Every routine, whenever one changed (its file, its schedule, its last run).",
  z.looseObject({ type: z.literal("routines.changed"), routines: z.array(RoutineSchema) }),
);

export const RoutineNotificationEventSchema = named(
  "RoutineNotificationEvent",
  "A routine's run finished and its `notify` says to tell the user (clients show a notification).",
  z.looseObject({
    type: z.literal("routine.notification"),
    notification: RoutineNotificationSchema,
  }),
);

export const ImportProgressEventSchema = named(
  "ImportProgressEvent",
  "An import or update from Obsidian progressed (at most every 200 ms), changed phase, or ended (`job.state`).",
  z.looseObject({ type: z.literal("import.progress"), job: ObsidianImportJobSchema }),
);

export const ServerErrorEventSchema = named(
  "ServerErrorEvent",
  "Something the client sent was rejected (or the connection is about to close).",
  z.looseObject({
    type: z.literal("error"),
    message: z.string(),
    code: WsErrorCodeSchema.optional(),
  }),
);

export const ServerEventSchema = named(
  "ServerEvent",
  "Every server → client WebSocket message, discriminated by `type`.",
  z.discriminatedUnion("type", [
    ServerHelloEventSchema,
    VaultChangedEventSchema,
    TaskRecordsEventSchema,
    TaskRecordEventSchema,
    ThreadUpsertEventSchema,
    ThreadMessageEventSchema,
    ThreadDeltaEventSchema,
    ApprovalUpsertEventSchema,
    AgentStatusEventSchema,
    SurfaceFrameEventSchema,
    SettingsChangedEventSchema,
    RoutinesChangedEventSchema,
    RoutineNotificationEventSchema,
    ImportProgressEventSchema,
    ServerErrorEventSchema,
  ]),
);

// ── Client → server ──────────────────────────────────────────────────────

export const ClientHelloEventSchema = named(
  "ClientHelloEvent",
  "First message a client sends: its id and the API version it speaks.",
  z.strictObject({
    type: z.literal("hello"),
    clientId: ClientIdSchema,
    apiVersion: z
      .int()
      .min(1)
      .optional()
      .describe("API_VERSION the client was built against; absent = 1 (legacy clients)."),
    clientVersion: z.string().min(1).max(100).optional().describe("e.g. `web/0.1.0`."),
  }),
);

export const ClientPingEventSchema = named(
  "ClientPingEvent",
  "Keep-alive.",
  z.strictObject({ type: z.literal("ping") }),
);

export const SurfaceSubscribeEventSchema = named(
  "SurfaceSubscribeEvent",
  "Start receiving `surface.frame` events for a thread's surface.",
  z.strictObject({
    type: z.literal("surface.subscribe"),
    threadId: IdSchema,
    surface: SurfaceKindSchema,
  }),
);

export const SurfaceUnsubscribeEventSchema = named(
  "SurfaceUnsubscribeEvent",
  "Stop receiving frames for a thread's surface.",
  z.strictObject({
    type: z.literal("surface.unsubscribe"),
    threadId: IdSchema,
    surface: SurfaceKindSchema,
  }),
);

export const ThreadReadEventSchema = named(
  "ThreadReadEvent",
  "The user has seen a thread (clears its unread count).",
  z.strictObject({ type: z.literal("thread.read"), threadId: IdSchema }),
);

export const EditorActivityEventSchema = named(
  "EditorActivityEvent",
  "Where the user is typing, so the orchestrator never jumps on a half-written task.",
  z.strictObject({
    type: z.literal("editor.activity"),
    notePath: RequestPathSchema,
    line: CountSchema,
  }),
);

export const ClientEventSchema = named(
  "ClientEvent",
  "Every client → server WebSocket message, discriminated by `type`.",
  z.discriminatedUnion("type", [
    ClientHelloEventSchema,
    ClientPingEventSchema,
    SurfaceSubscribeEventSchema,
    SurfaceUnsubscribeEventSchema,
    ThreadReadEventSchema,
    EditorActivityEventSchema,
  ]),
);

export const SERVER_EVENT_TYPES = ServerEventSchema.options.map(
  (option) => option.shape.type.value,
);
export const CLIENT_EVENT_TYPES = ClientEventSchema.options.map(
  (option) => option.shape.type.value,
);
