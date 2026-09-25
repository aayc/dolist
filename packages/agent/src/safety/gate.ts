/**
 * The safety gate: plugged into `HarnessSessionOptions.beforeToolCall`, it evaluates every tool
 * call, blocks denials under every approval policy, lets the policy decide which other verdicts
 * ask the user, honors standing grants for those, and otherwise asks through the approval broker.
 * It never throws; any internal failure blocks the call.
 */
import { silentLogger } from "@ddl/core";
import type { ToolCallDecision, ToolCallRequest } from "../harness/types";
import {
  EVERY_ACTION_REASON,
  effectivePolicy,
  POLICY_ALLOW_REASONS,
  policyAsks,
} from "./approval-policy";
import { redactActionInput } from "./describe";
import { builtinToolHints } from "./policy";
import type {
  ActionContext,
  AllowedCall,
  ApprovalOutcome,
  SafetyGate,
  SafetyGateOptions,
  SafetyVerdict,
} from "./types";

function denialReason(outcome: ApprovalOutcome): string {
  const note = outcome.note ?? outcome.request.decisionNote;
  switch (outcome.request.status) {
    case "denied":
      return note ? `User denied: ${note}` : "User denied";
    case "expired":
      return "Approval expired";
    case "cancelled":
      return note ? `Approval cancelled: ${note}` : "Approval cancelled";
    default:
      return note ? `Not approved: ${note}` : "Not approved";
  }
}

export function createSafetyGate(options: SafetyGateOptions): SafetyGate {
  const logger = options.logger ?? silentLogger;

  const observe = (call: ToolCallRequest, verdict: SafetyVerdict) => {
    try {
      options.onVerdict?.(call, verdict);
    } catch (error) {
      logger.warn("onVerdict listener failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return async (call: ToolCallRequest): Promise<ToolCallDecision> => {
    try {
      const context = options.resolveContext(call.sessionId);
      const ctx: ActionContext = {
        toolName: call.toolName,
        ...(call.spec?.label ? { toolLabel: call.spec.label } : {}),
        input: call.input,
        hints: call.spec?.safety ?? builtinToolHints(call.toolName) ?? {},
        role: call.role,
        taskId: context.taskId,
        threadId: context.threadId,
        ...(context.taskText ? { taskText: context.taskText } : {}),
        ...(context.rationale ? { rationale: context.rationale } : {}),
        ...(context.workspaceDir ? { workspaceDir: context.workspaceDir } : {}),
        ...(options.appHome ? { appHome: options.appHome } : {}),
      };
      const evaluated = await options.evaluator.evaluate(ctx);

      if (evaluated.decision === "deny") {
        observe(call, evaluated);
        return { allow: false, reason: evaluated.reason };
      }
      const allowed = (via: AllowedCall["via"], approvalId?: string): ToolCallDecision => {
        try {
          options.onAllowed?.(call, {
            summary: evaluated.summary,
            via,
            ...(approvalId ? { approvalId } : {}),
            effectful: evaluated.effectful !== false,
          });
        } catch (error) {
          logger.warn("onAllowed listener failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { allow: true };
      };
      const policy = effectivePolicy(options.approvalPolicy?.());
      if (!policyAsks(policy, { ...evaluated, decision: evaluated.decision })) {
        observe(
          call,
          evaluated.decision === "allow"
            ? evaluated
            : {
                ...evaluated,
                decision: "allow",
                source: "policy",
                reason: POLICY_ALLOW_REASONS[policy] ?? evaluated.reason,
              },
        );
        return allowed(evaluated.decision === "allow" ? "evaluator" : "policy");
      }
      const verdict: SafetyVerdict =
        evaluated.decision === "allow"
          ? {
              ...evaluated,
              decision: "require_approval",
              source: "policy",
              reason: EVERY_ACTION_REASON,
            }
          : evaluated;

      const grant = options.approvals.findGrant({
        toolName: ctx.toolName,
        taskId: ctx.taskId,
        categories: verdict.categories,
        risk: verdict.risk,
        ...(verdict.target ? { target: verdict.target } : {}),
      });
      if (grant) {
        observe(call, {
          ...verdict,
          decision: "allow",
          source: "grant",
          reason:
            grant.scope === "always"
              ? grant.target
                ? "You always allow actions like this in this app."
                : `You always allow this kind of ${ctx.toolName} action.`
              : grant.target
                ? "You approved actions like this in this app for this task."
                : `You approved this kind of ${ctx.toolName} action for this task.`,
        });
        return allowed("grant");
      }

      observe(call, verdict);
      const outcome = await options.approvals.request({
        threadId: ctx.threadId,
        taskId: ctx.taskId,
        toolName: ctx.toolName,
        ...(ctx.toolLabel ? { toolLabel: ctx.toolLabel } : {}),
        input: redactActionInput(ctx),
        summary: verdict.summary,
        risk: verdict.risk,
        categories: verdict.categories,
        reason: verdict.reason,
        ...(options.approvalTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.approvalTimeoutMs }),
        ...(verdict.target ? { target: verdict.target } : {}),
        verdict: evaluated.decision,
      });
      return outcome.approved
        ? allowed("approval", outcome.request.id)
        : { allow: false, reason: denialReason(outcome) };
    } catch (error) {
      logger.error("safety gate failed", {
        tool: call.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { allow: false, reason: "The safety check failed, so this action was blocked." };
    }
  };
}
