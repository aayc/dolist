/**
 * Runs the fake OpenRouter (FakeBrain behind an OpenAI-compatible HTTP API) until Ctrl+C, so the
 * daemon, evals or scripts can use the real harness at zero cost:
 *
 *   pnpm --filter @ddl/agent fake-openrouter [--port=8787] [--chunk-delay=15] [--no-sandbox] [--invalid-key] [--quiet]
 *
 * `--no-sandbox` lets the fake agent use every tool it is offered (browser, shell, MCP, web_fetch);
 * the default sandbox keeps it to thread/note tools, web_search and the mock irreversible action.
 */
import { errorMessage } from "@ddl/core";
import { createFakeBrain, startFakeOpenRouter } from "../src/testing";

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "true";
}

async function main(): Promise<void> {
  const port = Number(flag("port") ?? 0);
  const quiet = flag("quiet") !== undefined;
  const server = await startFakeOpenRouter({
    brain: createFakeBrain({ sandbox: flag("no-sandbox") === undefined }),
    port: Number.isFinite(port) ? port : 0,
    chunkDelayMs: Number(flag("chunk-delay") ?? 15),
    keyValid: flag("invalid-key") === undefined,
  });
  process.stdout.write(
    [
      "",
      "  Fake OpenRouter is running (no network, no cost).",
      `  Base URL:  ${server.baseUrl}`,
      `  API key:   ${server.apiKey}${flag("invalid-key") ? "  (GET /key answers 401)" : ""}`,
      "",
      "  Point the daemon at it:",
      `    DDL_AGENT_MODE=live OPENROUTER_API_KEY=${server.apiKey} DDL_OPENROUTER_BASE_URL=${server.baseUrl} DDL_AGENT_MOCK_ACTIONS=1 pnpm dev`,
      "",
    ].join("\n"),
  );
  if (!quiet) {
    let logged = 0;
    setInterval(() => {
      for (const r of server.requests.slice(logged)) {
        if (!r.completed && !r.aborted) break;
        logged++;
        const role =
          r.brainRequest && server.brain ? server.brain.roleOf(r.brainRequest) : r.endpoint;
        const calls = r.toolCalls.map((c) => c.name).join(", ");
        process.stdout.write(
          `  ${r.method} ${r.path} → ${r.status ?? "-"}${r.aborted ? " (aborted)" : ""} · ${role}${calls ? ` · ${calls}` : ""}\n`,
        );
      }
    }, 200).unref();
  }
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`✖ fake-openrouter failed: ${errorMessage(error)}`);
  process.exit(1);
});
