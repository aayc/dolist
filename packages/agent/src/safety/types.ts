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
  ApprovalPolicy,
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
  /** `$DDL_HOME`: the app's config, keys and state live there; writing them is a hard deny. */
  appHome?: string;
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
  /**
   * The app a computer action targets (its normalized real name, else the model's words). Standing
   * grants are scoped to it; calls without a target (everything else) match grants without one.
   */
  target?: string;
  /**
   * The action changes something (false for reads, searches and the agent's thread tools). The
   * `ask_every_action` policy asks before effectful actions the evaluator allows; a verdict
   * without it counts as effectful.
   */
  effectful?: boolean;
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
  /** See `SafetyVerdict.target`; a grant made from this approval is scoped to it. */
  target?: string;
  /**
   * The evaluator's decision behind the ask: `allow` when only the approval policy asks (ask
   * before every action). Absent means `require_approval`.
   */
  verdict?: AskedVerdict;
}

/** Why an approval was asked: the evaluator wanted it, or it allowed it and the policy asks. */
export type AskedVerdict = Exclude<SafetyDecision, "deny">;

/** A pending approval, with what `approvePending` decides on. */
export interface PendingApproval {
  request: ApprovalRequest;
  verdict: AskedVerdict;
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
  /**
   * Categories of the approved action. When set, the grant only covers later calls whose
   * categories are all in this list (approving "Submit" does not pre-approve "Place order").
   */
  categories?: ActionCategory[];
  /** Risk of the approved action; the grant does not cover riskier calls. */
  risk?: RiskLevel;
  /**
   * The app the approved action targeted (normalized name). A grant only covers calls with the
   * same target; one without a target only covers calls without one (screen-level, non-computer).
   */
  target?: string;
}

/** What `findGrant` matches on; `categories`/`risk` narrow the match to what the user approved. */
export interface GrantQuery extends Pick<ActionContext, "toolName" | "taskId"> {
  categories?: ActionCategory[];
  risk?: RiskLevel;
  target?: string;
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
  /** `$DDL_HOME` (see `ActionContext.appHome`). */
  appHome?: string;
  /**
   * The user's approval policy, read on every call so a change applies to the next one. Default
   * `ask_risky`; a value that isn't a policy also counts as `ask_risky`.
   */
  approvalPolicy?(): ApprovalPolicy;
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
  findGrant(ctx: GrantQuery): ApprovalGrant | undefined;
  /** Cancels (denies) every pending approval for a task, e.g. when the user deletes the task. */
  cancelForTask(taskId: string, reason: string): void;
  /**
   * Approves once, with `note`, every pending approval `approves` accepts (e.g. the ones a looser
   * approval policy allows). Returns the approvals it approved.
   */
  approvePending(approves: (pending: PendingApproval) => boolean, note: string): ApprovalRequest[];
  onUpsert(listener: (approval: ApprovalRequest) => void): Unsubscribe;
}
