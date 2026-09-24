import type { ToolResult } from "@ddl/core";

export interface SettledToolCall {
  /** Set when the safety gate blocked the call. */
  blockedReason?: string;
  /** The ToolSpec's own result (custom tools only), before any Pi-side conversion. */
  result?: ToolResult;
}

/**
 * Per-session bookkeeping shared by the safety-gate extension, the tool wrappers and the event
 * mapper, keyed by tool call id. Approvals are single-use: a tool executes only after the gate
 * approved that exact call.
 */
export class ToolCallLedger {
  private readonly approved = new Set<string>();
  private readonly blocked = new Map<string, string>();
  private readonly results = new Map<string, ToolResult>();

  approve(toolCallId: string): void {
    this.approved.add(toolCallId);
  }

  block(toolCallId: string, reason: string): void {
    this.approved.delete(toolCallId);
    this.blocked.set(toolCallId, reason);
  }

  /** True exactly once per approval. */
  consumeApproval(toolCallId: string): boolean {
    return this.approved.delete(toolCallId);
  }

  recordResult(toolCallId: string, result: ToolResult): void {
    this.results.set(toolCallId, result);
  }

  /** Returns and forgets everything known about a finished call. */
  settle(toolCallId: string): SettledToolCall {
    const settled: SettledToolCall = {};
    const reason = this.blocked.get(toolCallId);
    if (reason !== undefined) settled.blockedReason = reason;
    const result = this.results.get(toolCallId);
    if (result !== undefined) settled.result = result;
    this.approved.delete(toolCallId);
    this.blocked.delete(toolCallId);
    this.results.delete(toolCallId);
    return settled;
  }

  clear(): void {
    this.approved.clear();
    this.blocked.clear();
    this.results.clear();
  }
}
