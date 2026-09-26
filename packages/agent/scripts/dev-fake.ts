/**
 * `pnpm dev:fake`: the whole app (daemon + web, live mode, real Pi harness) against the fake
 * OpenRouter — zero cost, no network. The fake agent is sandboxed: it only grants web/files, never
 * drives the browser, shell, computer or connectors, and irreversible steps use the simulated
 * `mock_irreversible_action` so approvals can be exercised safely.
 *
 *   pnpm dev:fake              # your usual DDL_HOME and vault (like `pnpm dev:mock`)
 *   pnpm dev:fake -- --scratch # a throwaway DDL_HOME and vault, deleted on exit
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@ddl/core";
import { createFakeBrain, startFakeOpenRouter } from "../src/testing";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function main(): Promise<void> {
  const scratch = process.argv.includes("--scratch");
  const server = await startFakeOpenRouter({
    brain: createFakeBrain({ sandbox: true }),
    chunkDelayMs: 15,
  });
  const dirs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DDL_AGENT_MODE: "live",
    OPENROUTER_API_KEY: server.apiKey,
    DDL_OPENROUTER_BASE_URL: server.baseUrl,
    DDL_AGENT_MOCK_ACTIONS: "1",
  };
  if (scratch) {
    const home = await mkdtemp(join(tmpdir(), "ddl-dev-fake-home-"));
    const vault = await mkdtemp(join(tmpdir(), "ddl-dev-fake-vault-"));
    dirs.push(home, vault);
    env.DDL_HOME = home;
    env.DDL_VAULT = vault;
  }
  process.stdout.write(
    `\n  Fake OpenRouter at ${server.baseUrl} (key ${server.apiKey}) — starting daemon + web in live mode${scratch ? " with a scratch vault" : ""}…\n\n`,
  );
  const child = spawn(
    "pnpm",
    ["exec", "turbo", "run", "dev", "--filter=@ddl/daemon", "--filter=@ddl/web"],
    {
      cwd: ROOT,
      env,
      stdio: "inherit",
    },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("exit", (code, signal) => {
    void (async () => {
      await server.close();
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
      process.exit(code ?? (signal ? 1 : 0));
    })();
  });
}

main().catch((error: unknown) => {
  console.error(`✖ dev:fake failed: ${errorMessage(error)}`);
  process.exit(1);
});
