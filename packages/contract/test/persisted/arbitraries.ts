/**
 * fast-check arbitraries for valid in-memory state of every persisted format. Shared with the
 * owner modules' property tests (packages/agent/test/persistence, apps/daemon settings tests).
 */
import { fc } from "@fast-check/vitest";
import type {
  PersistedApprovalGrant,
  PersistedApprovalRequest,
  PersistedApprovals,
  PersistedArtifactMeta,
  PersistedRecords,
  PersistedSettingsOverrides,
  PersistedSubagentSpec,
  PersistedTaskAgentRecord,
  PersistedTaskState,
  PersistedThread,
  PersistedThreadMessage,
  PersistedTrackedTask,
} from "../../src/persisted";

/** Any code points, including lone surrogates, emoji and RTL text. */
export const anyText = (maxLength = 24) => fc.string({ unit: "binary", maxLength });
export const nonEmptyText = (maxLength = 16) =>
  fc.string({ unit: "binary", minLength: 1, maxLength });
export const fileId = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,20}$/);
/** JSON-exact numbers: integers and finite doubles (never -0, which JSON turns into 0). */
export const timestamp = fc.oneof(
  fc.integer({ min: 0, max: 4_102_444_800_000 }),
  fc
    .double({ min: -1e15, max: 1e15, noNaN: true, noDefaultInfinity: true })
    .map((n) => (Object.is(n, -0) ? 0 : n)),
);
export const count = fc.nat({ max: 1_000_000 });
export const isoDate = fc
  .date({
    min: new Date("1970-01-01T00:00:00Z"),
    max: new Date("2999-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
/** A JSON value as it comes back from JSON.parse (so structural equality holds after a round trip). */
export const jsonInput = fc
  .jsonValue({ maxDepth: 3 })
  .map((v) => JSON.parse(JSON.stringify(v)) as unknown);

const agentStatus = fc.constantFrom(
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
) satisfies fc.Arbitrary<PersistedThread["status"]>;
const author = fc.oneof(
  fc.constantFrom("you", "orchestrator", "system"),
  anyText(12).map((s) => `subagent:${s}`),
) as fc.Arbitrary<PersistedThreadMessage["author"]>;
const categories = fc.uniqueArray(
  fc.constantFrom(
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
  ),
  { maxLength: 4 },
) satisfies fc.Arbitrary<PersistedApprovalGrant["categories"] & {}>;
const risk = fc.constantFrom("low", "medium", "high", "critical") satisfies fc.Arbitrary<
  PersistedApprovalRequest["risk"]
>;

/** Omits optional keys that are undefined so objects compare like their JSON round trip. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function messageArb(
  id: fc.Arbitrary<string> = nonEmptyText(),
): fc.Arbitrary<PersistedThreadMessage> {
  const base = { id, author, createdAt: timestamp };
  return fc.oneof(
    fc
      .record({
        ...base,
        kind: fc.constant("text" as const),
        role: fc.constantFrom("agent" as const, "user" as const, "system" as const),
        text: anyText(80),
        streaming: fc.option(fc.constant(false), { nil: undefined }),
      })
      .map(compact),
    fc
      .record({
        ...base,
        kind: fc.constant("tool_call" as const),
        toolCallId: anyText(12),
        toolName: anyText(12),
        label: fc.option(anyText(), { nil: undefined }),
        input: fc.option(jsonInput, { nil: undefined }),
        status: fc.constantFrom(
          "running" as const,
          "ok" as const,
          "error" as const,
          "blocked" as const,
        ),
        resultPreview: fc.option(anyText(40), { nil: undefined }),
        endedAt: fc.option(timestamp, { nil: undefined }),
      })
      .map((m) => ({ ...compact(m), input: m.input })),
    fc.record({ ...base, kind: fc.constant("approval" as const), approvalId: anyText(12) }),
    fc.record({ ...base, kind: fc.constant("artifact" as const), artifactId: anyText(12) }),
    fc
      .record({
        ...base,
        kind: fc.constant("status" as const),
        status: agentStatus,
        text: fc.option(anyText(), { nil: undefined }),
      })
      .map(compact),
  );
}

export function artifactArb(threadId: string): fc.Arbitrary<PersistedArtifactMeta> {
  return fc
    .record({
      id: fileId,
      threadId: fc.constant(threadId),
      title: anyText(),
      kind: fc.constantFrom(
        "markdown",
        "code",
        "html",
        "image",
        "json",
        "text",
        "file",
      ) as fc.Arbitrary<PersistedArtifactMeta["kind"]>,
      mimeType: anyText(20),
      language: fc.option(anyText(8), { nil: undefined }),
      ext: fc.constantFrom("md", "txt", "png.b64", "bin.b64", "json"),
      size: count,
      createdAt: timestamp,
    })
    .map(({ ext, ...meta }) =>
      compact({ ...meta, path: `.daily-do-list/artifacts/${threadId}/${meta.id}.${ext}` }),
    );
}

export const threadArb: fc.Arbitrary<PersistedThread> = fileId.chain((id) =>
  fc.record({
    id: fc.constant(id),
    taskId: fc.option(nonEmptyText(), { nil: null }),
    notePath: fc.option(anyText(30), { nil: null }),
    title: anyText(60),
    status: agentStatus,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: fc.uniqueArray(messageArb(), { maxLength: 12, selector: (m) => m.id }),
    artifacts: fc.uniqueArray(artifactArb(id), { maxLength: 4, selector: (a) => a.id }),
    surfaces: fc.uniqueArray(fc.constantFrom("browser" as const, "computer" as const), {
      maxLength: 2,
    }),
  }),
);

export const recordArb = (taskId: fc.Arbitrary<string> = nonEmptyText()) =>
  fc
    .record({
      taskId,
      notePath: nonEmptyText(30),
      date: fc.option(isoDate, { nil: null }),
      text: anyText(60),
      line: count,
      status: agentStatus,
      summary: fc.option(anyText(40), { nil: undefined }),
      threadId: fc.option(nonEmptyText(), { nil: null }),
      updatedAt: timestamp,
      unread: fc.nat({ max: 50 }),
    })
    .map(compact) satisfies fc.Arbitrary<PersistedTaskAgentRecord>;

const capabilities = fc.uniqueArray(
  fc.constantFrom("web", "browser", "computer", "shell", "files", "connectors"),
  { maxLength: 6 },
) satisfies fc.Arbitrary<PersistedSubagentSpec["capabilities"]>;

export const specArb = (taskId: string): fc.Arbitrary<PersistedSubagentSpec> =>
  fc
    .record({
      taskId: fc.constant(taskId),
      goal: anyText(60),
      instructions: fc.option(anyText(60), { nil: undefined }),
      capabilities,
    })
    .map(compact);

/** Task ids are plain identifiers here: they also serve as object keys in `specs`. */
export const recordsArb: fc.Arbitrary<PersistedRecords> = fc
  .uniqueArray(recordArb(fileId), { maxLength: 8, selector: (r) => r.taskId })
  .chain((records) =>
    fc
      .subarray(records.map((r) => r.taskId))
      .chain((ids) => fc.tuple(...ids.map((taskId) => specArb(taskId))))
      .map((specs) => ({
        records,
        specs: Object.fromEntries(specs.map((spec) => [spec.taskId, spec])),
      })),
  );

export const grantArb: fc.Arbitrary<PersistedApprovalGrant> = fc
  .record({
    toolName: nonEmptyText(20),
    scope: fc.constantFrom("task" as const, "always" as const),
    taskId: nonEmptyText(),
    createdAt: timestamp,
    categories: fc.option(categories, { nil: undefined }),
    risk: fc.option(risk, { nil: undefined }),
    target: fc.option(nonEmptyText(40), { nil: undefined }),
  })
  .map((grant) => compact({ ...grant, taskId: grant.scope === "task" ? grant.taskId : null }));

export const approvalArb = (
  id: fc.Arbitrary<string> = nonEmptyText(),
): fc.Arbitrary<PersistedApprovalRequest> =>
  fc
    .record({
      id,
      threadId: fc.option(nonEmptyText(), { nil: null }),
      taskId: fc.option(nonEmptyText(), { nil: null }),
      toolName: anyText(20),
      toolLabel: fc.option(anyText(20), { nil: undefined }),
      input: fc.option(jsonInput, { nil: undefined }),
      summary: anyText(60),
      risk,
      categories,
      reason: anyText(60),
      status: fc.constantFrom(
        "pending",
        "approved",
        "denied",
        "expired",
        "cancelled",
      ) as fc.Arbitrary<PersistedApprovalRequest["status"]>,
      scope: fc.option(fc.constantFrom("once" as const, "task" as const, "always" as const), {
        nil: undefined,
      }),
      decisionNote: fc.option(anyText(40), { nil: undefined }),
      createdAt: timestamp,
      decidedAt: fc.option(timestamp, { nil: undefined }),
      expiresAt: fc.option(timestamp, { nil: undefined }),
    })
    .map((a) => ({ ...compact(a), input: a.input }));

export const approvalsArb: fc.Arbitrary<PersistedApprovals> = fc.record({
  grants: fc.array(grantArb, { maxLength: 5 }),
  approvals: fc.uniqueArray(approvalArb(), { maxLength: 6, selector: (a) => a.id }),
});

export const trackedTaskArb = (
  id: fc.Arbitrary<string> = fileId,
): fc.Arbitrary<PersistedTrackedTask> =>
  fc.record({
    id,
    text: anyText(60),
    status: fc.constantFrom(
      "open",
      "done",
      "in_progress",
      "cancelled",
      "deferred",
      "other",
    ) as fc.Arbitrary<PersistedTrackedTask["status"]>,
    line: count,
    depth: fc.nat({ max: 8 }),
    parentId: fc.option(fileId, { nil: null }),
    notes: fc.array(anyText(30), { maxLength: 3 }),
    firstSeenAt: timestamp,
    updatedAt: timestamp,
  });

export const taskStateArb = (
  notePath: fc.Arbitrary<string> = nonEmptyText(30),
): fc.Arbitrary<PersistedTaskState> =>
  fc
    .record({
      notePath,
      contentVersion: fc.option(anyText(16), { nil: null }),
      tasks: fc.uniqueArray(trackedTaskArb(), { maxLength: 8, selector: (t) => t.id }),
      settledTasks: fc.uniqueArray(fc.record({ task: trackedTaskArb(), announced: fc.boolean() }), {
        maxLength: 6,
        selector: (s) => s.task.id,
      }),
    })
    .map(({ settledTasks, ...state }) => ({
      ...state,
      settled: Object.fromEntries(settledTasks.map((snapshot) => [snapshot.task.id, snapshot])),
    }));

const periodic = fc.record(
  {
    folder: fc.string({ maxLength: 20 }),
    format: fc.string({ maxLength: 20 }),
    template: fc.string({ maxLength: 20 }),
  },
  { requiredKeys: [] },
);

/** Valid overrides with every key optional at every level. */
export const settingsOverridesArb: fc.Arbitrary<PersistedSettingsOverrides> = fc.record(
  {
    theme: fc.constantFrom("system" as const, "light" as const, "dark" as const),
    editor: fc.record(
      {
        vimMode: fc.boolean(),
        vimrc: fc.string({ maxLength: 200 }),
        livePreview: fc.boolean(),
        readableLineLength: fc.boolean(),
        fontSize: fc.integer({ min: 8, max: 48 }),
        spellcheck: fc.boolean(),
        showLineNumbers: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    dailyNotes: periodic,
    weeklyNotes: periodic,
    agent: fc.record(
      {
        enabled: fc.boolean(),
        settleMs: fc.integer({ min: 0, max: 120_000 }),
        maxConcurrentSubagents: fc.integer({ min: 1, max: 32 }),
        harness: fc.constantFrom("pi" as const, "cursor" as const),
        model: fc.stringMatching(/^[a-z0-9]{1,12}\/[a-z0-9.-]{1,20}$/),
        cursorModel: fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,20}(\[[a-z]{1,10}=[a-z]{1,10}\])?$/),
        judgeModel: fc.stringMatching(/^[a-z0-9]{1,12}\/[a-z0-9.-]{1,20}$/),
        watch: fc.record(
          {
            pastDays: fc.integer({ min: 0, max: 366 }),
            futureDays: fc.integer({ min: 0, max: 366 }),
          },
          { requiredKeys: [] },
        ),
        actOnExistingTasks: fc.boolean(),
        approvalTimeoutMs: fc.integer({ min: 60_000, max: 30 * 24 * 60 * 60 * 1000 }),
        approvalPolicy: fc.constantFrom(
          "ask_every_action" as const,
          "ask_risky" as const,
          "ask_high_risk" as const,
          "run_everything" as const,
        ),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);
