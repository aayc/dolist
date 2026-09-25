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
 *
 * For the agent-anywhere specs it also runs, on the next ports: a second daemon playing the
 * always-on machine (port + 1: mock agent, placement `always_on_host`, synced), an in-process sync
 * service with one vault (port + 3), and a loopback helper (port + 2) the specs use for what a
 * user would get elsewhere: the vault's sync credentials, a pairing code printed on the machine,
 * and putting the served daemon back as it was. The served daemon doesn't sync until a spec sets
 * it up, so the other specs see it standalone as before.
 * For the import spec, `<tmpdir>/ddl-e2e-obsidian-<port>/Obsidian Notebook` holds a synthetic
 * Obsidian vault (the daemon's own test vault); new vaults imported next to it go with it on exit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBrain, startFakeOpenRouter } from "../src/testing";

const port = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 4175);
const MACHINE = { name: "vm-e2e", port: port + 1 };
const HELPER_PORT = port + 2;
const SYNC_PORT = port + 3;

/** A daemon's API with its master token (both daemons are local; loopback Host, no Origin). */
async function api(
  url: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function main(): Promise<void> {
  // Small, spaced chunks keep streaming visible in the UI.
  const fake = await startFakeOpenRouter({
    brain: createFakeBrain({ sandbox: true }),
    chunkChars: 6,
    chunkDelayMs: 25,
  });
  const home = await mkdtemp(join(tmpdir(), "ddl-e2e-home-"));
  const vault = await mkdtemp(join(tmpdir(), "ddl-e2e-vault-"));
  const machineRoot = await mkdtemp(join(tmpdir(), "ddl-e2e-machine-"));
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify({ execution: { kind: "local", computer: { enabled: false } } })}\n`,
  );

  // Loaded lazily: the sync service and the daemon read their environment when they start.
  const { createSyncServer } = await import("../../../apps/sync/src/index");
  const sync = await createSyncServer({ db: ":memory:", host: "127.0.0.1", port: SYNC_PORT });
  const created = sync.store.createVault("E2E vault");
  const syncSetup = { url: sync.url, vault: created.vault.id, token: created.token };

  const { startDaemon } = await import("../../../apps/daemon/src/server");
  const { loadConfig } = await import("../../../apps/daemon/src/config");

  const machineHome = join(machineRoot, "home");
  mkdirSync(machineHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(machineHome, "device.json"),
    JSON.stringify({ id: "dev_vm_e2e", name: MACHINE.name }),
  );
  writeFileSync(join(machineHome, "sync-token"), `${syncSetup.token}\n`, { mode: 0o600 });
  const machineEnv: Record<string, string> = {
    DDL_HOME: machineHome,
    DDL_VAULT: join(machineRoot, "vault"),
    DDL_WEB_DIST: join(machineRoot, "no-web-build"),
    DDL_PORT: String(MACHINE.port),
    DDL_AGENT_MODE: "mock",
    DDL_LOG_LEVEL: "warn",
    DDL_AGENT_PLACEMENT: "always_on_host",
    DDL_SYNC_URL: syncSetup.url,
    DDL_SYNC_VAULT: syncSetup.vault,
  };
  const machineConfig = loadConfig({ env: machineEnv, cwd: machineRoot, homedir: machineRoot });
  const startMachine = () => startDaemon({ config: machineConfig, env: machineEnv });
  let machine: Awaited<ReturnType<typeof startDaemon>> | null = await startMachine();
  const machineToken = readFileSync(machineConfig.tokenPath, "utf8").trim();

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
  const imports = join(tmpdir(), `ddl-e2e-obsidian-${port}`);
  await rm(imports, { recursive: true, force: true });
  const { buildObsidianVault } = await import("../../../apps/daemon/src/import/test-vaults");
  await buildObsidianVault(join(imports, "Obsidian Notebook"));
  const daemon = await startDaemon();
  const daemonToken = readFileSync(daemon.config.tokenPath, "utf8").trim();
  const machineUrl = machine.url;
  const helper = startHelper({
    sync: syncSetup,
    machine: {
      name: MACHINE.name,
      url: machineUrl,
      token: machineToken,
      async stop() {
        const running = machine;
        machine = null;
        await running?.close();
      },
      async start() {
        machine ??= await startMachine();
      },
    },
    daemon: { url: daemon.url, token: daemonToken },
  });
  process.stdout.write(
    `fullstack e2e: daemon ${daemon.url}, always-on machine ${machineUrl}, sync ${sync.url}, fake OpenRouter ${fake.baseUrl}\n`,
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      helper.close();
      await daemon.close().catch(() => {});
      await machine?.close().catch(() => {});
      await sync.close().catch(() => {});
      await fake.close();
      await rm(home, { recursive: true, force: true });
      await rm(vault, { recursive: true, force: true });
      await rm(machineRoot, { recursive: true, force: true });
      await rm(imports, { recursive: true, force: true });
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

interface HelperContext {
  sync: { url: string; vault: string; token: string };
  machine: {
    name: string;
    url: string;
    token: string;
    /** The machine goes down (its port closes), as when the VM stops. */
    stop(): Promise<void>;
    /** It comes back, same home, port and device. */
    start(): Promise<void>;
  };
  daemon: { url: string; token: string };
}

/**
 * Loopback-only test helper:
 * - `GET /always-on`: the sync service's address, vault and token, and the machine's name and URL;
 * - `POST /always-on/machine-code`: a pairing code issued by the machine (what its `pair` command
 *   prints);
 * - `POST /always-on/machine/stop` and `/always-on/machine/start`: the machine goes down, and comes
 *   back;
 * - `POST /always-on/reset`: the served daemon standalone again (sync off, the machine forgotten,
 *   placement `this_device`, no remote hosts, no paired devices).
 */
function startHelper(context: HelperContext): Server {
  const { daemon, machine } = context;
  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      if (request.method === "GET" && request.url === "/always-on") {
        return reply(200, {
          sync: context.sync,
          machine: { name: machine.name, url: machine.url },
        });
      }
      if (request.method === "POST" && request.url === "/always-on/machine-code") {
        const issued = await api(machine.url, machine.token, "POST", "/api/pairing-codes", {});
        return reply(issued.status, issued.body);
      }
      if (request.method === "POST" && request.url === "/always-on/machine/stop") {
        await machine.stop();
        return reply(200, { ok: true });
      }
      if (request.method === "POST" && request.url === "/always-on/machine/start") {
        await machine.start();
        return reply(200, { ok: true });
      }
      if (request.method === "POST" && request.url === "/always-on/reset") {
        await machine.start();
        const call = (method: string, route: string, body?: unknown) =>
          api(daemon.url, daemon.token, method, route, body);
        await call("PATCH", "/api/device", { placement: "this_device", remoteHosts: [] });
        await call("DELETE", "/api/machine/pairing");
        await call("DELETE", "/api/device/sync");
        await call("PUT", "/api/settings", { remote: { alwaysOnMachine: null } });
        const listed = await call("GET", "/api/devices");
        const devices = (listed.body as { devices?: Array<{ id: string }> } | null)?.devices ?? [];
        for (const device of devices) await call("DELETE", `/api/devices/${device.id}`);
        return reply(200, { ok: true });
      }
      reply(404, { error: "not_found" });
    })().catch((error: unknown) => reply(500, { error: String(error) }));
  });
  server.listen(HELPER_PORT, "127.0.0.1");
  return server;
}

main().catch((error: unknown) => {
  console.error(
    `✖ fullstack e2e server failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
