import type { ServerEvent, TaskAgentStatus, ThreadMessageKind } from "@ddl/core";

/**
 * Cheap structural guards for daemon push events (zod stays out of the bundle; the contract's
 * schemas check these guards in tests). They verify what the UI dereferences, switches on or
 * calls string methods on; unknown keys are allowed (newer daemons add fields).
 */
type Check = (value: unknown) => boolean;
type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str: Check = (value) => typeof value === "string";
const num: Check = (value) => typeof value === "number" && Number.isFinite(value);
const bool: Check = (value) => typeof value === "boolean";
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const oneOf =
  (...values: readonly string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const arrayOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    isObject(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

const TASK_STATUSES: readonly TaskAgentStatus[] = [
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
];
const taskStatus = oneOf(...TASK_STATUSES);
const surfaceKind = oneOf("browser", "computer");

const record = shape({
  taskId: str,
  notePath: str,
  date: nullable(str),
  text: str,
  line: num,
  status: taskStatus,
  summary: optional(str),
  threadId: nullable(str),
  updatedAt: num,
  unread: num,
});

const threadSummary = shape({
  id: str,
  taskId: nullable(str),
  notePath: nullable(str),
  title: str,
  status: taskStatus,
  createdAt: num,
  updatedAt: num,
  messageCount: num,
  lastMessagePreview: optional(str),
  artifactCount: num,
  surfaces: arrayOf(surfaceKind),
  pendingApprovals: num,
});

const messageBase = { id: str, author: str, createdAt: num };
const messageKinds: Record<ThreadMessageKind, Check> = {
  text: shape({ ...messageBase, role: str, text: str, streaming: optional(bool) }),
  tool_call: shape({
    ...messageBase,
    toolCallId: str,
    toolName: str,
    label: optional(str),
    status: oneOf("running", "ok", "error", "blocked"),
    resultPreview: optional(str),
    endedAt: optional(num),
  }),
  approval: shape({ ...messageBase, approvalId: str }),
  artifact: shape({ ...messageBase, artifactId: str }),
  status: shape({ ...messageBase, status: taskStatus, text: optional(str) }),
};
const message: Check = (value) =>
  isObject(value) &&
  typeof value.kind === "string" &&
  Object.hasOwn(messageKinds, value.kind) &&
  messageKinds[value.kind as ThreadMessageKind](value);

const approval = shape({
  id: str,
  threadId: nullable(str),
  taskId: nullable(str),
  toolName: str,
  toolLabel: optional(str),
  summary: str,
  risk: str,
  categories: arrayOf(str),
  reason: str,
  status: oneOf("pending", "approved", "denied", "expired", "cancelled"),
  scope: optional(str),
  decisionNote: optional(str),
  createdAt: num,
  decidedAt: optional(num),
  expiresAt: optional(num),
});

const agentStatus = shape({
  mode: str,
  enabled: bool,
  model: str,
  running: num,
  queued: num,
  pendingApprovals: num,
  connectors: arrayOf(shape({ name: str, transport: str, state: str, toolCount: num })),
  execution: shape({
    provider: str,
    capabilities: shape({ shell: bool, browser: bool, computer: bool }),
  }),
  problem: optional(str),
});

const periodicNotes = shape({ folder: str, format: str, template: str });
const settings = shape({
  theme: str,
  editor: shape({
    vimMode: bool,
    vimrc: optional(str),
    livePreview: bool,
    readableLineLength: bool,
    fontSize: num,
    spellcheck: bool,
    showLineNumbers: bool,
  }),
  dailyNotes: periodicNotes,
  weeklyNotes: periodicNotes,
  agent: shape({
    enabled: bool,
    settleMs: num,
    maxConcurrentSubagents: num,
    harness: optional(str),
    model: str,
    cursorModel: optional(str),
    judgeModel: str,
    watch: shape({ pastDays: num, futureDays: num }),
    actOnExistingTasks: bool,
    approvalTimeoutMs: num,
  }),
});

const validators: Record<ServerEvent["type"], Check> = {
  hello: shape({ serverVersion: str, apiVersion: num }),
  error: shape({ message: str, code: optional(str) }),
  "vault.changed": shape({
    changes: arrayOf(
      shape({ path: str, kind: oneOf("created", "modified", "deleted"), version: optional(str) }),
    ),
    origin: str,
    clientId: optional(str),
  }),
  "task.records": shape({ notePath: str, records: arrayOf(record) }),
  "task.record": shape({ record }),
  "thread.upsert": shape({ thread: threadSummary }),
  "thread.message": shape({ threadId: str, message }),
  "thread.delta": shape({ threadId: str, messageId: str, delta: str }),
  "approval.upsert": shape({ approval }),
  "agent.status": shape({ status: agentStatus }),
  "surface.frame": shape({
    threadId: str,
    surface: surfaceKind,
    mimeType: str,
    data: str,
    width: num,
    height: num,
    url: optional(str),
    title: optional(str),
    action: optional(shape({ kind: str, x: optional(num), y: optional(num), text: optional(str) })),
    ts: num,
  }),
  "settings.changed": shape({ settings }),
};

/** Validates the shape of a daemon push event; unknown or malformed events are dropped. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  if (!isObject(raw) || typeof raw.type !== "string" || !Object.hasOwn(validators, raw.type)) {
    return null;
  }
  const validate = validators[raw.type as ServerEvent["type"]];
  return validate(raw) ? (raw as unknown as ServerEvent) : null;
}
