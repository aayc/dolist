/**
 * Safety policy defaults and resolution, decision/risk ordering, and the static knowledge the
 * evaluator has about canonical tools (which ones are internal, built-in hints).
 */
import type { ActionCategory, RiskLevel, SafetyDecision, ToolSafetyHints } from "@ddl/core";
import { TOOL } from "../tools/contracts";
import type { SafetyPolicy } from "./types";

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
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
];

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

export const SAFETY_DECISIONS: readonly SafetyDecision[] = ["allow", "require_approval", "deny"];

/**
 * `privacy` is the one addition to the initial stub: the rules already require approval for
 * sharing personal data, and listing the category here makes the policy (and LLM-judge verdicts
 * tagged `privacy`) agree with them.
 */
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  alwaysAllowTools: [],
  alwaysDenyTools: [],
  requireApprovalTools: [],
  approvalCategories: [
    "payment",
    "booking",
    "communication",
    "publishing",
    "account",
    "credentials",
    "privacy",
    "destructive",
    "computer_control",
    "system",
  ],
  denyCategories: [],
  llmJudge: true,
  llmJudgeTimeoutMs: 8000,
};

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function categoryList(value: unknown): ActionCategory[] | undefined {
  return stringList(value)?.filter((v): v is ActionCategory =>
    (ACTION_CATEGORIES as readonly string[]).includes(v),
  );
}

/** Merges overrides into the defaults, ignoring malformed values instead of trusting them. */
export function resolvePolicy(overrides: Partial<SafetyPolicy> = {}): SafetyPolicy {
  const d = DEFAULT_SAFETY_POLICY;
  const timeout = overrides.llmJudgeTimeoutMs;
  return {
    alwaysAllowTools: stringList(overrides.alwaysAllowTools) ?? d.alwaysAllowTools,
    alwaysDenyTools: stringList(overrides.alwaysDenyTools) ?? d.alwaysDenyTools,
    requireApprovalTools: stringList(overrides.requireApprovalTools) ?? d.requireApprovalTools,
    approvalCategories: categoryList(overrides.approvalCategories) ?? d.approvalCategories,
    denyCategories: categoryList(overrides.denyCategories) ?? d.denyCategories,
    llmJudge: typeof overrides.llmJudge === "boolean" ? overrides.llmJudge : d.llmJudge,
    llmJudgeTimeoutMs:
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? Math.round(timeout)
        : d.llmJudgeTimeoutMs,
  };
}

const DECISION_RANK: Record<SafetyDecision, number> = { allow: 0, require_approval: 1, deny: 2 };
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function stricterDecision(a: SafetyDecision, b: SafetyDecision): SafetyDecision {
  return DECISION_RANK[b] > DECISION_RANK[a] ? b : a;
}

export function maxRisk(...levels: RiskLevel[]): RiskLevel {
  let out: RiskLevel = "low";
  for (const level of levels) if (RISK_RANK[level] > RISK_RANK[out]) out = level;
  return out;
}

export function riskRank(level: RiskLevel): number {
  return RISK_RANK[level];
}

/** Orchestrator ↔ thread plumbing: effects stay inside the app and are visible to the user. */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  TOOL.postUpdate,
  TOOL.postComment,
  TOOL.askUser,
  TOOL.createArtifact,
  TOOL.finishTask,
  TOOL.setTaskStatus,
  TOOL.listTasks,
  TOOL.spawnSubagent,
  TOOL.messageSubagent,
  TOOL.cancelSubagent,
]);

/** Local, read-only knowledge tools. */
export const KNOWLEDGE_TOOLS: ReadonlySet<string> = new Set([TOOL.readNote, TOOL.searchNotes]);

const BUILTIN_HINTS: ReadonlyMap<string, ToolSafetyHints> = new Map<string, ToolSafetyHints>([
  [TOOL.read, { readOnly: true, category: "read" }],
  [TOOL.grep, { readOnly: true, category: "read" }],
  [TOOL.find, { readOnly: true, category: "read" }],
  [TOOL.ls, { readOnly: true, category: "read" }],
  [TOOL.write, { category: "file_write" }],
  [TOOL.edit, { category: "file_write" }],
  // Every command is analyzed by the shell rules; the category only describes the tool.
  [TOOL.bash, { category: "system" }],
]);

/** Safety hints for harness built-ins (bash/read/write/edit/grep/find/ls), which have no ToolSpec. */
export function builtinToolHints(toolName: string): ToolSafetyHints | undefined {
  const hints = BUILTIN_HINTS.get(toolName);
  return hints ? { ...hints } : undefined;
}
