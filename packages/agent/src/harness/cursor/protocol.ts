/**
 * The subset of the Agent Client Protocol (ACP, protocol version 1) this harness speaks with the
 * Cursor CLI (`agent acp`), with parsers for everything the CLI sends: its output is external
 * input and is validated before use.
 */

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpModel {
  modelId: string;
  name: string;
}

export interface AcpSessionModels {
  currentModelId: string | undefined;
  availableModels: AcpModel[];
}

export interface AcpInitializeResult {
  protocolVersion: number;
  loadSession: boolean;
  mcpHttp: boolean;
  /** The agent takes images (`promptCapabilities.image`); assumed unless the CLI says it doesn't. */
  images: boolean;
}

export interface AcpSessionResult {
  sessionId: string;
  models: AcpSessionModels;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpLocation {
  path: string;
}

/** One `tool_call` / `tool_call_update` notification (only the fields this harness reads). */
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: AcpLocation[];
}

export type AcpSessionUpdate =
  | { type: "agent_message_chunk"; text: string }
  | { type: "agent_thought_chunk"; text: string }
  | { type: "tool_call"; call: AcpToolCallUpdate }
  | { type: "tool_call_update"; call: AcpToolCallUpdate }
  | { type: "other"; name: string };

export interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export interface AcpHttpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export function parseInitializeResult(value: unknown): AcpInitializeResult {
  const record = asRecord(value, "initialize result");
  const capabilities = isRecord(record.agentCapabilities) ? record.agentCapabilities : {};
  const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
  const prompt = isRecord(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
  return {
    protocolVersion: typeof record.protocolVersion === "number" ? record.protocolVersion : 0,
    loadSession: capabilities.loadSession === true,
    mcpHttp: mcp.http === true,
    images: prompt.image !== false,
  };
}

export function parseSessionResult(value: unknown, sessionId?: string): AcpSessionResult {
  const record = asRecord(value, "session result");
  const id = sessionId ?? record.sessionId;
  if (typeof id !== "string" || !id) throw new Error("The Cursor CLI returned no session id");
  return { sessionId: id, models: parseModels(record.models) };
}

export function parseModels(value: unknown): AcpSessionModels {
  const record = isRecord(value) ? value : {};
  const available = Array.isArray(record.availableModels) ? record.availableModels : [];
  return {
    currentModelId: typeof record.currentModelId === "string" ? record.currentModelId : undefined,
    availableModels: available.flatMap((model): AcpModel[] =>
      isRecord(model) && typeof model.modelId === "string" && model.modelId
        ? [
            {
              modelId: model.modelId,
              name: typeof model.name === "string" ? model.name : model.modelId,
            },
          ]
        : [],
    ),
  };
}

export function parseStopReason(value: unknown): AcpStopReason | string {
  const record = isRecord(value) ? value : {};
  return typeof record.stopReason === "string" ? record.stopReason : "end_turn";
}

/** `session/update` params → the update, or undefined when it's for another session. */
export function parseSessionUpdate(
  params: unknown,
  sessionId: string,
): AcpSessionUpdate | undefined {
  if (!isRecord(params) || params.sessionId !== sessionId || !isRecord(params.update)) {
    return undefined;
  }
  const update = params.update;
  const name = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  switch (name) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = isRecord(update.content) ? update.content : {};
      const text = content.type === "text" && typeof content.text === "string" ? content.text : "";
      return { type: name, text };
    }
    case "tool_call":
    case "tool_call_update": {
      const call = parseToolCall(update);
      return call ? { type: name, call } : { type: "other", name };
    }
    default:
      return { type: "other", name };
  }
}

function parseToolCall(update: Record<string, unknown>): AcpToolCallUpdate | undefined {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return undefined;
  const call: AcpToolCallUpdate = { toolCallId: update.toolCallId };
  if (typeof update.title === "string") call.title = update.title;
  if (typeof update.kind === "string") call.kind = update.kind;
  if (typeof update.status === "string") call.status = update.status;
  if ("rawInput" in update) call.rawInput = update.rawInput;
  if ("rawOutput" in update) call.rawOutput = update.rawOutput;
  if (Array.isArray(update.content)) call.content = update.content;
  if (Array.isArray(update.locations)) {
    call.locations = update.locations.flatMap((l): AcpLocation[] =>
      isRecord(l) && typeof l.path === "string" ? [{ path: l.path }] : [],
    );
  }
  return call;
}

export function parsePermissionRequest(params: unknown): AcpPermissionRequest | undefined {
  if (!isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.toolCall)) {
    return undefined;
  }
  const toolCall = params.toolCall;
  if (typeof toolCall.toolCallId !== "string") return undefined;
  const options = Array.isArray(params.options) ? params.options : [];
  return {
    sessionId: params.sessionId,
    toolCallId: toolCall.toolCallId,
    title: typeof toolCall.title === "string" ? toolCall.title : "",
    kind: typeof toolCall.kind === "string" ? toolCall.kind : "",
    options: options.flatMap((o): AcpPermissionOption[] =>
      isRecord(o) && typeof o.optionId === "string" && typeof o.kind === "string"
        ? [{ optionId: o.optionId, kind: o.kind }]
        : [],
    ),
  };
}

/** Picks the one-time option (never an "always" one); cancelled when none fits. */
export function permissionOutcome(
  request: Pick<AcpPermissionRequest, "options">,
  allow: boolean,
): AcpPermissionOutcome {
  const option = request.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export const CANCELLED_PERMISSION: AcpPermissionOutcome = { outcome: { outcome: "cancelled" } };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`The Cursor CLI sent an invalid ${what}`);
  return value;
}
