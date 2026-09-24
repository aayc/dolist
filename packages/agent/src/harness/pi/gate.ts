/**
 * The safety gate as a Pi extension: Pi routes every tool call (built-in and custom) through the
 * `tool_call` hook after argument validation and before execution.
 */
import type { Logger, ToolSpec } from "@ddl/core";
import type {
  ExtensionContext,
  InlineExtension,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { decideGate } from "../gate-decision";
import type { AgentRole, ToolCallDecision, ToolCallRequest } from "../types";
import type { ToolCallLedger } from "./ledger";

export const GATE_EXTENSION_NAME = "ddl-safety-gate";
export const GATE_EXTENSION_PATH = `<inline:${GATE_EXTENSION_NAME}>`;

export interface GateOptions {
  sessionId: string;
  role: AgentRole;
  specs: ReadonlyMap<string, ToolSpec>;
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  ledger: ToolCallLedger;
  /** Calls arriving after the session closed are blocked without consulting the gate. */
  isClosed: () => boolean;
  /** Invoked when Pi has loaded the extension and the hook is registered. */
  onInstalled: () => void;
  logger?: Logger;
}

export function createGateExtension(options: GateOptions): InlineExtension {
  return {
    name: GATE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event, ctx) => decideToolCall(event, ctx, options));
      options.onInstalled();
    },
  };
}

export async function decideToolCall(
  event: Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">,
  ctx: Partial<Pick<ExtensionContext, "signal">>,
  options: GateOptions,
): Promise<ToolCallEventResult | undefined> {
  const { ledger, logger } = options;
  const decision = options.isClosed()
    ? { allow: false as const, reason: "the agent session was closed" }
    : await askGate(event, ctx.signal, options);
  if (decision.allow) {
    ledger.approve(event.toolCallId);
    return undefined;
  }
  ledger.block(event.toolCallId, decision.reason);
  logger?.debug("tool call blocked", { tool: event.toolName, toolCallId: event.toolCallId });
  return { block: true, reason: `Blocked by safety policy: ${decision.reason}` };
}

function askGate(
  event: Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">,
  signal: AbortSignal | undefined,
  options: GateOptions,
): Promise<ToolCallDecision> {
  const spec = options.specs.get(event.toolName);
  const request: ToolCallRequest = {
    sessionId: options.sessionId,
    role: options.role,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    ...(spec ? { spec } : {}),
  };
  return decideGate(options.beforeToolCall, request, signal, options.logger);
}
