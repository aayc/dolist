import type { Logger } from "@ddl/core";
import { errorMessage, isRecord, raceAbort } from "@ddl/core";
import type { ToolCallDecision, ToolCallRequest } from "./types";

/**
 * Asks `beforeToolCall` (the safety gate) about one call and fails closed: a throwing, malformed
 * or aborted decision blocks the call. Every harness routes its tool calls through this.
 */
export async function decideGate(
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>,
  request: ToolCallRequest,
  signal: AbortSignal | undefined,
  logger?: Logger,
): Promise<ToolCallDecision> {
  try {
    const decision: unknown = await raceAbort(
      Promise.resolve().then(() => beforeToolCall(request)),
      signal,
    );
    if (isRecord(decision) && decision.allow === true) return { allow: true };
    const reason = isRecord(decision) && typeof decision.reason === "string" ? decision.reason : "";
    return { allow: false, reason: reason || "denied" };
  } catch (error) {
    if (signal?.aborted) return { allow: false, reason: "the run was aborted" };
    logger?.warn("safety gate threw; blocking tool call", {
      tool: request.toolName,
      error: errorMessage(error),
    });
    return { allow: false, reason: "the safety check failed" };
  }
}
