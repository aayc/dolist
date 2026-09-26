/**
 * End-to-end smoke test of the Cursor harness against the real Cursor CLI (`agent acp`) and your
 * Cursor login: custom tools through the MCP bridge, a safety-gate denial, the bash built-in over a
 * fake ShellExecutor, the CLI's own web search routed through the gate, a disabled built-in the
 * CLI must refuse, queued prompts and abort. Uses a little of your Cursor usage.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/smoke-cursor.ts [--model=claude-opus-5-5] [--binary=agent] [--prewarm]
 *
 * The model defaults to the app's (`DEFAULT_CURSOR_MODEL`).
 *
 * Runs in a temporary DDL_HOME and workspace (deleted afterwards). Prints events, not account data.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConsoleLogger,
  DEFAULT_CURSOR_MODEL,
  errorMessage,
  type ToolSpec,
  textResult,
  toolResultText,
} from "@ddl/core";
import type { ShellExecOptions, ShellExecutor } from "../src/execution/types";
import { checkCursorCli, createCursorHarness, cursorCliProblem } from "../src/harness/cursor";
import type { HarnessEvent, HarnessSession, ToolCallRequest } from "../src/harness/types";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const MODEL = arg("model") ?? DEFAULT_CURSOR_MODEL;
const BINARY = arg("binary");
/** Start the session from a prewarmed CLI (`CursorHarness.prewarm`), as the app does while you type. */
const PREWARM = process.argv.includes("--prewarm");

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

interface RunStats {
  startedAt: number;
  firstTokenMs?: number;
  errors: string[];
}

const newStats = (): RunStats => ({ startedAt: performance.now(), errors: [] });

function transcript(getStats: () => RunStats) {
  let thinkingChars = 0;
  const started = new Map<string, number>();
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
        break;
      case "message_end":
        if (thinkingChars > 0) console.log(`    (thought for ${thinkingChars} chars)`);
        thinkingChars = 0;
        if (event.text) console.log(`  ◀ assistant [${at()}ms]: ${oneLine(event.text, 300)}`);
        break;
      case "tool_start":
        started.set(event.toolCallId, performance.now());
        console.log(`    ⚙ ${event.toolName} ${oneLine(JSON.stringify(event.input), 120)}`);
        break;
      case "tool_end": {
        const took = Math.round(
          performance.now() - (started.get(event.toolCallId) ?? performance.now()),
        );
        const mark = event.blocked ? "⛔ blocked" : event.isError ? "✖ error" : "✓";
        console.log(
          `      ${mark} ${event.toolName} (${took}ms) → ${oneLine(toolResultText(event.result), 140)}`,
        );
        break;
      }
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
  const status = await checkCursorCli(BINARY ? { binary: BINARY } : {});
  const problem = cursorCliProblem(status);
  if (problem || status.state !== "ready") throw new Error(problem ?? "Cursor CLI not ready");

  const home = await mkdtemp(join(tmpdir(), "ddl-smoke-cursor-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "ddl-smoke-cursor-cwd-"));
  const harness = createCursorHarness({
    home,
    binary: status.binary,
    logger: createConsoleLogger("warn"),
  });
  let session: HarnessSession | undefined;
  try {
    console.log(`Cursor harness smoke test — model ${MODEL}\n`);
    let weatherCalls = 0;
    let deleteExecuted = false;
    const getWeather: ToolSpec = {
      name: "get_weather",
      label: "Get weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
      safety: { readOnly: true, category: "network" },
      async execute(input) {
        weatherCalls++;
        const city = (input as { city?: string }).city ?? "?";
        return textResult(`Sunny, 21°C, light breeze in ${city}`);
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
    // Makes web access part of this session so the CLI's own web search is routed to the gate.
    const webFetch: ToolSpec = {
      name: "web_fetch",
      label: "Fetch page",
      description: "Fetch a web page (offline stand-in: returns a canned page).",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      safety: { readOnly: true, category: "network" },
      execute: async (input) => textResult(`Canned page for ${(input as { url?: string }).url}`),
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
    if (PREWARM) {
      const warmStarted = performance.now();
      await harness.prewarm?.();
      console.log(`prewarmed a CLI in ${Math.round(performance.now() - warmStarted)}ms`);
    }
    const createStarted = performance.now();
    session = await harness.createSession({
      sessionId: "thr_smoke",
      role: "subagent",
      systemPrompt:
        "You are a subagent of Daily Do List. Use the provided tools exactly as the user asks, one step at a time, and keep replies short.",
      tools: [getWeather, deleteEverything, webFetch],
      model: MODEL,
      cwd,
      builtinTools: { files: false, shell },
      beforeToolCall,
      onEvent: (event) => {
        events.push(event);
        print(event);
      },
    });
    const createMs = Math.round(performance.now() - createStarted);
    console.log(`session created in ${createMs}ms\n`);

    // ── 1: custom tool allowed, bash built-in, custom tool denied ─────────
    const task =
      "What's the weather in Paris? Use get_weather. Then run `echo hello from bash` with the bash tool. Then call delete_everything with confirm=true. Finally, in one sentence, say what happened with each of the three tools.";
    console.log(`▶ user: ${task}`);
    stats = newStats();
    await session.prompt(task);
    const main = { ...stats, totalMs: Math.round(performance.now() - stats.startedAt) };
    const toolEnds = events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    check("no errors in the tool scenario", main.errors.length === 0, main.errors.join("; "));
    check("get_weather executed through the MCP bridge", weatherCalls > 0);
    check(
      "bash ran through the ShellExecutor in the task workspace",
      shellCalls[0]?.options.cwd === cwd,
    );
    check(
      "bash did not receive an environment",
      shellCalls.every((c) => c.options.env === undefined),
    );
    check(
      "delete_everything blocked by the gate and never executed",
      !deleteExecuted &&
        toolEnds.some((e) => e.toolName === "delete_everything" && e.blocked === true),
    );
    check(
      "the gate saw every tool call (built-ins without a spec)",
      gateCalls.length === toolEnds.length &&
        gateCalls.filter((c) => c.toolName === "bash").every((c) => c.spec === undefined),
      `${gateCalls.length} gate calls / ${toolEnds.length} tool results`,
    );

    // ── 2: a disabled built-in ─────────────────────────────────────────────
    const shellTask =
      "Now use Cursor's own built-in Shell tool (not the ddl bash tool) to run `whoami`, and tell me exactly what it returned.";
    console.log(`\n▶ user: ${shellTask}`);
    stats = newStats();
    const beforeShell = shellCalls.length;
    await session.prompt(shellTask);
    const shellErrors = stats.errors;
    const finalShell = events.filter((e) => e.type === "message_end").at(-1);
    check(
      "the CLI refused its own shell tool (no policy stop, nothing ran)",
      shellErrors.length === 0 && shellCalls.length - beforeShell <= 1,
      finalShell?.type === "message_end" ? oneLine(finalShell.text, 120) : "",
    );

    // ── 3: the CLI's web search through the gate ───────────────────────────
    const webTask =
      "Use Cursor's built-in WebSearch tool to search for: IANA reserved example domains. Reply with the title of the first result only.";
    console.log(`\n▶ user: ${webTask}`);
    stats = newStats();
    const gateBefore = gateCalls.length;
    await session.prompt(webTask);
    const webGate = gateCalls.slice(gateBefore).find((c) => c.toolName === "web_search");
    check(
      "the CLI's web search went through the gate as web_search {query}",
      webGate !== undefined &&
        webGate.spec === undefined &&
        typeof (webGate.input as { query?: unknown }).query === "string",
      webGate
        ? JSON.stringify(webGate.input)
        : "no web_search gate call (the model may have skipped the search)",
    );

    // ── 4: prompt while running (queued follow-up) ─────────────────────────
    console.log(
      "\n▶ user: Which city did you check? (sent twice, the second while the first is running)",
    );
    stats = newStats();
    const followStarted = performance.now();
    const first = session.prompt("Which city did you check? Answer in five words or fewer.");
    const queued = session.isRunning;
    const second = session.prompt("Which city did you check, again? Five words or fewer.");
    await Promise.all([first, second]);
    const followMs = Math.round(performance.now() - followStarted);
    check(
      "second prompt was queued while running and both resolved",
      queued && !session.isRunning,
      `${followMs}ms`,
    );

    // ── 5: abort mid-stream ────────────────────────────────────────────────
    console.log(
      "\n▶ user: Write a 300-word story about a lighthouse. (aborted after the first token)",
    );
    stats = newStats();
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
          finish(Math.round(performance.now() - stats.startedAt));
        }
      }, 5);
      const giveUp = setTimeout(() => finish(-1), 60_000);
      void story.then(() => finish(-1));
    });
    const abortStarted = performance.now();
    await session.abort();
    await story;
    const abortMs = Math.round(performance.now() - abortStarted);
    check(
      "abort stops the run promptly",
      abortedAfter >= 0 && abortMs < 5_000 && events.at(-1)?.type === "idle",
      `first token after ${abortedAfter}ms, settled ${abortMs}ms after abort`,
    );

    console.log("\n── summary ──");
    console.log(`session creation ${createMs}ms`);
    console.log(
      `tool scenario: first token ${main.firstTokenMs ?? "–"}ms, total ${main.totalMs}ms`,
    );
    console.log(`follow-ups: ${followMs}ms for two queued prompts`);
    for (const c of checks)
      console.log(`${c.ok ? "✓" : "✖"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await session?.dispose();
    await harness.dispose?.();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

main().catch((error: unknown) => {
  console.error(`✖ smoke-cursor failed: ${errorMessage(error)}`);
  process.exit(1);
});
