/**
 * Public API of the safety module. (Initial stubs — replaced by the real implementation.)
 */
import type { ToolSafetyHints } from "@ddl/core";
import type {
  ApprovalBroker,
  ApprovalBrokerOptions,
  SafetyEvaluator,
  SafetyEvaluatorOptions,
  SafetyGate,
  SafetyGateOptions,
  SafetyPolicy,
} from "./types";

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
    "destructive",
    "computer_control",
    "system",
  ],
  denyCategories: [],
  llmJudge: true,
  llmJudgeTimeoutMs: 8000,
};

export function createSafetyEvaluator(_options: SafetyEvaluatorOptions = {}): SafetyEvaluator {
  throw new Error("createSafetyEvaluator: not implemented yet");
}

export function createApprovalBroker(_options: ApprovalBrokerOptions = {}): ApprovalBroker {
  throw new Error("createApprovalBroker: not implemented yet");
}

export function createSafetyGate(_options: SafetyGateOptions): SafetyGate {
  throw new Error("createSafetyGate: not implemented yet");
}

/** Safety hints for harness built-ins (bash/read/write/edit/grep/find/ls), which have no ToolSpec. */
export function builtinToolHints(_toolName: string): ToolSafetyHints | undefined {
  return undefined;
}
