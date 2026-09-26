import type { ServerEvent, TaskAgentStatus, ThreadMessageKind } from "@ddl/core";
import { isRecord } from "@ddl/core";

/**
 * Cheap structural guards for daemon push events (zod stays out of the bundle; the contract's
 * schemas check these guards in tests). They verify what the UI dereferences, switches on or
 * calls string methods on; unknown keys are allowed (newer daemons add fields).
 */
type Check = (value: unknown) => boolean;

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
    isRecord(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

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
  routineId: optional(str),
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
  isRecord(value) &&
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

const orchestratorActivity = shape({
  phase: oneOf("idle", "noticed", "reading", "thinking", "acting"),
  turnId: optional(str),
  trigger: optional(
    shape({
      kind: oneOf("note", "task", "message", "routine", "approval", "other"),
      notePath: optional(str),
      lines: optional(arrayOf(shape({ line: num, text: str }))),
      summary: str,
    }),
  ),
  startedAt: optional(num),
  outcome: optional(
    shape({
      kind: oneOf(
        "no_action",
        "tasks_added",
        "note_edited",
        "replied",
        "delegated",
        "routine_created",
        "asked_approval",
      ),
      count: optional(num),
      threadId: optional(str),
      text: optional(str),
    }),
  ),
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
    computerAccess: optional(
      shape({
        accessibility: bool,
        screenRecording: bool,
        appControl: bool,
        hostApp: optional(shape({ name: str, path: optional(str), bundleId: optional(str) })),
      }),
    ),
  }),
  problem: optional(str),
  placement: optional(
    shape({
      placement: str,
      heldHere: optional(str),
      runsOn: nullable(
        shape({ deviceId: str, name: str, thisDevice: bool, alwaysOnMachine: bool }),
      ),
      relay: str,
      note: optional(str),
    }),
  ),
  readiness: optional(
    shape({
      harness: shape({ kind: str, ready: bool, problem: optional(str) }),
      modelCredential: bool,
      browser: bool,
      computer: str,
      connectors: shape({ configured: num, connected: num }),
    }),
  ),
  orchestrator: optional(orchestratorActivity),
});

const routineRun = shape({
  threadId: str,
  trigger: str,
  status: taskStatus,
  startedAt: num,
  finishedAt: optional(num),
  summary: optional(str),
  changed: optional(bool),
});
const routine = shape({
  id: str,
  path: str,
  name: str,
  schedule: str,
  scheduleText: optional(str),
  notify: str,
  uses: arrayOf(str),
  paused: bool,
  instructions: str,
  error: optional(str),
  nextRunAt: optional(num),
  lastRun: optional(routineRun),
  runCount: num,
  extraRunsLeft: num,
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
    approvalPolicy: optional(str),
  }),
  remote: optional(shape({ alwaysOnMachine: nullable(shape({ name: str, url: str })) })),
});

const count = shape({ count: num });
const importJob = shape({
  id: str,
  kind: oneOf("import", "update"),
  state: oneOf("running", "done", "failed", "cancelled"),
  phase: str,
  source: str,
  destination: str,
  startedAt: num,
  finishedAt: optional(num),
  progress: shape({ files: num, totalFiles: num, bytes: num, totalBytes: num }),
  error: optional(str),
  result: optional(shape({ copied: shape({ files: num, bytes: num }), manifest: str })),
  update: optional(
    shape({ added: count, updated: count, restored: count, conflicts: count, unchanged: num }),
  ),
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
  "orchestrator.activity": shape({ activity: orchestratorActivity }),
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
  "routines.changed": shape({ routines: arrayOf(routine) }),
  "routine.notification": shape({
    notification: shape({
      routineId: str,
      title: str,
      body: str,
      threadId: str,
      status: taskStatus,
      at: num,
    }),
  }),
  "import.progress": shape({ job: importJob }),
};

/** Validates the shape of a daemon push event; unknown or malformed events are dropped. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !Object.hasOwn(validators, raw.type)) {
    return null;
  }
  const validate = validators[raw.type as ServerEvent["type"]];
  return validate(raw) ? (raw as unknown as ServerEvent) : null;
}
