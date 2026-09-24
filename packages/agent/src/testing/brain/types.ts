/**
 * The model-facing view shared by every way of driving the fake brain: the OpenAI-compatible HTTP
 * fake (what OpenRouter would receive), the in-process ScriptedHarness script and the in-process
 * `LlmClient`. A brain maps one `BrainRequest` to one `AssistantTurn`.
 */
import type { JsonSchema } from "@ddl/core";

export interface BrainTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface BrainToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them (may be invalid JSON). */
  arguments: string;
}

export type BrainMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning?: string; toolCalls: BrainToolCall[] }
  /** `content` is what the model sees; tool errors read "Error: …", gate blocks "Blocked by safety policy: …". */
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface BrainResponseFormat {
  type: "json_schema";
  name: string;
  schema: JsonSchema;
  strict?: boolean;
}

export interface BrainPlugin {
  id: string;
  max_results?: number;
}

export interface BrainRequest {
  model: string;
  /** System prompt(s), concatenated. */
  system: string;
  /** The conversation without system messages, oldest first. */
  messages: BrainMessage[];
  tools: BrainTool[];
  responseFormat?: BrainResponseFormat;
  plugins?: BrainPlugin[];
  /** OpenRouter reasoning effort (`none` disables reasoning). */
  reasoning?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TurnToolCall {
  name: string;
  /** Serialized as JSON; a string is sent verbatim (use it for malformed arguments). */
  arguments: unknown;
  /** Assigned by the transport when absent. */
  id?: string;
}

export interface UrlCitation {
  url: string;
  title?: string;
  content?: string;
}

export interface AssistantTurn {
  reasoning?: string;
  text?: string;
  toolCalls?: TurnToolCall[];
  /** `url_citation` annotations (web plugin responses). */
  citations?: UrlCitation[];
  /** The model call fails: the in-process run errors; over HTTP this becomes an error response. */
  error?: { message: string; status?: number };
  /** Never answer; the caller has to abort (turn timeouts, cancellation mid-request). */
  hang?: boolean;
  finishReason?: "stop" | "tool_calls" | "length";
}

export type BrainRole = "orchestrator" | "subagent" | "judge" | "web_search" | "json" | "generic";

/** Derived facts about a request, handed to rules so they don't have to re-parse it. */
export interface TurnInfo {
  role: BrainRole;
  /** Text of the latest user message. */
  lastUserText: string;
  /** Tool calls the assistant made after the latest user message, with what the model saw. */
  callsSinceUser: Array<{ name: string; args: unknown; result?: string }>;
  toolNames: ReadonlySet<string>;
}

export type BrainMatcher = BrainRole | ((request: BrainRequest, info: TurnInfo) => boolean);

export type TurnSource = "rule" | "queue" | "fault" | "policy";

export interface BrainDecision {
  role: BrainRole;
  source: TurnSource;
  /** Name of the rule or fault that produced the turn, if any. */
  label?: string;
  request: BrainRequest;
  turn: AssistantTurn;
}
