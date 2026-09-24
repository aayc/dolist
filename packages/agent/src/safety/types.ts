/**
 * Safety evaluation is deliberately separate from the agents that propose actions. Every tool call
 * from every agent passes through `SafetyGate` → `SafetyEvaluator` before it executes:
 *
 *   grants/policy → pattern rules → (optional) LLM judge → most-restrictive-wins → fail closed
 *
 * `require_approval` pauses the agent and asks the user via the `ApprovalBroker`.
 */
import type {
  ActionCategory,
  ApprovalDecisionRequest,
  ApprovalRequest,
  ApprovalScope,
  ApprovalStatus,
  Logger,
  RiskLevel,
  SafetyDecision,
  ToolSafetyHints,
  Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { AgentRole, ToolCallDecision, ToolCallRequest } from "../harness/types";
import type { LlmClient } from "../llm/types";

export interface ActionContext {
  toolName: string;
  toolLabel?: string;
  input: unknown;
  hints: ToolSafetyHints;
  role: AgentRole;
  taskId: string | null;
  threadId: string | null;
  /** The to-do item the agent is working on (lets the judge check the action matches intent). */
  taskText?: string;
  /** The agent's most recent explanation of what it is doing, if any. */
  rationale?: string;
  /** Absolute path of the task's scratch workspace; file writes inside it are low risk. */
  workspaceDir?: string;
}

export type VerdictSource = "policy" | "grant" | "rules" | "llm" | "fallback";

export interface SafetyVerdict {
  decision: SafetyDecision;
  risk: RiskLevel;
  categories: ActionCategory[];
  /** Why this decision was reached (shown on approval cards / in denial messages). */
  reason: string;
  /** Human-readable description of the action. */
  summary: string;
  source: VerdictSource;
  matchedRules?: string[];
  latencyMs: number;
}

export interface SafetyEvaluator {
  evaluate(ctx: ActionContext, signal?: AbortSignal): Promise<SafetyVerdict>;
}

export interface SafetyPolicy {
  /** Tools that are always allowed (still subject to `deny` rules). */
  alwaysAllowTools: string[];
  /** Tools that are always denied. */
  alwaysDenyTools: string[];
  /** Tools that always need approval. */
  requireApprovalTools: string[];
  /** Categories that always need approval. */
  approvalCategories: ActionCategory[];
  /** Categories that are denied outright (even with approval). */
  denyCategories: ActionCategory[];
  /** Ask the LLM judge about actions the rules cannot classify. */
  llmJudge: boolean;
  /** Timeout for the LLM judge; on timeout the verdict falls back to `require_approval`. */
  llmJudgeTimeoutMs: number;
}

export interface NewApproval {
  threadId: string | null;
  taskId: string | null;
  toolName: string;
  toolLabel?: string;
  input: unknown;
  summary: string;
  risk: RiskLevel;
  categories: ActionCategory[];
  reason: string;
  timeoutMs?: number;
}

export interface ApprovalOutcome {
  approved: boolean;
  request: ApprovalRequest;
  note?: string;
}

/** A standing permission created when the user approves with scope `task` or `always`. */
export interface ApprovalGrant {
  toolName: string;
  scope: Exclude<ApprovalScope, "once">;
  taskId: string | null;
  createdAt: number;
}

export interface SafetyEvaluatorOptions {
  policy?: Partial<SafetyPolicy>;
  /** Enables the LLM judge layer (when `policy.llmJudge` is true). */
  llm?: LlmClient;
  judgeModel?: string;
  logger?: Logger;
}

export interface ApprovalBrokerOptions {
  /** When set, pending approvals and standing grants persist in `.daily-do-list/state/approvals.json`. */
  storage?: StorageProvider;
  defaultTimeoutMs?: number;
  now?: () => number;
  logger?: Logger;
}

/** What the gate needs to know about the session that is making a tool call. */
export interface GateContext {
  taskId: string | null;
  threadId: string | null;
  taskText?: string;
  rationale?: string;
  workspaceDir?: string;
}

export interface SafetyGateOptions {
  evaluator: SafetyEvaluator;
  approvals: ApprovalBroker;
  /** Maps a harness session id to its task/thread context. */
  resolveContext(sessionId: string): GateContext;
  /** Observe every verdict (logging, annotating the thread's tool-call message). */
  onVerdict?(call: ToolCallRequest, verdict: SafetyVerdict): void;
  approvalTimeoutMs?: number;
  logger?: Logger;
}

/** Plug directly into `HarnessSessionOptions.beforeToolCall`. Never throws; fails closed. */
export type SafetyGate = (call: ToolCallRequest) => Promise<ToolCallDecision>;

export interface ApprovalBroker {
  /** Creates a pending approval and waits for the user's decision (timeout/abort → denied). */
  request(input: NewApproval, signal?: AbortSignal): Promise<ApprovalOutcome>;
  decide(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest>;
  get(id: string): ApprovalRequest | undefined;
  list(filter?: { status?: ApprovalStatus; threadId?: string; taskId?: string }): ApprovalRequest[];
  /** A standing grant that covers this action, if any. */
  findGrant(ctx: Pick<ActionContext, "toolName" | "taskId">): ApprovalGrant | undefined;
  /** Cancels (denies) every pending approval for a task, e.g. when the user deletes the task. */
  cancelForTask(taskId: string, reason: string): void;
  onUpsert(listener: (approval: ApprovalRequest) => void): Unsubscribe;
}
