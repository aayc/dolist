/**
 * Public API of the safety module: an independent evaluator for every tool call, the approval
 * broker, and the gate that plugs both into the harness. See README.md for the pipeline.
 */

export { APPROVALS_STATE_PATH } from "./approval-store";
export type { PersistentApprovalBroker } from "./approvals";
export { ApprovalNotFoundError, ApprovalStateError, createApprovalBroker } from "./approvals";
export { describeAction, redactActionInput } from "./describe";
export { createSafetyEvaluator } from "./evaluator";
export { createSafetyGate } from "./gate";
export { builtinToolHints, DEFAULT_SAFETY_POLICY, resolvePolicy } from "./policy";
export type { RuleDecision, SafetyRuleInfo } from "./rules";
export { SAFETY_RULES } from "./rules";
export { luhnValid, maskSensitiveText, redactSensitiveInput } from "./sensitive";
export type * from "./types";
