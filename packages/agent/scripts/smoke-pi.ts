/**
 * End-to-end smoke test of the Pi harness on DeepSeek V4.1 Flash via OpenRouter: custom tools, a
 * safety-gate denial, the bash built-in over a fake ShellExecutor, queued prompts and abort.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/smoke-pi.ts [--offline] [--thinking=off|low|medium|high]
 *
 * `--offline` swaps OpenRouter for the fake OpenRouter (`src/testing`, same wire format) and checks
 * the requests Pi would send. The API key is read from the environment or ~/.daily-do-list/.env and
 * never printed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConsoleLogger,
  errorMessage,
  type ToolSpec,
  textResult,
  toolResultText,
} from "@ddl/core";
import type { ShellExecOptions, ShellExecutor } from "../src/execution/types";
import { createPiHarness } from "../src/harness/pi";
import type {
  HarnessEvent,
  HarnessSession,
  ThinkingLevel,
  ToolCallRequest,
} from "../src/harness/types";
import { createFakeBrain, type FakeOpenRouter, startFakeOpenRouter } from "../src/testing";
import { loadOpenRouterKey } from "./lib/env";

const MODEL = "deepseek/deepseek-v4.1-flash";
const offline = process.argv.includes("--offline");
const thinking = (process.argv.find((a) => a.startsWith("--thinking="))?.split("=")[1] ??
  "low") as ThinkingLevel;

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

interface RunStats {
  startedAt: number;
  firstTokenMs?: number;
  firstTextMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errors: string[];
}

function newStats(): RunStats {
  return { startedAt: performance.now(), inputTokens: 0, outputTokens: 0, costUsd: 0, errors: [] };
}

/** Compact live transcript; also accumulates timing and usage for the current run. */
function transcript(getStats: () => RunStats) {
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

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ddl-smoke-pi-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "ddl-smoke-pi-cwd-"));
  let mock: FakeOpenRouter | undefined;
  try {
    const logger = createConsoleLogger("warn");
    let harness: ReturnType<typeof createPiHarness>;
    if (offline) {
      const server = await startFakeOpenRouter({ brain: smokeBrain(), chunkDelayMs: 12 });
      mock = server;
      harness = createPiHarness({
        apiKey: server.apiKey,
        home,
        logger,
        appUrl: "https://example.com/daily-do-list",
        baseUrl: server.baseUrl,
      });
    } else {
      harness = createPiHarness({ apiKey: await loadOpenRouterKey(), home, logger });
    }
    console.log(
      `Pi harness smoke test — ${offline ? "OFFLINE (local mock of OpenRouter)" : "LIVE OpenRouter"} — ${MODEL}, thinking=${thinking}\n`,
    );

    // ── tools ────────────────────────────────────────────────────────────────
    let weatherCalls = 0;
    let deleteExecuted = false;
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
        weatherCalls++;
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
        deleteExecuted = true;
        return textResult("everything deleted");
      },
    };
    const shellCalls: Array<{ command: string; options: ShellExecOptions }> = [];
    const shell: ShellExecutor = {
      async exec(command, options) {
        shellCalls.push({ command, options });
        const output = command.includes("echo")
          ? `${command.replace(/^.*?echo\s+/, "").replace(/^["']|["']$/g, "")}\n`
          : "ok\n";
        options.onData?.(output);
        return { exitCode: 0, output, timedOut: false, truncated: false, durationMs: 4 };
      },
    };
    const gateCalls: ToolCallRequest[] = [];
    const beforeToolCall = async (call: ToolCallRequest) => {
      gateCalls.push(call);
      if (call.toolName === "delete_everything") {
        return {
          allow: false as const,
          reason: "destructive actions require explicit user approval",
        };
      }
      return { allow: true as const };
    };

    let stats = newStats();
    const events: HarnessEvent[] = [];
    const print = transcript(() => stats);
    const createStarted = performance.now();
    const session: HarnessSession = await harness.createSession({
      sessionId: "thr_smoke",
      role: "subagent",
      systemPrompt:
        "You are a subagent of Daily Do List. Use the provided tools exactly as the user asks, one step at a time, and keep replies short.",
      tools: [getWeather, deleteEverything],
      model: MODEL,
      thinking,
      cwd,
      builtinTools: { files: false, shell },
      beforeToolCall,
      onEvent: (event) => {
        events.push(event);
        print(event);
      },
    });
    console.log(`session created in ${Math.round(performance.now() - createStarted)}ms\n`);

    // ── scenario 1: tools, gate, bash ──────────────────────────────────────
    const task =
      "What's the weather in Paris? Use get_weather. Then run `echo hello from bash` with the bash tool. Then call delete_everything with confirm=true. Finally, in one sentence, say what happened with each of the three tools.";
    console.log(`▶ user: ${task}`);
    stats = newStats();
    await session.prompt(task);
    const main = { ...stats, totalMs: Math.round(performance.now() - stats.startedAt) };
    const toolEnds = events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    const finalText = events.filter((e) => e.type === "message_end").at(-1);
    check("no errors in the tool scenario", main.errors.length === 0, main.errors.join("; "));
    check("get_weather executed", weatherCalls > 0);
    check(
      "bash ran through the ShellExecutor",
      shellCalls.length > 0 && shellCalls[0]?.options.cwd === cwd,
    );
    check(
      "bash did not receive the daemon environment",
      shellCalls.every((c) => c.options.env === undefined),
    );
    check(
      "delete_everything blocked and never executed",
      !deleteExecuted &&
        toolEnds.some((e) => e.toolName === "delete_everything" && e.blocked === true),
    );
    check(
      "safety gate saw every tool call",
      gateCalls.length === toolEnds.length && gateCalls.length >= 3,
      `${gateCalls.length} gate calls / ${toolEnds.length} tool results`,
    );
    check(
      "final answer produced",
      !!finalText && finalText.type === "message_end" && finalText.text.length > 0,
    );

    if (main.errors.length > 0) {
      console.log("\nSkipping the remaining scenarios: the first run failed.");
      await session.dispose();
      return summarize(main, mock);
    }

    // ── scenario 2: prompt while running (queued follow-up) ───────────────
    console.log(
      "\n▶ user: Which city did you check? (sent twice, the second while the first is running)",
    );
    stats = newStats();
    const followStarted = performance.now();
    const first = session.prompt("Which city did you check? Answer in five words or fewer.");
    const queuedWhileRunning = session.isRunning;
    const second = session.prompt("Which city did you check, again? Five words or fewer.");
    await Promise.all([first, second]);
    const followMs = Math.round(performance.now() - followStarted);
    check(
      "second prompt was queued while running and both resolved",
      queuedWhileRunning && !session.isRunning,
      `${followMs}ms`,
    );

    // ── scenario 3: abort mid-stream ───────────────────────────────────────
    console.log(
      "\n▶ user: Write a 300-word story about a lighthouse. (aborted after the first token)",
    );
    stats = newStats();
    const before = events.length;
    const storyRun = session.prompt("Write a 300-word story about a lighthouse.");
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
          finish(Math.round(performance.now() - stats.startedAt));
        }
      }, 5);
      const giveUp = setTimeout(() => finish(-1), 30_000);
      void storyRun.then(() => finish(-1));
    });
    const abortStarted = performance.now();
    await session.abort();
    await storyRun;
    const abortMs = Math.round(performance.now() - abortStarted);
    const storyEnd = events
      .slice(before)
      .filter((e) => e.type === "message_end")
      .at(-1);
    check(
      "abort stops the run promptly",
      abortedAfter >= 0 && abortMs < 2_000 && events.at(-1)?.type === "idle",
      `first token after ${abortedAfter}ms, settled ${abortMs}ms after abort, ${storyEnd?.type === "message_end" ? storyEnd.text.length : 0} chars kept`,
    );

    await session.dispose();
    summarize(main, mock);
  } finally {
    await mock?.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

/** The generic fake policy calls the tools the prompt names; these rules pin the details. */
function smokeBrain() {
  return createFakeBrain()
    .when(
      (_request, info) =>
        /weather in Paris/.test(info.lastUserText) && info.callsSinceUser.length === 0,
      {
        reasoning:
          "The user wants the Paris weather first, then a bash command, then a deletion attempt.",
        text: "Checking the weather first.",
        toolCalls: [{ name: "get_weather", arguments: { city: "Paris" } }],
      },
    )
    .when((_request, info) => /which city/i.test(info.lastUserText), { text: "I checked Paris." });
}

interface WireBody {
  model?: string;
  stream?: boolean;
  reasoning?: unknown;
  max_completion_tokens?: number;
  max_tokens?: number;
  tools?: Array<{ function: { name: string } }>;
}

function summarize(main: RunStats & { totalMs: number }, mock: FakeOpenRouter | undefined): void {
  // ── wire checks (offline) ──────────────────────────────────────────────
  if (mock) {
    const agentRequests = mock.chatRequests().filter((r) => r.stream);
    const firstRequest = agentRequests[0] as (typeof agentRequests)[number] & { body: WireBody };
    const toolNames = (firstRequest?.body.tools ?? []).map((t) => t.function.name).sort();
    console.log(`\nmock received ${agentRequests.length} streaming requests; first request:`);
    console.log(
      `  model=${firstRequest?.body.model} reasoning=${JSON.stringify(firstRequest?.body.reasoning)} max_completion_tokens=${String(firstRequest?.body.max_completion_tokens ?? firstRequest?.body.max_tokens)} tools=${toolNames.join(",")}`,
    );
    console.log(
      `  headers: x-title=${String(firstRequest?.headers["x-title"])} http-referer=${String(firstRequest?.headers["http-referer"])} x-session-id=${firstRequest?.headers["x-session-id"] ? "present" : "missing"} authorization=${firstRequest?.headers.authorization ? "present" : "missing"}`,
    );
    check("request targets the configured model", firstRequest?.body.model === MODEL);
    check(
      "reasoning effort sent in OpenRouter format",
      JSON.stringify(firstRequest?.body.reasoning) ===
        JSON.stringify({
          effort: thinking === "off" ? "none" : thinking === "medium" ? "high" : thinking,
        }),
    );
    check(
      "exactly the requested tools are exposed",
      JSON.stringify(toolNames) === JSON.stringify(["bash", "delete_everything", "get_weather"]),
    );
    check(
      "attribution headers sent",
      firstRequest?.headers["x-title"] === "Daily Do List" &&
        firstRequest?.headers["http-referer"] === "https://example.com/daily-do-list",
    );
  }

  // ── summary ────────────────────────────────────────────────────────────
  console.log("\n── summary ──");
  console.log(
    `tool scenario: time to first token ${main.firstTokenMs ?? "–"}ms (first text ${main.firstTextMs ?? "–"}ms), total ${main.totalMs}ms`,
  );
  console.log(
    `tokens: ${main.inputTokens} in / ${main.outputTokens} out, cost $${main.costUsd.toFixed(6)}`,
  );
  for (const c of checks)
    console.log(`${c.ok ? "✓" : "✖"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

main().catch((error: unknown) => {
  console.error(`✖ smoke-pi failed: ${errorMessage(error)}`);
  process.exit(1);
});
