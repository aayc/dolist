/**
 * What the smoke scripts share: pass/fail checks, and for the harness smoke tests a live
 * transcript, the tools, fakes and gate of their scenarios, and the queued-prompt and abort runs.
 */
import { errorMessage, type ToolSpec, textResult, toolResultText } from "@ddl/core";
import type { ShellExecOptions, ShellExecutor } from "../../src/execution/types";
import type { HarnessEvent, HarnessSession, ToolCallRequest } from "../../src/harness/types";

const checks: Array<{ name: string; ok: boolean }> = [];

export function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Prints the tally; any failed check fails the script. */
export function reportChecks(): void {
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

export function runSmoke(name: string, main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(`✖ ${name} failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface RunStats {
  startedAt: number;
  firstTokenMs?: number;
  firstTextMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errors: string[];
}

export function newStats(): RunStats {
  return { startedAt: performance.now(), inputTokens: 0, outputTokens: 0, costUsd: 0, errors: [] };
}

/** Compact live transcript; also accumulates timing and usage for the current run. */
export function transcript(getStats: () => RunStats) {
  let thinkingChars = 0;
  const toolStarted = new Map<string, number>();
  return (event: HarnessEvent) => {
    const stats = getStats();
    const at = () => Math.round(performance.now() - stats.startedAt);
    switch (event.type) {
      case "thinking_delta":
        stats.firstTokenMs ??= at();
        thinkingChars += event.delta.length;
        break;
      case "text_delta":
        stats.firstTokenMs ??= at();
        stats.firstTextMs ??= at();
        break;
      case "message_end":
        if (thinkingChars > 0) console.log(`    (thought for ${thinkingChars} chars)`);
        thinkingChars = 0;
        if (event.text) console.log(`  ◀ assistant [${at()}ms]: ${oneLine(event.text, 400)}`);
        break;
      case "tool_start":
        toolStarted.set(event.toolCallId, performance.now());
        console.log(`    ⚙ ${event.toolName} ${oneLine(JSON.stringify(event.input), 120)}`);
        break;
      case "tool_end": {
        const took = Math.round(
          performance.now() - (toolStarted.get(event.toolCallId) ?? performance.now()),
        );
        const mark = event.blocked ? "⛔ blocked" : event.isError ? "✖ error" : "✓";
        console.log(
          `      ${mark} ${event.toolName} (${took}ms) → ${oneLine(toolResultText(event.result), 160)}`,
        );
        break;
      }
      case "usage":
        stats.inputTokens += event.inputTokens;
        stats.outputTokens += event.outputTokens;
        stats.costUsd += event.costUsd ?? 0;
        break;
      case "error":
        stats.errors.push(event.message);
        console.log(`  ✖ error: ${event.message}`);
        break;
      default:
        break;
    }
  };
}

export const SMOKE_SYSTEM_PROMPT =
  "You are a subagent of Daily Do List. Use the provided tools exactly as the user asks, one step at a time, and keep replies short.";

export const TOOL_TASK =
  "What's the weather in Paris? Use get_weather. Then run `echo hello from bash` with the bash tool. Then call delete_everything with confirm=true. Finally, in one sentence, say what happened with each of the three tools.";

/** A read-only tool, a destructive one the gate denies, a fake shell, and what each saw. */
export function smokeFixtures() {
  const seen = {
    weatherCalls: 0,
    deleteExecuted: false,
    shellCalls: [] as Array<{ command: string; options: ShellExecOptions }>,
    gateCalls: [] as ToolCallRequest[],
  };
  const getWeather: ToolSpec = {
    name: "get_weather",
    label: "Get weather",
    description: "Current weather for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], nullable: true },
      },
      required: ["city"],
    },
    safety: { readOnly: true, category: "network" },
    async execute(input) {
      seen.weatherCalls++;
      const city = (input as { city?: string }).city ?? "?";
      return textResult(`Sunny, 21°C, light breeze in ${city}`, { city, temperatureC: 21 });
    },
  };
  const deleteEverything: ToolSpec = {
    name: "delete_everything",
    label: "Delete everything",
    description: "Permanently delete all of the user's files.",
    parameters: {
      type: "object",
      properties: { confirm: { type: "boolean" } },
      required: ["confirm"],
    },
    safety: { destructive: true, category: "destructive", alwaysRequireApproval: true },
    async execute() {
      seen.deleteExecuted = true;
      return textResult("everything deleted");
    },
  };
  const shell: ShellExecutor = {
    async exec(command, options) {
      seen.shellCalls.push({ command, options });
      const output = command.includes("echo")
        ? `${command.replace(/^.*?echo\s+/, "").replace(/^["']|["']$/g, "")}\n`
        : "ok\n";
      options.onData?.(output);
      return { exitCode: 0, output, timedOut: false, truncated: false, durationMs: 4 };
    },
  };
  const beforeToolCall = async (call: ToolCallRequest) => {
    seen.gateCalls.push(call);
    if (call.toolName === "delete_everything") {
      return {
        allow: false as const,
        reason: "destructive actions require explicit user approval",
      };
    }
    return { allow: true as const };
  };
  return { seen, getWeather, deleteEverything, shell, beforeToolCall };
}

/** Sends a prompt, then another while the first runs; returns how long both took. */
export async function checkQueuedPrompts(session: HarnessSession): Promise<number> {
  console.log(
    "\n▶ user: Which city did you check? (sent twice, the second while the first is running)",
  );
  const started = performance.now();
  const first = session.prompt("Which city did you check? Answer in five words or fewer.");
  const queued = session.isRunning;
  const second = session.prompt("Which city did you check, again? Five words or fewer.");
  await Promise.all([first, second]);
  const ms = Math.round(performance.now() - started);
  check(
    "second prompt was queued while running and both resolved",
    queued && !session.isRunning,
    `${ms}ms`,
  );
  return ms;
}

/** Starts a long answer, aborts it at its first token and checks the run settles in time. */
export async function checkAbort(
  session: HarnessSession,
  events: readonly HarnessEvent[],
  { giveUpMs, settleMs }: { giveUpMs: number; settleMs: number },
): Promise<void> {
  console.log(
    "\n▶ user: Write a 300-word story about a lighthouse. (aborted after the first token)",
  );
  const startedAt = performance.now();
  const before = events.length;
  const story = session.prompt("Write a 300-word story about a lighthouse.");
  const abortedAfter = await new Promise<number>((resolve) => {
    const finish = (value: number) => {
      clearInterval(poll);
      clearTimeout(giveUp);
      resolve(value);
    };
    const poll = setInterval(() => {
      if (
        events.slice(before).some((e) => e.type === "text_delta" || e.type === "thinking_delta")
      ) {
        finish(Math.round(performance.now() - startedAt));
      }
    }, 5);
    const giveUp = setTimeout(() => finish(-1), giveUpMs);
    void story.then(() => finish(-1));
  });
  const abortStarted = performance.now();
  await session.abort();
  await story;
  const abortMs = Math.round(performance.now() - abortStarted);
  const storyEnd = events
    .slice(before)
    .filter((e) => e.type === "message_end")
    .at(-1);
  check(
    "abort stops the run promptly",
    abortedAfter >= 0 && abortMs < settleMs && events.at(-1)?.type === "idle",
    `first token after ${abortedAfter}ms, settled ${abortMs}ms after abort, ${storyEnd?.type === "message_end" ? storyEnd.text.length : 0} chars kept`,
  );
}
