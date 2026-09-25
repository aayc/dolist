/**
 * The user's approval policy, applied by the gate to the evaluator's verdicts. The evaluator
 * decides what an action is; the policy only decides whether a verdict that isn't `deny` asks the
 * user first. Nothing here can turn a `deny` into anything else.
 */
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  type RiskLevel,
} from "@ddl/core";
import { riskRank } from "./policy";
import type { AskedVerdict } from "./types";

/** The policy to apply: anything that isn't a known policy counts as the default. */
export function effectivePolicy(value: unknown): ApprovalPolicy {
  return (APPROVAL_POLICIES as readonly unknown[]).includes(value)
    ? (value as ApprovalPolicy)
    : DEFAULT_APPROVAL_POLICY;
}

/** What the policy looks at: the evaluator's decision and risk, and whether the action changes anything. */
export interface PolicyInput {
  decision: AskedVerdict;
  risk: RiskLevel;
  /** Absent counts as effectful. */
  effectful?: boolean;
}

/** Whether `policy` asks the user before an action with this (non-deny) verdict. */
export function policyAsks(policy: ApprovalPolicy, verdict: PolicyInput): boolean {
  switch (policy) {
    case "ask_every_action":
      return verdict.decision === "require_approval" || verdict.effectful !== false;
    case "ask_risky":
      return verdict.decision === "require_approval";
    case "ask_high_risk":
      return verdict.decision === "require_approval" && riskRank(verdict.risk) >= riskRank("high");
    case "run_everything":
      return false;
  }
}

/** `next` allows everything `previous` allows, and more. */
export function isLooserPolicy(next: ApprovalPolicy, previous: ApprovalPolicy): boolean {
  return APPROVAL_POLICIES.indexOf(next) > APPROVAL_POLICIES.indexOf(previous);
}

/** The reason reported when a policy lets a `require_approval` verdict run without asking. */
export const POLICY_ALLOW_REASONS: Partial<Record<ApprovalPolicy, string>> = {
  run_everything: "Your approval policy runs everything without asking.",
  ask_high_risk: "Your approval policy only asks for high-risk actions.",
};

/** The reason on the approval card when only the policy asks (the evaluator allowed it). */
export const EVERY_ACTION_REASON = "Your approval policy asks before every action.";

/** The decision note of pending approvals a looser policy approved. */
export const POLICY_APPROVAL_NOTE = "Approved by your approval policy";
