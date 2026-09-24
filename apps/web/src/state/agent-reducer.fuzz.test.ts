import type {
  AgentStatusResponse,
  ApprovalRequest,
  ServerEvent,
  TaskAgentRecord,
  TaskAgentStatus,
  Thread,
  ThreadMessage,
  ThreadSummary,
} from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  type AgentState,
  applyApprovalList,
  applyRecordsSnapshot,
  applyThreadList,
  applyThreadResponse,
  countPendingApprovals,
  findRecordIn,
  initialAgentState,
  reduceAgentEvent,
} from "./agent-reducer";

// A small universe of related ids, so random events keep hitting the same entities.
const NOTES = ["Daily/2026-09-23.md", "Daily/2026-09-22.md", "Projects/Garden.md"] as const;
const TASKS = ["tsk_k3j9x0q2m1aa", "tsk_k3j9x0q2m1ab", "tsk_k3j9x0q2m1ac", "tsk_k3j9x0q2m1ad"];
const THREADS = ["thr_p0q1r2s3t4aa", "thr_p0q1r2s3t4ab", "thr_p0q1r2s3t4ac"];
const UNKNOWN_THREAD = "thr_zzzzzzzzzzzz";
const APPROVALS = ["apr_m5n6o7p8q9aa", "apr_m5n6o7p8q9ab", "apr_m5n6o7p8q9ac"];
const STATUSES: readonly TaskAgentStatus[] = [
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

const note = fc.constantFrom(...NOTES);
const taskId = fc.constantFrom(...TASKS);
const threadId = fc.constantFrom(...THREADS);
const anyThreadId = fc.constantFrom(...THREADS, UNKNOWN_THREAD);
const status = fc.constantFrom(...STATUSES);
/** Few distinct timestamps: collisions and out-of-order updates are common. */
const time = fc.integer({ min: 1, max: 12 });
const messageId = (thread: string, n: number) => `msg_${thread.slice(4, 10)}_${n}`;
const anyMessageId = fc.oneof(
  fc.tuple(anyThreadId, fc.integer({ min: 0, max: 3 })).map(([t, n]) => messageId(t, n)),
  fc.constant("msg_unknown"),
);

const record = (notePath: fc.Arbitrary<string> = note): fc.Arbitrary<TaskAgentRecord> =>
  fc.record({
    taskId,
    notePath,
    date: fc.constant("2026-09-23"),
    text: fc.constantFrom("Buy milk", "Book a table", "Compare vacuums"),
    line: fc.nat({ max: 20 }),
    status,
    threadId: fc.option(threadId, { nil: null }),
    updatedAt: time,
    unread: fc.nat({ max: 5 }),
  });

const textMessage = (thread: string): fc.Arbitrary<ThreadMessage> =>
  fc.record({
    id: fc.integer({ min: 0, max: 3 }).map((n) => messageId(thread, n)),
    kind: fc.constant("text" as const),
    role: fc.constantFrom("agent" as const, "user" as const),
    author: fc.constantFrom("orchestrator" as const, "you" as const),
    createdAt: time,
    text: fc.constantFrom("", "Looking", "Looking for options…"),
    streaming: fc.boolean(),
  });

const otherMessage = (thread: string): fc.Arbitrary<ThreadMessage> =>
  fc.integer({ min: 0, max: 3 }).chain((n) =>
    fc.oneof(
      fc.constant<ThreadMessage>({
        id: messageId(thread, n),
        kind: "tool_call",
        author: "subagent:research",
        createdAt: 1,
        toolCallId: `call_${n}`,
        toolName: "web_search",
        input: { query: "x" },
        status: "running",
      }),
      fc.constant<ThreadMessage>({
        id: messageId(thread, n),
        kind: "status",
        author: "system",
        createdAt: 1,
        status: "working",
      }),
      fc.constant<ThreadMessage>({
        id: messageId(thread, n),
        kind: "approval",
        author: "system",
        createdAt: 1,
        approvalId: APPROVALS[0]!,
      }),
    ),
  );

const message = (thread: string) =>
  fc.oneof(
    { weight: 3, arbitrary: textMessage(thread) },
    { weight: 1, arbitrary: otherMessage(thread) },
  );

const summary: fc.Arbitrary<ThreadSummary> = threadId.chain((id) =>
  fc.record({
    id: fc.constant(id),
    taskId: fc.option(taskId, { nil: null }),
    notePath: fc.option(note, { nil: null }),
    title: fc.constantFrom("Buy milk", "Buy oat milk"),
    status,
    createdAt: fc.constant(1),
    updatedAt: time,
    messageCount: fc.nat({ max: 4 }),
    artifactCount: fc.nat({ max: 2 }),
    surfaces: fc.subarray(["browser", "computer"] as const),
    pendingApprovals: fc.nat({ max: 2 }),
  }),
);

const approval: fc.Arbitrary<ApprovalRequest> = fc.record({
  id: fc.constantFrom(...APPROVALS),
  threadId: fc.option(anyThreadId, { nil: null }),
  taskId: fc.option(taskId, { nil: null }),
  toolName: fc.constant("browser_click"),
  input: fc.constant({ element: "Place order" }),
  summary: fc.constant("Place order"),
  risk: fc.constantFrom("low" as const, "high" as const),
  categories: fc.constant(["payment" as const]),
  reason: fc.constant("Spends money"),
  status: fc.constantFrom(
    "pending" as const,
    "approved" as const,
    "denied" as const,
    "expired" as const,
  ),
  createdAt: time,
});

const agentStatus: fc.Arbitrary<AgentStatusResponse> = fc.record({
  mode: fc.constant("mock" as const),
  enabled: fc.boolean(),
  model: fc.constant("mock/scripted-agent"),
  running: fc.nat({ max: 3 }),
  queued: fc.nat({ max: 3 }),
  pendingApprovals: fc.nat({ max: 3 }),
  connectors: fc.constant([]),
  execution: fc.constant({
    provider: "mock",
    capabilities: { shell: false, browser: true, computer: true },
  }),
});

/** Records of one note as a snapshot (unique task ids, all in that note). */
const snapshot = note.chain((notePath) =>
  fc.tuple(
    fc.constant(notePath),
    fc.uniqueArray(record(fc.constant(notePath)), { selector: (r) => r.taskId, maxLength: 4 }),
  ),
);

const agentEvent: fc.Arbitrary<ServerEvent> = fc.oneof(
  { weight: 4, arbitrary: record().map((r) => ({ type: "task.record" as const, record: r })) },
  {
    weight: 1,
    arbitrary: snapshot.map(([notePath, records]) => ({
      type: "task.records" as const,
      notePath,
      records,
    })),
  },
  { weight: 3, arbitrary: summary.map((thread) => ({ type: "thread.upsert" as const, thread })) },
  {
    weight: 4,
    arbitrary: anyThreadId.chain((id) =>
      message(id === UNKNOWN_THREAD ? THREADS[0]! : id).map((m) => ({
        type: "thread.message" as const,
        threadId: id,
        message: m,
      })),
    ),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      type: fc.constant("thread.delta" as const),
      threadId: anyThreadId,
      messageId: anyMessageId,
      delta: fc.constantFrom(" more", "…", "😀"),
    }),
  },
  {
    weight: 2,
    arbitrary: approval.map((a) => ({ type: "approval.upsert" as const, approval: a })),
  },
  { weight: 1, arbitrary: agentStatus.map((s) => ({ type: "agent.status" as const, status: s })) },
);

const otherEvent: fc.Arbitrary<ServerEvent> = fc.constantFrom<ServerEvent>(
  { type: "hello", serverVersion: "1", apiVersion: 1 },
  { type: "vault.changed", changes: [{ path: NOTES[0], kind: "modified" }], origin: "external" },
  { type: "error", message: "boom" },
  {
    type: "surface.frame",
    threadId: THREADS[0]!,
    surface: "browser",
    mimeType: "image/jpeg",
    data: "",
    width: 1,
    height: 1,
    ts: 1,
  },
);

const loadedThread: fc.Arbitrary<Thread> = threadId.chain((id) =>
  fc.record({
    id: fc.constant(id),
    taskId: fc.option(taskId, { nil: null }),
    notePath: fc.option(note, { nil: null }),
    title: fc.constantFrom("Buy milk", "Buy oat milk"),
    status,
    createdAt: fc.constant(1),
    updatedAt: time,
    messages: fc.uniqueArray(message(id), { selector: (m) => m.id, maxLength: 4 }),
    artifacts: fc.constant([]),
    surfaces: fc.subarray(["browser", "computer"] as const),
  }),
);

type Op =
  | { kind: "event"; event: ServerEvent }
  | { kind: "other"; event: ServerEvent }
  | { kind: "replay"; index: number }
  | { kind: "threadResponse"; thread: Thread; approvals: ApprovalRequest[] }
  | { kind: "threadList"; threads: ThreadSummary[] }
  | { kind: "approvalList"; approvals: ApprovalRequest[] }
  | { kind: "recordsSnapshot"; notePath: string; records: TaskAgentRecord[] };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 12, arbitrary: agentEvent.map((event) => ({ kind: "event" as const, event })) },
  { weight: 1, arbitrary: otherEvent.map((event) => ({ kind: "other" as const, event })) },
  { weight: 2, arbitrary: fc.nat().map((index) => ({ kind: "replay" as const, index })) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("threadResponse" as const),
      thread: loadedThread,
      approvals: fc.uniqueArray(approval, { selector: (a) => a.id, maxLength: 2 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("threadList" as const),
      threads: fc.uniqueArray(summary, { selector: (s) => s.id, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("approvalList" as const),
      approvals: fc.uniqueArray(approval, { selector: (a) => a.id, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: snapshot.map(([notePath, records]) => ({
      kind: "recordsSnapshot" as const,
      notePath,
      records,
    })),
  },
);

function applyOp(state: AgentState, o: Op, history: readonly ServerEvent[]): AgentState {
  switch (o.kind) {
    case "event":
    case "other":
      return reduceAgentEvent(state, o.event);
    case "replay":
      return history.length === 0
        ? state
        : reduceAgentEvent(state, history[o.index % history.length]!);
    case "threadResponse":
      return applyThreadResponse(state, { thread: o.thread, approvals: o.approvals });
    case "threadList":
      return applyThreadList(state, o.threads);
    case "approvalList":
      return applyApprovalList(state, o.approvals);
    case "recordsSnapshot":
      return applyRecordsSnapshot(state, o.notePath, o.records);
  }
}

function findMessage(state: AgentState, thread: string, id: string): ThreadMessage | undefined {
  return state.details[thread]?.messages.find((m) => m.id === id);
}

/** Invariants that hold after every step, whatever was delivered in whatever order. */
function expectConsistent(state: AgentState): void {
  const bucketsOfTask = new Map<string, string[]>();
  for (const [notePath, bucket] of Object.entries(state.records)) {
    for (const [id, r] of Object.entries(bucket)) {
      expect(r.taskId, "record keyed by its task id").toBe(id);
      expect(r.notePath, "record stored under its note").toBe(notePath);
      expect(r.unread).toBeGreaterThanOrEqual(0);
      bucketsOfTask.set(id, [...(bucketsOfTask.get(id) ?? []), notePath]);
    }
  }
  for (const [id, notes] of bucketsOfTask) {
    expect(notes.length, `task ${id} lives in one note only (${notes.join(", ")})`).toBe(1);
  }
  for (const [id, thread] of Object.entries(state.threads)) expect(thread.id).toBe(id);
  for (const [id, detail] of Object.entries(state.details)) {
    expect(detail.id).toBe(id);
    const ids = detail.messages.map((m) => m.id);
    expect(new Set(ids).size, `messages of ${id} are unique`).toBe(ids.length);
  }
  for (const [id, a] of Object.entries(state.approvals)) expect(a.id).toBe(id);
  expect(countPendingApprovals(state)).toBe(
    Object.values(state.approvals).filter((a) => a.status === "pending").length,
  );
}

/** Invariants about the effect of one step. */
function expectStep(before: AgentState, after: AgentState, o: Op, event: ServerEvent | null): void {
  if (o.kind === "other") expect(after, "non-agent events are ignored").toBe(before);
  if (!event) return;
  switch (event.type) {
    case "task.record": {
      const previous = findRecordIn(before.records, event.record.taskId);
      const current = findRecordIn(after.records, event.record.taskId);
      expect(current, "a task.record is never dropped").toBeDefined();
      if (previous) {
        expect(
          current!.updatedAt,
          "a stale task.record never replaces a newer one",
        ).toBeGreaterThanOrEqual(previous.updatedAt);
      }
      break;
    }
    case "thread.message": {
      if (!before.details[event.threadId]) {
        expect(after, "messages for threads that aren't loaded are ignored").toBe(before);
      } else {
        expect(findMessage(after, event.threadId, event.message.id)).toEqual(event.message);
      }
      break;
    }
    case "thread.delta": {
      const target = findMessage(before, event.threadId, event.messageId);
      const streaming = target?.kind === "text" && target.streaming === true;
      if (!streaming) {
        expect(after, "deltas only extend messages that are still streaming").toBe(before);
      } else {
        const next = findMessage(after, event.threadId, event.messageId);
        expect(next?.kind === "text" && next.text).toBe(
          target.kind === "text" && target.text + event.delta,
        );
      }
      break;
    }
    case "thread.upsert": {
      const detail = after.details[event.thread.id];
      if (detail && after.threads[event.thread.id] === event.thread) {
        expect(detail.status, "loaded thread follows its summary").toBe(event.thread.status);
        expect(detail.title).toBe(event.thread.title);
      }
      break;
    }
    case "approval.upsert":
      expect(after.approvals[event.approval.id]).toEqual(event.approval);
      break;
    default:
      break;
  }
}

function eventOf(o: Op, history: readonly ServerEvent[]): ServerEvent | null {
  if (o.kind === "event") return o.event;
  if (o.kind === "replay" && history.length > 0) return history[o.index % history.length]!;
  return null;
}

describe("agent reducer under random event streams (fuzz)", () => {
  test.prop([fc.array(op, { minLength: 1, maxLength: 60 })])(
    "never throws and keeps the state internally consistent",
    (ops) => {
      let state = initialAgentState;
      const history: ServerEvent[] = [];
      for (const o of ops) {
        const event = eventOf(o, history);
        const next = applyOp(state, o, history);
        expectConsistent(next);
        expectStep(state, next, o, event);
        if (o.kind === "event") history.push(o.event);
        state = next;
      }
    },
  );

  test.prop([fc.array(op, { maxLength: 40 }), agentEvent])(
    "delivering an event twice is the same as once (except deltas, which carry no offset)",
    (ops, event) => {
      let state = initialAgentState;
      for (const o of ops) state = applyOp(state, o, []);
      if (event.type === "thread.delta") return;
      const once = reduceAgentEvent(state, event);
      expect(reduceAgentEvent(once, event)).toEqual(once);
    },
  );

  test.prop([
    fc.array(op, { maxLength: 40 }),
    fc.uniqueArray(summary, { selector: (s) => s.id, maxLength: 3 }),
    fc.uniqueArray(approval, { selector: (a) => a.id, maxLength: 3 }),
    fc.uniqueArray(loadedThread, { selector: (t) => t.id, maxLength: 3 }),
    fc.array(snapshot, { maxLength: 3 }),
  ])(
    "a reconnect resync converges to the server's snapshot, whatever came before",
    (ops, threads, approvals, loaded, snapshots) => {
      let state = initialAgentState;
      for (const o of ops) state = applyOp(state, o, []);
      // What the app does after a reconnect (loadOverview, refreshRecords, loadThread).
      state = applyThreadList(state, threads);
      state = applyApprovalList(state, approvals);
      for (const [notePath, records] of snapshots) {
        state = applyRecordsSnapshot(state, notePath, records);
      }
      for (const thread of loaded) state = applyThreadResponse(state, { thread, approvals: [] });
      expectConsistent(state);
      for (const thread of loaded) expect(state.details[thread.id]).toEqual(thread);
      for (const a of approvals) expect(state.approvals[a.id]).toEqual(a);
      for (const s of threads) {
        if (!loaded.some((t) => t.id === s.id)) expect(state.threads[s.id]).toEqual(s);
      }
    },
  );
});
