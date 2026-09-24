/**
 * Test doubles for modules built in parallel (safety, execution) and small test utilities.
 * The fake gate mirrors the documented SafetyGate contract: evaluate → allow | ask | deny.
 */
import {
  type ActionCategory,
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type ApprovalStatus,
  type AppSettings,
  createId,
  DEFAULT_SETTINGS,
  type DeepPartial,
  mergeSettings,
  type Unsubscribe,
} from "@ddl/core";
import type {
  ExecutionProvider,
  ShellExecOptions,
  ShellResult,
  Workspace,
} from "../../src/execution/types";
import type { AgentRuntimeOverrides } from "../../src/runtime";
import type {
  ApprovalBroker,
  ApprovalGrant,
  ApprovalOutcome,
  NewApproval,
  SafetyEvaluator,
  SafetyGate,
  SafetyGateOptions,
  SafetyVerdict,
} from "../../src/safety/types";

const APPROVAL_CATEGORIES: readonly ActionCategory[] = [
  "payment",
  "booking",
  "communication",
  "publishing",
  "account",
  "credentials",
  "destructive",
];

export class FakeApprovalBroker implements ApprovalBroker {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<string, (outcome: ApprovalOutcome) => void>();
  private readonly listeners = new Set<(approval: ApprovalRequest) => void>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  request(input: NewApproval, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const approval: ApprovalRequest = {
      id: createId("apr"),
      threadId: input.threadId,
      taskId: input.taskId,
      toolName: input.toolName,
      input: input.input,
      summary: input.summary,
      risk: input.risk,
      categories: input.categories,
      reason: input.reason,
      status: "pending",
      createdAt: this.now(),
    };
    this.approvals.set(approval.id, approval);
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.waiters.set(approval.id, resolve);
    });
    signal?.addEventListener("abort", () => this.finish(approval.id, "cancelled"), { once: true });
    this.emit(approval);
    return outcome;
  }

  async decide(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    if (this.approvals.get(id)?.status !== "pending") {
      throw new Error(`Approval ${id} is not pending`);
    }
    return this.finish(id, decision.decision === "approve" ? "approved" : "denied", decision.note);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  list(filter: { status?: ApprovalStatus; threadId?: string; taskId?: string } = {}) {
    return [...this.approvals.values()].filter(
      (a) =>
        (filter.status === undefined || a.status === filter.status) &&
        (filter.threadId === undefined || a.threadId === filter.threadId) &&
        (filter.taskId === undefined || a.taskId === filter.taskId),
    );
  }

  findGrant(): ApprovalGrant | undefined {
    return undefined;
  }

  cancelForTask(taskId: string, reason: string): void {
    for (const approval of this.list({ taskId, status: "pending" })) {
      this.finish(approval.id, "cancelled", reason);
    }
  }

  onUpsert(listener: (approval: ApprovalRequest) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finish(id: string, status: ApprovalStatus, note?: string): ApprovalRequest {
    const current = this.approvals.get(id)!;
    if (current.status !== "pending") return current;
    const updated: ApprovalRequest = {
      ...current,
      status,
      decidedAt: this.now(),
      ...(note ? { decisionNote: note } : {}),
    };
    this.approvals.set(id, updated);
    this.emit(updated);
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.({ approved: status === "approved", request: updated, ...(note ? { note } : {}) });
    return updated;
  }

  private emit(approval: ApprovalRequest): void {
    for (const listener of [...this.listeners]) listener(approval);
  }
}

/** Rules-only evaluator: approval for irreversible categories or `alwaysRequireApproval`. */
export function createFakeEvaluator(): SafetyEvaluator {
  return {
    async evaluate(ctx): Promise<SafetyVerdict> {
      const category = ctx.hints.category ?? "unknown";
      const ask =
        ctx.hints.alwaysRequireApproval === true || APPROVAL_CATEGORIES.includes(category);
      return {
        decision: ask ? "require_approval" : "allow",
        risk: ask ? "high" : "low",
        categories: [category],
        reason: ask ? "Irreversible action" : "Low risk",
        summary: ctx.hints.describe?.(ctx.input) ?? ctx.toolName,
        source: "rules",
        latencyMs: 0,
      };
    },
  };
}

export interface GateLog {
  calls: Array<{
    sessionId: string;
    toolName: string;
    taskId: string | null;
    threadId: string | null;
  }>;
}

export function createFakeGate(options: SafetyGateOptions, log?: GateLog): SafetyGate {
  return async (call) => {
    const ctx = options.resolveContext(call.sessionId);
    log?.calls.push({
      sessionId: call.sessionId,
      toolName: call.toolName,
      taskId: ctx.taskId,
      threadId: ctx.threadId,
    });
    const verdict = await options.evaluator.evaluate({
      toolName: call.toolName,
      input: call.input,
      hints: call.spec?.safety ?? {},
      role: call.role,
      taskId: ctx.taskId,
      threadId: ctx.threadId,
    });
    options.onVerdict?.(call, verdict);
    if (verdict.decision === "allow") return { allow: true };
    if (verdict.decision === "deny") return { allow: false, reason: verdict.reason };
    const outcome = await options.approvals.request({
      threadId: ctx.threadId,
      taskId: ctx.taskId,
      toolName: call.toolName,
      input: call.input,
      summary: verdict.summary,
      risk: verdict.risk,
      categories: verdict.categories,
      reason: verdict.reason,
    });
    if (outcome.approved) return { allow: true };
    return {
      allow: false,
      reason:
        outcome.request.status === "denied"
          ? "The user denied this action."
          : `Approval ${outcome.request.status}.`,
    };
  };
}

export interface FakeSafety {
  overrides: AgentRuntimeOverrides;
  broker: () => FakeApprovalBroker;
  log: GateLog;
}

/** Overrides that replace the (possibly still stubbed) safety module with the fakes above. */
export function fakeSafety(extra: AgentRuntimeOverrides = {}): FakeSafety {
  let broker: FakeApprovalBroker | undefined;
  const log: GateLog = { calls: [] };
  return {
    log,
    broker: () => {
      if (!broker) throw new Error("broker not created yet");
      return broker;
    },
    overrides: {
      createApprovalBroker: (opts) => {
        broker = new FakeApprovalBroker(opts.now);
        return broker;
      },
      createSafetyEvaluator: () => createFakeEvaluator(),
      createSafetyGate: (opts) => createFakeGate(opts, log),
      createExecutionTools: () => [],
      createWebTools: () => [],
      batchWindowMs: 5,
      reportDelayMs: 5,
      mockWordDelayMs: 0,
      ...extra,
    },
  };
}

export interface FakeExecution extends ExecutionProvider {
  workspaces: string[];
  disposed: boolean;
}

export function createFakeExecution(
  capabilities: Partial<ExecutionProvider["capabilities"]> = {},
): FakeExecution {
  const execution: FakeExecution = {
    id: "fake",
    capabilities: { shell: true, browser: false, computer: false, ...capabilities },
    workspaces: [],
    disposed: false,
    shell: {
      async exec(command: string, _options: ShellExecOptions): Promise<ShellResult> {
        return {
          exitCode: 0,
          output: `ran: ${command}`,
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
    async prepareWorkspace(key: string): Promise<Workspace> {
      execution.workspaces.push(key);
      return { key, dir: `/tmp/ddl-test-workspaces/${key}` };
    },
    async dispose() {
      execution.disposed = true;
    },
  };
  return execution;
}

export function testSettings(patch: DeepPartial<AppSettings> = {}): AppSettings {
  return mergeSettings(
    mergeSettings(DEFAULT_SETTINGS, {
      agent: { settleMs: 20, maxConcurrentSubagents: 3, actOnExistingTasks: true },
    }),
    patch,
  );
}

export interface Gate {
  promise: Promise<void>;
  open(): void;
}

/** Controllable promise for pausing scripted agents mid-run. */
export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
