/**
 * Web server for the `fullstack` Playwright project: the fake OpenRouter, a throwaway DDL_HOME and
 * vault, and the real daemon in live mode (Pi harness, OpenRouter client and key check all pointed
 * at the fake) serving the built web app. Everything is removed on exit.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/e2e-fullstack.ts [--port=4175]
 *
 * The fake agent is sandboxed (web/files only, no browser/shell/computer/connectors, no web_fetch);
 * irreversible steps use the simulated `mock_irreversible_action`, so approvals are real but nothing
 * leaves the machine.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBrain, startFakeOpenRouter } from "../src/testing";

const port = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 4175);

async function main(): Promise<void> {
  // Small, spaced chunks keep streaming visible in the UI.
  const fake = await startFakeOpenRouter({
    brain: createFakeBrain({ sandbox: true }),
    chunkChars: 6,
    chunkDelayMs: 25,
  });
  const home = await mkdtemp(join(tmpdir(), "ddl-e2e-home-"));
  const vault = await mkdtemp(join(tmpdir(), "ddl-e2e-vault-"));
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify({ execution: { kind: "local", computer: { enabled: false } } })}\n`,
  );
  Object.assign(process.env, {
    DDL_HOME: home,
    DDL_VAULT: vault,
    DDL_PORT: String(port),
    DDL_AGENT_MODE: "live",
    DDL_LOG_LEVEL: "warn",
    OPENROUTER_API_KEY: fake.apiKey,
    DDL_OPENROUTER_BASE_URL: fake.baseUrl,
    DDL_AGENT_MOCK_ACTIONS: "1",
  });
  // Loaded after the environment is set: the daemon and the agent runtime read it at startup.
  const { startDaemon } = await import("../../../apps/daemon/src/server");
  const daemon = await startDaemon();
  process.stdout.write(`fullstack e2e: daemon ${daemon.url}, fake OpenRouter ${fake.baseUrl}\n`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await daemon.close().catch(() => {});
      await fake.close();
      await rm(home, { recursive: true, force: true });
      await rm(vault, { recursive: true, force: true });
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

main().catch((error: unknown) => {
  console.error(
    `✖ fullstack e2e server failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
