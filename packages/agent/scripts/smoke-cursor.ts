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
import { createConsoleLogger, DEFAULT_CURSOR_MODEL, type ToolSpec, textResult } from "@ddl/core";
import { checkCursorCli, createCursorHarness, cursorCliProblem } from "../src/harness/cursor";
import type { HarnessEvent, HarnessSession } from "../src/harness/types";
import {
  check,
  checkAbort,
  checkQueuedPrompts,
  newStats,
  oneLine,
  reportChecks,
  runSmoke,
  SMOKE_SYSTEM_PROMPT,
  smokeFixtures,
  TOOL_TASK,
  transcript,
} from "./lib/smoke";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const MODEL = arg("model") ?? DEFAULT_CURSOR_MODEL;
const BINARY = arg("binary");
/** Start the session from a prewarmed CLI (`CursorHarness.prewarm`), as the app does while you type. */
const PREWARM = process.argv.includes("--prewarm");

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
    const { seen, getWeather, deleteEverything, shell, beforeToolCall } = smokeFixtures();
    // Makes web access part of this session so the CLI's own web search is routed to the gate.
    const webFetch: ToolSpec = {
      name: "web_fetch",
      label: "Fetch page",
      description: "Fetch a web page (offline stand-in: returns a canned page).",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      safety: { readOnly: true, category: "network" },
      execute: async (input) => textResult(`Canned page for ${(input as { url?: string }).url}`),
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
      systemPrompt: SMOKE_SYSTEM_PROMPT,
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
    console.log(`▶ user: ${TOOL_TASK}`);
    stats = newStats();
    await session.prompt(TOOL_TASK);
    const main = { ...stats, totalMs: Math.round(performance.now() - stats.startedAt) };
    const toolEnds = events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    check("no errors in the tool scenario", main.errors.length === 0, main.errors.join("; "));
    check("get_weather executed through the MCP bridge", seen.weatherCalls > 0);
    check(
      "bash ran through the ShellExecutor in the task workspace",
      seen.shellCalls[0]?.options.cwd === cwd,
    );
    check(
      "bash did not receive an environment",
      seen.shellCalls.every((c) => c.options.env === undefined),
    );
    check(
      "delete_everything blocked by the gate and never executed",
      !seen.deleteExecuted &&
        toolEnds.some((e) => e.toolName === "delete_everything" && e.blocked === true),
    );
    check(
      "the gate saw every tool call (built-ins without a spec)",
      seen.gateCalls.length === toolEnds.length &&
        seen.gateCalls.filter((c) => c.toolName === "bash").every((c) => c.spec === undefined),
      `${seen.gateCalls.length} gate calls / ${toolEnds.length} tool results`,
    );

    // ── 2: a disabled built-in ─────────────────────────────────────────────
    const shellTask =
      "Now use Cursor's own built-in Shell tool (not the ddl bash tool) to run `whoami`, and tell me exactly what it returned.";
    console.log(`\n▶ user: ${shellTask}`);
    stats = newStats();
    const beforeShell = seen.shellCalls.length;
    await session.prompt(shellTask);
    const shellErrors = stats.errors;
    const finalShell = events.filter((e) => e.type === "message_end").at(-1);
    check(
      "the CLI refused its own shell tool (no policy stop, nothing ran)",
      shellErrors.length === 0 && seen.shellCalls.length - beforeShell <= 1,
      finalShell?.type === "message_end" ? oneLine(finalShell.text, 120) : "",
    );

    // ── 3: the CLI's web search through the gate ───────────────────────────
    const webTask =
      "Use Cursor's built-in WebSearch tool to search for: IANA reserved example domains. Reply with the title of the first result only.";
    console.log(`\n▶ user: ${webTask}`);
    stats = newStats();
    const gateBefore = seen.gateCalls.length;
    await session.prompt(webTask);
    const webGate = seen.gateCalls.slice(gateBefore).find((c) => c.toolName === "web_search");
    check(
      "the CLI's web search went through the gate as web_search {query}",
      webGate !== undefined &&
        webGate.spec === undefined &&
        typeof (webGate.input as { query?: unknown }).query === "string",
      webGate
        ? JSON.stringify(webGate.input)
        : "no web_search gate call (the model may have skipped the search)",
    );

    stats = newStats();
    const followMs = await checkQueuedPrompts(session);
    stats = newStats();
    await checkAbort(session, events, { giveUpMs: 60_000, settleMs: 5_000 });

    console.log("\n── summary ──");
    console.log(`session creation ${createMs}ms`);
    console.log(
      `tool scenario: first token ${main.firstTokenMs ?? "–"}ms, total ${main.totalMs}ms`,
    );
    console.log(`follow-ups: ${followMs}ms for two queued prompts`);
    reportChecks();
  } finally {
    await session?.dispose();
    await harness.dispose?.();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

runSmoke("smoke-cursor", main);
