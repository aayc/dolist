/**
 * The safety gate: plugged into `HarnessSessionOptions.beforeToolCall`, it evaluates every tool
 * call, honors standing grants for `require_approval` verdicts, and otherwise asks the user
 * through the approval broker. It never throws; any internal failure blocks the call.
 */
import { silentLogger } from "@ddl/core";
import type { ToolCallDecision, ToolCallRequest } from "../harness/types";
import { redactActionInput } from "./describe";
import { builtinToolHints } from "./policy";
import type {
  ActionContext,
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
      };
      const verdict = await options.evaluator.evaluate(ctx);

      if (verdict.decision === "allow") {
        observe(call, verdict);
        return { allow: true };
      }
      if (verdict.decision === "deny") {
        observe(call, verdict);
        return { allow: false, reason: verdict.reason };
      }

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
              ? `You always allow this kind of ${ctx.toolName} action.`
              : `You approved this kind of ${ctx.toolName} action for this task.`,
        });
        return { allow: true };
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
      });
      return outcome.approved ? { allow: true } : { allow: false, reason: denialReason(outcome) };
    } catch (error) {
      logger.error("safety gate failed", {
        tool: call.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { allow: false, reason: "The safety check failed, so this action was blocked." };
    }
  };
}
