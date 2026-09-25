/**
 * Runs a FakeBrain in-process through `ScriptedHarness`: each session keeps a transcript, and each
 * prompt loops decide → say / call tools (through the safety gate) → feed results back → decide,
 * until the brain stops calling tools. Tool handling mirrors the Pi harness: unknown tools and
 * arguments that fail the tool's schema are reported to the model without reaching the gate, tool
 * errors read "Error: …", gate blocks "Blocked by safety policy: …", and steering messages are
 * delivered at the next step.
 */
import { type ToolSpec, toolResultText } from "@ddl/core";
import type { AgentScript, ScriptContext, ScriptToolOutcome } from "../harness/scripted";
import type { HarnessSessionOptions, TranscriptEntry } from "../harness/types";
import type { FakeBrain } from "./brain/brain";
import type { BrainMessage, BrainRequest, BrainTool } from "./brain/types";
import { validateJson } from "./json-schema";

export interface ScriptToolEvent {
  sessionId: string;
  role: HarnessSessionOptions["role"];
  /** The brain's id for the call (what the model sees in its transcript). */
  modelCallId: string;
  /** The harness/gate id; absent when the call never reached the gate (unknown tool, bad args). */
  toolCallId?: string;
  name: string;
  input: unknown;
  outcome: "ok" | "error" | "blocked" | "invalid";
  /** What the model saw. */
  content: string;
}

export interface FakeAgentScriptOptions {
  /** Model turns per prompt before the run fails (catches loops). Default 60. */
  maxSteps?: number;
  /** Observes every tool call the brain made (audits, assertions). */
  onToolCall?: (event: ScriptToolEvent) => void;
}

const DEFAULT_MAX_STEPS = 60;

export function createFakeAgentScript(
  brain: FakeBrain,
  options: FakeAgentScriptOptions = {},
): (session: HarnessSessionOptions) => AgentScript {
  return (session) => {
    // A session rebuilt after a restart continues the conversation it was restored with.
    const transcript: BrainMessage[] = (session.transcript ?? []).map(toBrainMessage);
    let callSeq = 0;
    return async (ctx) => {
      transcript.push({ role: "user", content: ctx.message });
      const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
      for (let step = 0; ; step++) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        for (const steer of ctx.takeSteering()) transcript.push({ role: "user", content: steer });
        if (step >= maxSteps)
          throw new Error(`The fake agent made ${maxSteps} model calls without finishing.`);
        const turn = brain.decide(requestFor(session, ctx, transcript));
        if (turn.hang) await untilAborted(ctx.signal);
        if (turn.error) throw new Error(turn.error.message);
        if (turn.text) await ctx.say(turn.text);
        const calls = (turn.toolCalls ?? []).map((call) => ({
          id: call.id ?? `call_${session.sessionId}_${++callSeq}`,
          name: call.name,
          arguments:
            typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments ?? {}),
        }));
        transcript.push({
          role: "assistant",
          content: turn.text ?? "",
          ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
          toolCalls: calls,
        });
        if (calls.length === 0) return;
        for (const call of calls) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          const event = await runCall(ctx, session, call);
          options.onToolCall?.(event);
          transcript.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: event.content,
          });
        }
      }
    };
  };
}

async function runCall(
  ctx: ScriptContext,
  session: HarnessSessionOptions,
  call: { id: string; name: string; arguments: string },
): Promise<ScriptToolEvent> {
  const base = {
    sessionId: session.sessionId,
    role: session.role,
    modelCallId: call.id,
    name: call.name,
  };
  const spec = ctx.tools.find((tool) => tool.name === call.name);
  const input = parseArguments(call.arguments);
  if (!spec) {
    return { ...base, input, outcome: "invalid", content: `Tool ${call.name} not found` };
  }
  const problems = validateJson(spec.parameters, input);
  if (problems.length > 0) {
    return {
      ...base,
      input,
      outcome: "invalid",
      content: validationMessage(spec, problems, input),
    };
  }
  const outcome = await ctx.callTool(call.name, input);
  return {
    ...base,
    input,
    toolCallId: outcome.toolCallId,
    outcome: outcome.blocked ? "blocked" : outcome.result.isError ? "error" : "ok",
    content: modelText(outcome),
  };
}

function requestFor(
  session: HarnessSessionOptions,
  ctx: ScriptContext,
  transcript: BrainMessage[],
): BrainRequest {
  return {
    model: session.model,
    system: ctx.systemPrompt,
    messages: [...transcript],
    tools: ctx.tools.map(toBrainTool),
    ...(session.thinking && session.thinking !== "off"
      ? { reasoning: session.thinking }
      : { reasoning: "none" }),
  };
}

function toBrainMessage(entry: TranscriptEntry): BrainMessage {
  switch (entry.role) {
    case "user":
      return { role: "user", content: entry.text };
    case "assistant":
      return {
        role: "assistant",
        content: entry.text,
        toolCalls: entry.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        })),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: entry.toolCallId,
        name: entry.toolName,
        content: entry.output,
      };
  }
}

function toBrainTool(tool: ToolSpec): BrainTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** What the model reads for a tool outcome (same text the Pi harness produces). */
export function modelText(outcome: Pick<ScriptToolOutcome, "result" | "blocked">): string {
  const text = toolResultText(outcome.result).trim();
  if (outcome.blocked || !outcome.result.isError) return text;
  if (!text) return "Error: the tool reported a failure without details";
  return /^error\b/i.test(text) ? text : `Error: ${text}`;
}

/** Like the harness: malformed JSON arguments become `{}` (and then usually fail validation). */
function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function validationMessage(spec: ToolSpec, problems: string[], input: unknown): string {
  return `Validation failed for tool "${spec.name}":\n${problems.map((p) => `  - ${p}`).join("\n")}\n\nReceived arguments:\n${JSON.stringify(input, null, 2)}`;
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
