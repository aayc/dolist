import {
  type AgentMode,
  type AppSettings,
  DEFAULT_SETTINGS,
  type DeepPartial,
  dailyNotePath,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TextMessage,
  type Thread,
  today,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { vi } from "vitest";
import { type AgentScript, ScriptedHarness } from "../../src/harness/scripted";
import type { Harness, HarnessSessionOptions } from "../../src/harness/types";
import type { LlmClient } from "../../src/llm/types";
import { type AgentRuntimeOverrides, createAgentRuntime } from "../../src/runtime";
import type { AgentRuntime, AgentRuntimeEvents } from "../../src/runtime-types";
import { createFakeExecution, type FakeExecution, fakeSafety, testSettings } from "./fakes";

/** Today's daily note (runtime tests use real timers and the real clock). */
export const TODAY = dailyNotePath(today(), DEFAULT_SETTINGS.dailyNotes);

export interface RuntimeEventLog {
  records: TaskAgentRecord[];
  deltas: AgentRuntimeEvents["thread.delta"][];
  statuses: AgentRuntimeEvents["status"][];
  approvals: AgentRuntimeEvents["approval.upsert"][];
  frames: AgentRuntimeEvents["surface.frame"][];
}

export interface TestRuntime {
  runtime: AgentRuntime;
  storage: MemoryStorageProvider;
  execution: FakeExecution;
  safety: ReturnType<typeof fakeSafety>;
  events: RuntimeEventLog;
  /** Distinct consecutive statuses a task went through (from `task.record` events). */
  statusesOf(text: string): TaskAgentStatus[];
  record(text: string): TaskAgentRecord | undefined;
  waitForStatus(text: string, status: TaskAgentStatus): Promise<TaskAgentRecord>;
  thread(text: string): Thread;
  texts(text: string): string[];
}

export interface TestRuntimeOptions {
  mode?: AgentMode;
  storage?: MemoryStorageProvider;
  settings?: DeepPartial<AppSettings>;
  /** Per-session scripts for a ScriptedHarness (otherwise the mode's default harness). */
  scriptFor?: (options: HarnessSessionOptions) => AgentScript;
  harness?: Harness;
  /** The OpenRouter client live mode uses for the safety judge and web_search. */
  llm?: LlmClient;
  overrides?: AgentRuntimeOverrides;
  execution?: FakeExecution;
  start?: boolean;
}

export async function createTestRuntime(options: TestRuntimeOptions = {}): Promise<TestRuntime> {
  const storage = options.storage ?? new MemoryStorageProvider();
  const safety = fakeSafety(options.overrides);
  const execution = options.execution ?? createFakeExecution();
  const harness =
    options.harness ??
    (options.scriptFor ? new ScriptedHarness({ scriptFor: options.scriptFor }) : undefined);
  const runtime = await createAgentRuntime(
    {
      mode: options.mode ?? "mock",
      storage,
      settings: testSettings(options.settings),
      home: "/tmp/ddl-test-home",
      execution,
      ...(harness ? { harness } : {}),
      ...(options.llm ? { llm: options.llm } : {}),
    },
    safety.overrides,
  );
  const events: RuntimeEventLog = {
    records: [],
    deltas: [],
    statuses: [],
    approvals: [],
    frames: [],
  };
  runtime.on("task.record", (record) => events.records.push(record));
  runtime.on("thread.delta", (delta) => events.deltas.push(delta));
  runtime.on("status", (status) => events.statuses.push(status));
  runtime.on("approval.upsert", (approval) => events.approvals.push(approval));
  runtime.on("surface.frame", (frame) => events.frames.push(frame));
  if (options.start !== false) await runtime.start();

  const record = (text: string) => runtime.getTaskRecords(TODAY).find((r) => r.text === text);

  const thread = (text: string): Thread => {
    const threadId = runtime.getTaskRecords(TODAY).find((r) => r.text === text)?.threadId;
    const found = threadId ? runtime.getThread(threadId)?.thread : undefined;
    if (!found) throw new Error(`No thread for "${text}"`);
    return found;
  };

  return {
    runtime,
    storage,
    execution,
    safety,
    events,
    record,
    thread,
    statusesOf(text) {
      const out: TaskAgentStatus[] = [];
      for (const r of events.records) {
        if (r.text === text && out.at(-1) !== r.status) out.push(r.status);
      }
      return out;
    },
    async waitForStatus(text, status) {
      return vi.waitFor(
        () => {
          const current = runtime.getTaskRecords(TODAY).find((r) => r.text === text);
          if (current?.status !== status) {
            throw new Error(`"${text}" is ${current?.status ?? "missing"}, waiting for ${status}`);
          }
          return current;
        },
        { timeout: 4_000, interval: 5 },
      );
    },
    texts(text) {
      return thread(text)
        .messages.filter((m): m is TextMessage => m.kind === "text")
        .map((m) => m.text);
    },
  };
}

export function isSubsequence<T>(needle: readonly T[], haystack: readonly T[]): boolean {
  let i = 0;
  for (const item of haystack) if (item === needle[i]) i++;
  return i === needle.length;
}
