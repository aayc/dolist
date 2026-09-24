/**
 * Runtime ⇄ contract conformance: a mock-mode runtime (real safety stack, deterministic scripts)
 * runs tasks through triage, streaming, artifacts, frames, approvals (approved and denied),
 * replies, cancel and retry. Every event it emits (as the WebSocket hub forwards it) and every
 * query result must parse strictly with the wire schemas.
 */
import {
  AgentStatusResponseSchema,
  ApprovalListResponseSchema,
  ArtifactMetaSchema,
  exact,
  ServerEventSchema,
  TaskRecordsResponseSchema,
  ThreadListResponseSchema,
  ThreadResponseSchema,
} from "@ddl/contract";
import { TINY_JPEG_BASE64 } from "@ddl/contract/testing";
import {
  type ServerEvent,
  type ServerEventType,
  type TaskAgentStatus,
  textResult,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionToolFactory } from "../src/execution/types";
import { ScriptedHarness } from "../src/harness/scripted";
import { createMockScript } from "../src/orchestrator/mock-script";
import { createAgentRuntime } from "../src/runtime";
import type { AgentRuntime, AgentRuntimeEvents } from "../src/runtime-types";
import { createFakeExecution, testSettings } from "./helpers/fakes";
import { TODAY } from "./helpers/runtime";

const WAIT = { timeout: 4_000, interval: 5 };

type Schema = Parameters<typeof exact>[0];
const FRAME_TOOL = "fake_frame";

/** Execution tools reduced to one read-only tool that streams a browser frame. */
const frameTools: ExecutionToolFactory = (_provider, ctx) => [
  {
    name: FRAME_TOOL,
    label: "Look at the page",
    description: "Emits one browser frame.",
    parameters: { type: "object", properties: {} },
    safety: { readOnly: true, category: "read" },
    async execute() {
      ctx.onFrame?.("browser", {
        mimeType: "image/jpeg",
        data: TINY_JPEG_BASE64,
        width: 1,
        height: 1,
        url: "https://dentist.example/book",
        title: "Book online",
        action: { kind: "click", x: 0.5, y: 0.5 },
        ts: Date.now(),
      });
      return textResult("Looked at the page.");
    },
  },
];

/** The default mock scripts, with every subagent looking at a page first. */
function harness(): ScriptedHarness {
  const mock = createMockScript();
  return new ScriptedHarness({
    wordDelayMs: 0,
    scriptFor: (options) => {
      const script = mock(options);
      if (options.role === "orchestrator") return script;
      return async (ctx) => {
        if (ctx.turn === 0) await ctx.callTool(FRAME_TOOL, {});
        await script(ctx);
      };
    },
  });
}

/** How the WebSocket hub forwards each runtime event. */
function toServerEvent<K extends keyof AgentRuntimeEvents>(key: K, payload: AgentRuntimeEvents[K]) {
  switch (key) {
    case "task.record":
      return { type: key, record: payload };
    case "thread.upsert":
      return { type: key, thread: payload };
    case "approval.upsert":
      return { type: key, approval: payload };
    case "status":
      return { type: "agent.status", status: payload };
    default:
      return { type: key, ...(payload as object) };
  }
}

const EVENT_KEYS: Array<keyof AgentRuntimeEvents> = [
  "task.record",
  "task.records",
  "thread.upsert",
  "thread.message",
  "thread.delta",
  "approval.upsert",
  "status",
  "surface.frame",
];

let runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes) await runtime.stop();
  runtimes = [];
});

async function start() {
  const storage = new MemoryStorageProvider();
  const runtime = await createAgentRuntime(
    {
      mode: "mock",
      storage,
      settings: testSettings(),
      home: "/tmp/ddl-test-home",
      execution: createFakeExecution({ browser: true }),
      harness: harness(),
    },
    {
      createExecutionTools: frameTools,
      createWebTools: () => [],
      batchWindowMs: 5,
      reportDelayMs: 5,
      mockWordDelayMs: 0,
    },
  );
  runtimes.push(runtime);
  const violations: string[] = [];
  const seen = new Map<ServerEventType, number>();

  const check = (label: string, schema: Schema, value: unknown) => {
    const wire: unknown = JSON.parse(JSON.stringify(value));
    const parsed = exact(schema).safeParse(wire);
    if (!parsed.success) {
      violations.push(
        `${label}: ${JSON.stringify(parsed.error.issues)} in ${JSON.stringify(wire).slice(0, 400)}`,
      );
    }
  };

  for (const key of EVENT_KEYS) {
    runtime.on(key, (payload) => {
      const event = toServerEvent(key, payload) as ServerEvent;
      seen.set(event.type, (seen.get(event.type) ?? 0) + 1);
      check(`event ${event.type}`, ServerEventSchema, event);
    });
  }
  // Frames only flow to subscribers: watch every thread's browser as soon as it exists.
  const watched = new Set<string>();
  runtime.on("thread.upsert", (thread) => {
    if (watched.has(thread.id)) return;
    watched.add(thread.id);
    runtime.subscribeSurface(thread.id, "browser");
  });

  /** Checks every query result against its response schema. */
  const checkQueries = async (label: string) => {
    check(`${label} status()`, AgentStatusResponseSchema, runtime.status());
    check(`${label} getTaskRecords()`, TaskRecordsResponseSchema, {
      records: runtime.getTaskRecords(TODAY),
    });
    const threads = runtime.listThreads();
    check(`${label} listThreads()`, ThreadListResponseSchema, { threads });
    check(`${label} listThreads(note)`, ThreadListResponseSchema, {
      threads: runtime.listThreads({ notePath: TODAY }),
    });
    for (const summary of threads) {
      const response = runtime.getThread(summary.id);
      check(`${label} getThread(${summary.id})`, ThreadResponseSchema, response);
      for (const meta of response?.thread.artifacts ?? []) {
        const artifact = await runtime.readArtifact(meta.threadId, meta.id);
        check(`${label} readArtifact()`, ArtifactMetaSchema, artifact?.meta);
      }
    }
    check(`${label} listApprovals()`, ApprovalListResponseSchema, {
      approvals: runtime.listApprovals(),
    });
    check(`${label} listApprovals(pending)`, ApprovalListResponseSchema, {
      approvals: runtime.listApprovals({ status: "pending" }),
    });
  };

  const record = (text: string) => runtime.getTaskRecords(TODAY).find((r) => r.text === text);
  const waitFor = (text: string, status: TaskAgentStatus) =>
    vi.waitFor(() => {
      const current = record(text);
      if (current?.status !== status)
        throw new Error(`"${text}" is ${current?.status ?? "missing"}`);
      return current;
    }, WAIT);

  await runtime.start();
  return { runtime, storage, violations, seen, checkQueries, record, waitFor };
}

const RESEARCH = "Research best standing desks under $500";
const GYM = "Go to the gym";
const BOOK = "Book dentist appointment next week";
const EMAIL = "Email the landlord about the heater";
const RESERVE = "Reserve a table for Friday";

describe("mock runtime ⇄ wire contract", () => {
  it("emits only conformant events and answers only conformant queries", async () => {
    const t = await start();
    await t.checkQueries("idle");
    await t.storage.write(
      TODAY,
      [
        `- [ ] ${RESEARCH}`,
        `- [ ] ${GYM}`,
        `- [ ] ${BOOK}`,
        `- [ ] ${EMAIL}`,
        "- [x] Paid rent",
        "- [ ] ",
      ].join("\n"),
    );
    await t.waitFor(RESEARCH, "done");
    await t.waitFor(GYM, "ignored");
    const booking = await t.waitFor(BOOK, "waiting_approval");
    const email = await t.waitFor(EMAIL, "waiting_approval");
    await t.checkQueries("waiting");

    const pending = t.runtime.listApprovals({ status: "pending" });
    const bookApproval = pending.find((a) => a.taskId === booking.taskId)!;
    const emailApproval = pending.find((a) => a.taskId === email.taskId)!;
    await t.runtime.decideApproval(bookApproval.id, {
      decision: "approve",
      scope: "task",
      note: "ok",
    });
    await t.runtime.decideApproval(emailApproval.id, {
      decision: "deny",
      note: "I'll call instead",
    });
    await t.waitFor(BOOK, "done");
    await vi.waitFor(() => expect(t.record(EMAIL)?.status).not.toBe("waiting_approval"), WAIT);

    const research = t.record(RESEARCH)!;
    await t.runtime.postUserMessage(research.threadId!, "Only ones with a crank handle 🛠️");
    await vi.waitFor(() => {
      const texts = t.runtime
        .getThread(research.threadId!)
        ?.thread.messages.filter((m) => m.kind === "text");
      expect(texts?.at(-1)?.kind === "text" && texts.at(-1)).toMatchObject({
        text: expect.stringContaining("Updated"),
      });
    }, WAIT);
    t.runtime.markThreadRead(research.threadId!);
    await t.checkQueries("replied");

    expect(t.violations).toEqual([]);
    for (const type of [
      "task.record",
      "task.records",
      "thread.upsert",
      "thread.message",
      "thread.delta",
      "approval.upsert",
      "agent.status",
      "surface.frame",
    ] as const) {
      expect(t.seen.get(type) ?? 0, `${type} events`).toBeGreaterThan(0);
    }
  });

  it("stays conformant through cancel, retry, disable and settings changes", async () => {
    const t = await start();
    await t.storage.write(TODAY, `- [ ] ${RESERVE}\n`);
    const reserve = await t.waitFor(RESERVE, "waiting_approval");
    await t.runtime.cancelThread(reserve.threadId!);
    await t.waitFor(RESERVE, "cancelled");
    await t.checkQueries("cancelled");
    await t.runtime.retryThread(reserve.threadId!);
    await t.waitFor(RESERVE, "waiting_approval");
    await t.runtime.cancelThread(reserve.threadId!);
    await t.waitFor(RESERVE, "cancelled");
    await t.runtime.setEnabled(false);
    t.runtime.updateSettings(testSettings({ agent: { maxConcurrentSubagents: 5, enabled: true } }));
    await t.checkQueries("reconfigured");
    await t.runtime.postUserMessage(reserve.threadId!, "Never mind");
    await t.checkQueries("after reply");
    expect(t.violations).toEqual([]);
    expect(
      t.runtime
        .listApprovals()
        .map((a) => a.status)
        .sort(),
    ).toEqual(["cancelled", "cancelled"]);
  });
});
