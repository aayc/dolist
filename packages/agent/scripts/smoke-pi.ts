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
import { createConsoleLogger } from "@ddl/core";
import { createPiHarness } from "../src/harness/pi";
import type { HarnessEvent, HarnessSession, ThinkingLevel } from "../src/harness/types";
import { createFakeBrain, type FakeOpenRouter, startFakeOpenRouter } from "../src/testing";
import { loadOpenRouterKey } from "./lib/env";
import {
  check,
  checkAbort,
  checkQueuedPrompts,
  newStats,
  type RunStats,
  reportChecks,
  runSmoke,
  SMOKE_SYSTEM_PROMPT,
  smokeFixtures,
  TOOL_TASK,
  transcript,
} from "./lib/smoke";

const MODEL = "deepseek/deepseek-v4.1-flash";
const offline = process.argv.includes("--offline");
const thinking = (process.argv.find((a) => a.startsWith("--thinking="))?.split("=")[1] ??
  "low") as ThinkingLevel;

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
    const { seen, getWeather, deleteEverything, shell, beforeToolCall } = smokeFixtures();

    let stats = newStats();
    const events: HarnessEvent[] = [];
    const print = transcript(() => stats);
    const createStarted = performance.now();
    const session: HarnessSession = await harness.createSession({
      sessionId: "thr_smoke",
      role: "subagent",
      systemPrompt: SMOKE_SYSTEM_PROMPT,
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
    console.log(`▶ user: ${TOOL_TASK}`);
    stats = newStats();
    await session.prompt(TOOL_TASK);
    const main = { ...stats, totalMs: Math.round(performance.now() - stats.startedAt) };
    const toolEnds = events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    const finalText = events.filter((e) => e.type === "message_end").at(-1);
    check("no errors in the tool scenario", main.errors.length === 0, main.errors.join("; "));
    check("get_weather executed", seen.weatherCalls > 0);
    check(
      "bash ran through the ShellExecutor",
      seen.shellCalls.length > 0 && seen.shellCalls[0]?.options.cwd === cwd,
    );
    check(
      "bash did not receive the daemon environment",
      seen.shellCalls.every((c) => c.options.env === undefined),
    );
    check(
      "delete_everything blocked and never executed",
      !seen.deleteExecuted &&
        toolEnds.some((e) => e.toolName === "delete_everything" && e.blocked === true),
    );
    check(
      "safety gate saw every tool call",
      seen.gateCalls.length === toolEnds.length && seen.gateCalls.length >= 3,
      `${seen.gateCalls.length} gate calls / ${toolEnds.length} tool results`,
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

    stats = newStats();
    await checkQueuedPrompts(session);
    stats = newStats();
    await checkAbort(session, events, { giveUpMs: 30_000, settleMs: 2_000 });

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
  reportChecks();
}

runSmoke("smoke-pi", main);
