/**
 * `createFakeAgentRuntime`: the real AgentRuntime (watcher, orchestrator, subagents, real safety
 * evaluator + gate + approval broker, threads, records) driven by the FakeBrain, either in-process
 * (`via: "scripted"`) or through the real Pi harness and OpenRouter client against the HTTP fake
 * (`via: "pi-http"`). Returns event-driven helpers for writing notes, waiting for statuses,
 * deciding approvals and replying, plus an audit proving every executed tool passed the gate.
 *
 * Timeouts use real timers captured at load, so tests on fake timers still fail fast; pass
 * `advanceTimers` to make `advance()` drive fake time.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AgentMode,
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type AppSettings,
  addDays,
  DEFAULT_SETTINGS,
  type DeepPartial,
  dailyNotePath,
  type Logger,
  mergeSettings,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TextMessage,
  type Thread,
  type ThreadMessage,
  type ToolCallMessage,
  today,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { createExecutionTools } from "../execution";
import { createPiHarness } from "../harness/pi";
import { ScriptedHarness } from "../harness/scripted";
import type { AgentRole, Harness, ToolCallDecision } from "../harness/types";
import { createOpenRouterClient } from "../llm/openrouter";
import type { LlmClient } from "../llm/types";
import { type AgentRuntimeOverrides, createAgentRuntime } from "../runtime";
import type { AgentRuntime, AgentRuntimeEvents } from "../runtime-types";
import { createSafetyGate } from "../safety/gate";
import type { SafetyPolicy, SafetyVerdict } from "../safety/types";
import { createFakeBrain, type FakeBrain } from "./brain/brain";
import { isDigest } from "./brain/digest";
import { isKickoff } from "./brain/kickoff";
import {
  type FakeOpenRouter,
  type FakeOpenRouterOptions,
  type ServerFault,
  startFakeOpenRouter,
} from "./fake-openrouter";
import {
  createFakeConnectors,
  createFakeExecution,
  createFakeWeb,
  createFakeWebTools,
  type FakeConnectors,
  type FakeExecution,
  type FakeExecutionOptions,
  type FakeWeb,
} from "./fakes";
import { createFakeLlmClient } from "./llm-client";
import { createFakeAgentScript, type ScriptToolEvent } from "./script";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export type FakeVia = "scripted" | "pi-http";

export interface FakeAgentRuntimeOptions {
  /** In-process ScriptedHarness (default) or the real Pi harness over HTTP against the fake. */
  via?: FakeVia;
  /** Scripted only: "mock" (default; rules-only safety, mock irreversible tool) or "live". */
  mode?: Exclude<AgentMode, "off"> | "off";
  storage?: MemoryStorageProvider;
  settings?: DeepPartial<AppSettings>;
  brain?: FakeBrain;
  /** pi-http: an existing fake server (not closed by `stop()`), or options for a new one. */
  server?: FakeOpenRouter | FakeOpenRouterOptions;
  /** pi-http: faults injected into the new server at start. */
  faults?: Array<ServerFault | { fault: ServerFault; times?: number }>;
  /**
   * Let the runtime build its own harness, as in production: in mock mode the built-in (sandboxed)
   * brain script; with pi-http the Pi harness and key check pointed at the fake. Default false: the
   * helper injects a harness using `brain` (Pi with fast retries for pi-http).
   */
  runtimeHarness?: boolean;
  safetyPolicy?: Partial<SafetyPolicy>;
  /** An execution provider, or options for the fake one (shell on, browser off by default). */
  execution?: FakeExecution | FakeExecutionOptions;
  /** `true` for the default fake mail/calendar connectors. */
  connectors?: boolean | ConnectorToolSource;
  /** Pages for the fake web (web_fetch). */
  web?: FakeWeb;
  overrides?: AgentRuntimeOverrides;
  /** Delay between streamed words (scripted). Default 0. */
  wordDelayMs?: number;
  /** Makes `advance(ms)` drive fake timers, e.g. `(ms) => vi.advanceTimersByTimeAsync(ms)`. */
  advanceTimers?: (ms: number) => Promise<unknown>;
  now?: () => number;
  logger?: Logger;
  /** Call `start()` on the runtime. Default true. */
  start?: boolean;
  /** Default timeout of the wait helpers. Default 5 s. */
  timeoutMs?: number;
}

export interface GateRecord {
  seq: number;
  sessionId: string;
  role: AgentRole;
  toolCallId: string;
  toolName: string;
  input: unknown;
  verdict?: Pick<SafetyVerdict, "decision" | "source" | "risk" | "categories" | "reason">;
  /** Absent while the call waits (e.g. for approval). */
  decision?: ToolCallDecision;
}

export interface ExecutionRecord {
  seq: number;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** A gate "allow" for this call was recorded before it executed. */
  gated: boolean;
}

export interface ToolAudit {
  /** Every call that reached the safety gate. */
  readonly gate: GateRecord[];
  /** Every ToolSpec execution (scripted, and pi-http with the injected harness). */
  readonly executions: ExecutionRecord[];
  /** Every tool call the brain made in-process (scripted), with what it saw. */
  readonly brainCalls: ScriptToolEvent[];
  /** Executions (and shell commands) without a prior gate allow. Must always be empty. */
  ungated(): Array<{ toolName: string; toolCallId?: string; reason: string }>;
}

export type RuntimeEvent = {
  [K in keyof AgentRuntimeEvents]: { type: K; payload: AgentRuntimeEvents[K]; at: number };
}[keyof AgentRuntimeEvents];

export interface WaitOptions {
  timeoutMs?: number;
}

export interface FakeAgentRuntime {
  /** The current runtime (replaced by `restart()`). */
  readonly runtime: AgentRuntime;
  readonly storage: MemoryStorageProvider;
  readonly brain: FakeBrain;
  readonly via: FakeVia;
  readonly mode: AgentMode;
  readonly settings: AppSettings;
  /** pi-http only. */
  readonly server: FakeOpenRouter | undefined;
  readonly execution: FakeExecution;
  readonly connectors: FakeConnectors | undefined;
  readonly web: FakeWeb;
  readonly audit: ToolAudit;
  /** Every runtime event, in order (kept across restarts). */
  readonly events: RuntimeEvent[];
  /** DDL_HOME used by the runtime (a temp dir for pi-http). */
  readonly home: string;

  notePath(dayOffset?: number): string;
  /** Writes a daily note (lines joined with newlines). `external` mimics an edit made in Obsidian. */
  writeDailyNote(
    content: string | readonly string[],
    options?: { day?: number; external?: boolean },
  ): Promise<string>;
  /** Records of every note the runtime knows about, sorted by note and line. */
  records(): TaskAgentRecord[];
  record(text: string): TaskAgentRecord | undefined;
  /** Consecutive distinct statuses of the task(s) that ever had this text. */
  statusesOf(text: string): TaskAgentStatus[];
  thread(text: string): Thread;
  messages(text: string): ThreadMessage[];
  texts(text: string): string[];
  toolCalls(text: string): ToolCallMessage[];
  waitForStatus(
    text: string,
    status: TaskAgentStatus | readonly TaskAgentStatus[],
    options?: WaitOptions,
  ): Promise<TaskAgentRecord>;
  waitFor<T>(
    check: () => T | undefined | null | false,
    options?: WaitOptions & { what?: string },
  ): Promise<T>;
  waitForApproval(options?: WaitOptions & { task?: string }): Promise<ApprovalRequest>;
  pendingApprovals(): ApprovalRequest[];
  approveNext(
    options?: WaitOptions & {
      scope?: ApprovalDecisionRequest["scope"];
      note?: string;
      task?: string;
    },
  ): Promise<ApprovalRequest>;
  denyNext(note?: string, options?: WaitOptions & { task?: string }): Promise<ApprovalRequest>;
  replyInThread(text: string, message: string): Promise<void>;
  /** Orchestrator digests the brain received, in order (one per orchestrator turn). */
  digests(): string[];
  /** Subagent kickoff prompts the brain received, in order. */
  kickoffs(): string[];
  /** Waits until nothing is triaging, queued, working or running. */
  idle(options?: WaitOptions): Promise<void>;
  /** Advances fake timers (with `advanceTimers`) or waits real time. */
  advance(ms: number): Promise<void>;
  /** Stops the runtime and starts a new one on the same storage. `crash` skips the clean stop. */
  restart(options?: { crash?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_TEST_AGENT = { settleMs: 20, maxConcurrentSubagents: 3, actOnExistingTasks: true };

export async function createFakeAgentRuntime(
  options: FakeAgentRuntimeOptions = {},
): Promise<FakeAgentRuntime> {
  const via = options.via ?? "scripted";
  const mode: AgentMode = via === "pi-http" ? "live" : (options.mode ?? "mock");
  const brain = options.brain ?? createFakeBrain();
  let storage = options.storage ?? new MemoryStorageProvider();
  const settings = mergeSettings(
    mergeSettings(DEFAULT_SETTINGS, { agent: DEFAULT_TEST_AGENT }),
    options.settings,
  );
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cleanups: Array<() => Promise<void>> = [];

  let server: FakeOpenRouter | undefined;
  let home = "/tmp/ddl-fake-home";
  if (via === "pi-http") {
    const given = options.server;
    if (given && "baseUrl" in given) server = given;
    else {
      server = await startFakeOpenRouter({ brain, ...given });
      const owned = server;
      cleanups.push(() => owned.close());
    }
    for (const entry of options.faults ?? []) {
      if ("fault" in entry) server.inject(entry.fault, { times: entry.times ?? 1 });
      else server.inject(entry);
    }
    home = await mkdtemp(join(tmpdir(), "ddl-fake-home-"));
    const dir = home;
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
  }

  const execution =
    options.execution && "prepareWorkspace" in options.execution
      ? options.execution
      : createFakeExecution({
          ...(via === "pi-http" ? { workspaceRoot: join(home, "workspaces") } : {}),
          ...(options.execution as FakeExecutionOptions | undefined),
        });
  const connectors =
    options.connectors === true
      ? createFakeConnectors()
      : options.connectors
        ? (options.connectors as FakeConnectors)
        : undefined;
  const web = options.web ?? createFakeWeb();

  const audit = createAudit(execution);
  const events: RuntimeEvent[] = [];
  const knownNotes = new Set<string>();
  let llm: LlmClient | undefined;
  if (server) {
    llm = createOpenRouterClient({
      apiKey: server.apiKey,
      defaultModel: settings.agent.model,
      baseUrl: server.baseUrl,
      maxRetries: 1,
    });
  } else if (mode === "live") {
    llm = createFakeLlmClient(brain, { defaultModel: settings.agent.model });
  }

  const userOverrides = options.overrides ?? {};
  const overrides: AgentRuntimeOverrides = {
    batchWindowMs: 5,
    reportDelayMs: 5,
    mockWordDelayMs: 0,
    createExecutionTools,
    createWebTools: ({ llm: client }) =>
      createFakeWebTools({ ...(client ? { llm: client } : {}), web }),
    ...userOverrides,
    createSafetyGate: (gateOptions) => {
      const gate = (userOverrides.createSafetyGate ?? createSafetyGate)({
        ...gateOptions,
        onVerdict: (call, verdict) => {
          const record = audit.gate.find(
            (g) => g.toolCallId === call.toolCallId && g.sessionId === call.sessionId,
          );
          if (record) {
            const { decision, source, risk, categories, reason } = verdict;
            record.verdict = { decision, source, risk, categories, reason };
          }
          gateOptions.onVerdict?.(call, verdict);
        },
      });
      return async (call) => {
        const record: GateRecord = {
          seq: audit.gate.length + 1,
          sessionId: call.sessionId,
          role: call.role,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        };
        audit.gate.push(record);
        const decision = await gate(call);
        record.decision = decision;
        return decision;
      };
    },
    ...(options.runtimeHarness && server
      ? { openRouter: { apiKey: server.apiKey, baseUrl: server.baseUrl } }
      : {}),
  };

  const harness = (): Harness | undefined => {
    if (options.runtimeHarness) return undefined;
    if (via === "scripted") {
      return auditHarness(
        new ScriptedHarness({
          scriptFor: createFakeAgentScript(brain, {
            onToolCall: (event) => audit.brainCalls.push(event),
          }),
          wordDelayMs: options.wordDelayMs ?? 0,
        }),
        audit,
      );
    }
    return auditHarness(
      createPiHarness({
        apiKey: server!.apiKey,
        home,
        baseUrl: server!.baseUrl,
        retry: { maxRetries: 1, baseDelayMs: 1 },
      }),
      audit,
    );
  };

  const build = async (): Promise<AgentRuntime> => {
    const injected = harness();
    const runtime = await createAgentRuntime(
      {
        mode,
        storage,
        settings,
        home,
        execution,
        ...(connectors ? { connectors } : {}),
        ...(injected ? { harness: injected } : {}),
        ...(llm ? { llm } : {}),
        ...(options.safetyPolicy ? { safetyPolicy: options.safetyPolicy } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        now,
      },
      overrides,
    );
    const names: Array<keyof AgentRuntimeEvents> = [
      "task.record",
      "task.records",
      "thread.upsert",
      "thread.message",
      "thread.delta",
      "approval.upsert",
      "status",
      "surface.frame",
    ];
    for (const type of names) {
      runtime.on(type, (payload) => {
        if (type === "task.record") knownNotes.add((payload as TaskAgentRecord).notePath);
        events.push({ type, payload, at: now() } as RuntimeEvent);
        notify();
      });
    }
    if (options.start !== false) await runtime.start();
    return runtime;
  };

  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };

  let runtime = await build();
  let stopped = false;

  const notePath = (dayOffset = 0) =>
    dailyNotePath(addDays(today(new Date(now())), dayOffset), settings.dailyNotes);
  knownNotes.add(notePath());

  const records = (): TaskAgentRecord[] =>
    [...knownNotes].sort().flatMap((path) => runtime.getTaskRecords(path));
  const record = (text: string) => records().find((r) => r.text === text);
  const taskIdsFor = (text: string): Set<string> => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type === "task.record" && event.payload.text === text)
        ids.add(event.payload.taskId);
    }
    const current = record(text);
    if (current) ids.add(current.taskId);
    return ids;
  };
  const thread = (text: string): Thread => {
    const found = record(text);
    const threadId = found?.threadId ?? threadIdFromEvents(text);
    const result = threadId ? runtime.getThread(threadId)?.thread : undefined;
    if (!result)
      throw new Error(`No thread for "${text}" (record: ${found ? found.status : "none"})`);
    return result;
  };
  const threadIdFromEvents = (text: string): string | undefined => {
    const ids = taskIdsFor(text);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === "task.record" && ids.has(event.payload.taskId) && event.payload.threadId) {
        return event.payload.threadId;
      }
    }
    return undefined;
  };

  const waitFor = <T>(
    check: () => T | undefined | null | false,
    waitOptions: WaitOptions & { what?: string } = {},
  ): Promise<T> => {
    type Attempt = { ok: true; value: T } | { ok: false; error?: unknown };
    const attempt = (): Attempt => {
      try {
        const value = check();
        return value === undefined || value === null || value === false
          ? { ok: false }
          : { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const first = attempt();
    if (first.ok) return Promise.resolve(first.value);
    return new Promise<T>((resolve, reject) => {
      let last: Attempt = first;
      const finish = () => {
        realClearTimeout(timer);
        realClearTimeout(poll);
        waiters.delete(onEvent);
      };
      let settled = false;
      const check = () => {
        if (settled) return;
        last = attempt();
        if (last.ok) {
          settled = true;
          finish();
          resolve(last.value);
        }
      };
      // Check after the emitting code finished its synchronous work, not halfway through it.
      const onEvent = () => queueMicrotask(check);
      let poll = realSetTimeout(function tick() {
        check();
        if (!settled) poll = realSetTimeout(tick, 5);
      }, 5);
      const timer = realSetTimeout(() => {
        settled = true;
        finish();
        const detail = !last.ok && last.error instanceof Error ? `: ${last.error.message}` : "";
        reject(
          new Error(
            `Timed out waiting for ${waitOptions.what ?? "condition"}${detail}\n${describeState()}`,
          ),
        );
      }, waitOptions.timeoutMs ?? timeoutMs);
      waiters.add(onEvent);
    });
  };

  const describeState = (): string => {
    const lines = records().map(
      (r) =>
        `  - ${JSON.stringify(r.text.slice(0, 80))}: ${r.status}${r.summary ? ` (${r.summary})` : ""}`,
    );
    const pending = runtime.listApprovals({ status: "pending" }).length;
    const status = runtime.status();
    return `records:\n${lines.join("\n") || "  (none)"}\nrunning ${status.running}, queued ${status.queued}, pending approvals ${pending}${status.problem ? `, problem: ${status.problem}` : ""}`;
  };

  const pendingFor = (task?: string): ApprovalRequest[] => {
    const pending = runtime.listApprovals({ status: "pending" });
    if (!task) return pending;
    const ids = taskIdsFor(task);
    return pending.filter((a) => a.taskId !== null && ids.has(a.taskId));
  };

  const fake: FakeAgentRuntime = {
    get runtime() {
      return runtime;
    },
    get storage() {
      return storage;
    },
    brain,
    via,
    mode,
    settings,
    server,
    execution,
    connectors,
    web,
    audit,
    events,
    home,
    notePath,
    async writeDailyNote(content, writeOptions = {}) {
      const path = notePath(writeOptions.day ?? 0);
      knownNotes.add(path);
      const text = typeof content === "string" ? content : `${content.join("\n")}\n`;
      if (writeOptions.external) storage.simulateExternalChange(path, text);
      else await storage.write(path, text);
      return path;
    },
    records,
    record,
    statusesOf(text) {
      const ids = taskIdsFor(text);
      const out: TaskAgentStatus[] = [];
      for (const event of events) {
        if (event.type !== "task.record" || !ids.has(event.payload.taskId)) continue;
        if (out.at(-1) !== event.payload.status) out.push(event.payload.status);
      }
      return out;
    },
    thread,
    messages: (text) => thread(text).messages,
    texts: (text) =>
      thread(text)
        .messages.filter((m): m is TextMessage => m.kind === "text")
        .map((m) => m.text),
    toolCalls: (text) =>
      thread(text).messages.filter((m): m is ToolCallMessage => m.kind === "tool_call"),
    waitForStatus(text, status, waitOptions = {}) {
      const wanted = typeof status === "string" ? [status] : status;
      return waitFor(
        () => {
          const current = record(text);
          return current && wanted.includes(current.status) ? current : undefined;
        },
        { ...waitOptions, what: `"${text.slice(0, 80)}" to be ${wanted.join(" or ")}` },
      );
    },
    waitFor,
    waitForApproval(waitOptions = {}) {
      return waitFor(() => pendingFor(waitOptions.task)[0], {
        ...waitOptions,
        what: "a pending approval",
      });
    },
    pendingApprovals: () => runtime.listApprovals({ status: "pending" }),
    async approveNext(approveOptions = {}) {
      const approval = await fake.waitForApproval(approveOptions);
      return runtime.decideApproval(approval.id, {
        decision: "approve",
        ...(approveOptions.scope ? { scope: approveOptions.scope } : {}),
        ...(approveOptions.note ? { note: approveOptions.note } : {}),
      });
    },
    async denyNext(note, denyOptions = {}) {
      const approval = await fake.waitForApproval(denyOptions);
      return runtime.decideApproval(approval.id, { decision: "deny", ...(note ? { note } : {}) });
    },
    async replyInThread(text, message) {
      await runtime.postUserMessage(thread(text).id, message);
    },
    digests: () => distinctPrompts(brain, "orchestrator", isDigest),
    kickoffs: () => distinctPrompts(brain, "subagent", isKickoff),
    async idle(waitOptions = {}) {
      const busy = new Set<TaskAgentStatus>(["triaging", "queued", "working"]);
      let calm = 0;
      await waitFor(
        () => {
          const status = runtime.status();
          const quiet =
            status.running === 0 &&
            status.queued === 0 &&
            !records().some((r) => busy.has(r.status));
          calm = quiet ? calm + 1 : 0;
          return calm >= 3;
        },
        { ...waitOptions, what: "the agent to be idle" },
      );
    },
    async advance(ms) {
      if (options.advanceTimers) await options.advanceTimers(ms);
      else await new Promise((resolve) => realSetTimeout(resolve, ms));
    },
    async restart(restartOptions = {}) {
      if (restartOptions.crash) {
        const files = await storage.list({ includeHidden: true });
        const copy: Record<string, string> = {};
        for (const entry of files) {
          const file = await storage.read(entry.path);
          if (file) copy[entry.path] = file.content;
        }
        const previous = runtime;
        storage = new MemoryStorageProvider({ initialFiles: copy });
        await previous.stop();
      } else {
        await runtime.stop();
      }
      runtime = await build();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await runtime.stop();
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    },
  };
  return fake;
}

/** The distinct prompts (latest user message) of one role's decisions, in first-seen order. */
function distinctPrompts(
  brain: FakeBrain,
  role: "orchestrator" | "subagent",
  accept: (text: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const decision of brain.decisions) {
    if (decision.role !== role) continue;
    for (const message of decision.request.messages) {
      if (message.role !== "user" || !accept(message.content) || seen.has(message.content))
        continue;
      seen.add(message.content);
      out.push(message.content);
    }
  }
  return out;
}

function createAudit(execution: FakeExecution): ToolAudit {
  const gate: GateRecord[] = [];
  const executions: ExecutionRecord[] = [];
  const brainCalls: ScriptToolEvent[] = [];
  return {
    gate,
    executions,
    brainCalls,
    ungated() {
      const problems: Array<{ toolName: string; toolCallId?: string; reason: string }> = [];
      for (const record of executions) {
        if (!record.gated) {
          problems.push({
            toolName: record.toolName,
            toolCallId: record.toolCallId,
            reason: "executed without a gate allow",
          });
        }
      }
      const allowedShell = gate.filter(
        (g) => g.toolName === "bash" && g.decision?.allow === true,
      ).length;
      if (execution.commands.length > allowedShell) {
        problems.push({
          toolName: "bash",
          reason: `${execution.commands.length} shell commands ran but only ${allowedShell} bash calls were allowed`,
        });
      }
      for (const call of brainCalls) {
        if (!call.toolCallId) continue;
        const record = gate.find((g) => g.toolCallId === call.toolCallId);
        if (!record)
          problems.push({
            toolName: call.name,
            toolCallId: call.toolCallId,
            reason: "reached the harness without a gate record",
          });
        else if (call.outcome !== "blocked" && record.decision?.allow !== true) {
          problems.push({
            toolName: call.name,
            toolCallId: call.toolCallId,
            reason: "ran although the gate did not allow it",
          });
        }
      }
      return problems;
    },
  };
}

/** Wraps every ToolSpec a session gets so each execution is checked against the gate records. */
function auditHarness(inner: Harness, audit: ToolAudit): Harness {
  return {
    name: inner.name,
    createSession(sessionOptions) {
      const tools = sessionOptions.tools.map((spec) => ({
        ...spec,
        execute: (input: unknown, ctx: Parameters<typeof spec.execute>[1]) => {
          const gated = audit.gate.some(
            (g) =>
              g.toolCallId === ctx.toolCallId &&
              g.sessionId === sessionOptions.sessionId &&
              g.decision?.allow === true,
          );
          audit.executions.push({
            seq: audit.executions.length + 1,
            sessionId: sessionOptions.sessionId,
            toolCallId: ctx.toolCallId,
            toolName: spec.name,
            gated,
          });
          return spec.execute(input, ctx);
        },
      }));
      return inner.createSession({ ...sessionOptions, tools });
    },
  };
}
