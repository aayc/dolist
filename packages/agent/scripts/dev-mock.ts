/**
 * `pnpm dev:mock`: the demo. The daemon (mock agent: the scripted brain, in process, no network)
 * and the web dev server, on a throwaway DDL_HOME and the demo vault (demo-vault.ts), both deleted
 * on exit. The ports aren't the usual ones, so it runs beside the Mac app and `pnpm dev`: the
 * daemon on 7340, the web app on http://localhost:5174.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDemoVault } from "./demo-vault";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DAEMON_PORT = "7340";
const WEB_PORT = "5174";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ddl-demo-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  await writeDemoVault(vault);
  await writeFile(
    join(vault, ".daily-do-list/settings.json"),
    `${JSON.stringify({ version: 1, agent: { settleMs: 1200 } })}\n`,
  );
  // The demo never operates this Mac's apps.
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify({ execution: { kind: "local", computer: { enabled: false } } })}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DDL_HOME: home,
    DDL_VAULT: vault,
    DDL_PORT: DAEMON_PORT,
    DDL_WEB_PORT: WEB_PORT,
    DDL_AGENT_MODE: "mock",
  };
  process.stdout.write(
    `\n  Demo vault in ${root} — daemon on ${DAEMON_PORT} (mock agent), web app at http://localhost:${WEB_PORT}\n\n`,
  );
  const child = spawn(
    "pnpm",
    ["exec", "turbo", "run", "dev", "--filter=@ddl/daemon", "--filter=@ddl/web"],
    { cwd: ROOT, env, stdio: "inherit" },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("exit", (code, signal) => {
    void rm(root, { recursive: true, force: true }).then(() =>
      process.exit(code ?? (signal ? 1 : 0)),
    );
  });
}

main().catch((error: unknown) => {
  console.error(`✖ dev:mock failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
