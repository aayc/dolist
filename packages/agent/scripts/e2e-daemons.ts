/**
 * Web server for the Playwright suites (apps/web/playwright.config.ts): real daemons on demand,
 * each with its own throwaway DDL_HOME and vault, all removed on exit.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/e2e-daemons.ts [--port=4173]
 *
 * It runs a fake OpenRouter, an in-process sync service, and a loopback control API on `--port`
 * that tests call (apps/web/e2e/fixtures.ts) to start daemons in this process:
 *
 * - `POST /daemons` with a `DaemonSpec`: a daemon on a free port serving the built web app, its
 *   vault seeded with the demo vault (apps/daemon/src/demo-vault.ts). Agents run in mock mode
 *   (the daemon's scripted mock agent) unless the spec asks for live mode (the Pi harness against
 *   the fake OpenRouter, whose brain is sandboxed as below).
 *   Answers the daemon's URL, its master token and where its files are.
 * - `POST /daemons/:id/stop` and `/start`: the daemon goes down and comes back on the same port
 *   (a machine that stops); `DELETE /daemons/:id` removes it and its files.
 * - `POST /sync-vaults`: a new vault on the sync service, with its token.
 *
 * The fake brain is sandboxed (web/files only, no browser/shell/computer/connectors, no web_fetch);
 * irreversible steps use the simulated `mock_irreversible_action`, so approvals are real but nothing
 * leaves the machine. Leases and the relay use short timings so handovers take seconds.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger } from "@ddl/core";
import { writeDemoVault } from "../../../apps/daemon/src/demo-vault";
import { createFakeBrain, startFakeOpenRouter } from "../src/testing";

const port = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 4173);
/** The daemons log nothing unless asked (`DDL_E2E_LOG_LEVEL=debug|info|warn|error`). */
const LOG_LEVEL = process.env.DDL_E2E_LOG_LEVEL;
const LEASE = {
  ttlMs: 5_000,
  renewEveryMs: 500,
  retryEveryMs: 200,
  takeoverRetryMs: 100,
  maxBackoffMs: 1_000,
  marginMs: 1_000,
};
const LINK = { pingEveryMs: 500, minBackoffMs: 50, maxBackoffMs: 500 };
const WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export interface DaemonSpec {
  /** `mock` (default): the daemon's scripted mock agent; `live`: Pi against the fake OpenRouter. */
  agent?: "mock" | "live" | "off";
  /** Live mode without OPENROUTER_API_KEY in the daemon's environment. */
  noKey?: boolean;
  /** `demo` (default) or an empty vault. */
  vault?: "demo" | "empty";
  /** Extra notes in the demo vault (performance tests). */
  notes?: number;
  /** Files written into the vault before the daemon starts (vault path → content). */
  files?: Record<string, string>;
  /** Vault settings (`.daily-do-list/settings.json`) over the e2e defaults. */
  settings?: Record<string, unknown>;
  /** `config.json` fields over the defaults (`execution`, `agent`, `remote`…). */
  config?: Record<string, unknown>;
  /** Extra environment variables: DDL_* only (placement, remote hosts, sync, the vault…). */
  env?: Record<string, string>;
  /** This device's name (`device.json`; default "E2E laptop"). */
  device?: string;
  /** Sync with the sync service (set up in `config.json` and `sync-token`, not locked by env). */
  sync?: SyncVault;
  /** A synthetic Obsidian vault (`<root>/Obsidian Notebook`) and a plain folder (`<root>/Plain notes`). */
  obsidian?: boolean;
  /** Serve the built web app (default true). */
  web?: boolean;
  /** Set the vault with DDL_VAULT (switching vaults is then refused) rather than in `config.json`. */
  lockVault?: boolean;
}

interface SyncVault {
  url: string;
  vault: string;
  token: string;
}

type RunningDaemon = Awaited<
  ReturnType<typeof import("../../../apps/daemon/src/server").startDaemon>
>;

interface Entry {
  id: string;
  root: string;
  env: Record<string, string>;
  port: number;
  daemon: RunningDaemon | null;
  /** A restart (vault switch, stop/start) in progress. */
  pending: Promise<void>;
}

async function main(): Promise<void> {
  const fake = await startFakeOpenRouter({
    brain: createFakeBrain({ sandbox: true }),
    // Small, spaced chunks keep streaming visible in the UI.
    chunkChars: 24,
    chunkDelayMs: 25,
  });
  // Loaded lazily: the sync service and the daemon read their environment when they start.
  const { createSyncServer } = await import("../../../apps/sync/src/index");
  const { startDaemon } = await import("../../../apps/daemon/src/server");
  const { loadConfig } = await import("../../../apps/daemon/src/config");
  const { buildObsidianVault } = await import("../../../apps/daemon/src/import/test-vaults");
  const sync = await createSyncServer({ db: ":memory:", host: "127.0.0.1", port: 0 });
  // A copy: a build started meanwhile (another run's `vite build`) empties the original.
  const webDist = await mkdtemp(join(tmpdir(), "ddl-e2e-web-"));
  await cp(WEB_DIST, webDist, { recursive: true });

  const entries = new Map<string, Entry>();
  let counter = 0;

  const boot = async (entry: Entry): Promise<void> => {
    const env = { ...entry.env, DDL_PORT: String(entry.port) };
    const config = loadConfig({ env, cwd: entry.root, homedir: entry.root });
    entry.daemon = await startDaemon({
      config,
      env,
      ...(LOG_LEVEL ? {} : { logger: silentLogger }),
      leaseTimings: LEASE,
      relayLinkTimings: LINK,
      onRestart: () => {
        entry.pending = entry.pending.then(async () => {
          await entry.daemon?.close();
          entry.daemon = null;
          await boot(entry);
        });
      },
    });
    entry.port = entry.daemon.port;
  };

  const create = async (spec: DaemonSpec) => {
    const id = `d${++counter}`;
    const root = await mkdtemp(join(tmpdir(), "ddl-e2e-"));
    const home = join(root, "home");
    const vault = join(root, "vault");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if ((spec.vault ?? "demo") === "demo") {
      await writeDemoVault(vault, { ...(spec.notes ? { notes: spec.notes } : {}) });
    }
    for (const [path, content] of Object.entries(spec.files ?? {})) {
      await mkdir(join(vault, path, ".."), { recursive: true });
      await writeFile(join(vault, path), content);
    }
    const settings = {
      version: 1,
      ...spec.settings,
      agent: { settleMs: 800, ...(spec.settings?.agent as object | undefined) },
    };
    await mkdir(join(vault, ".daily-do-list"), { recursive: true });
    await writeFile(join(vault, ".daily-do-list/settings.json"), `${JSON.stringify(settings)}\n`);
    const config: Record<string, unknown> = {
      ...(spec.lockVault ? {} : { vaultPath: vault }),
      execution: { kind: "local", computer: { enabled: false } },
      ...(spec.sync
        ? { sync: { kind: "remote", url: spec.sync.url, vault: spec.sync.vault } }
        : {}),
      ...spec.config,
    };
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
    if (spec.sync) writeFileSync(join(home, "sync-token"), `${spec.sync.token}\n`, { mode: 0o600 });
    writeFileSync(
      join(home, "device.json"),
      JSON.stringify({ id: `dev_e2e_${id}`, name: spec.device ?? "E2E laptop" }),
    );
    const obsidian = spec.obsidian ? join(root, "Obsidian Notebook") : undefined;
    if (obsidian) {
      await buildObsidianVault(obsidian);
      const plain = join(root, "Plain notes");
      await mkdir(join(plain, "Journal"), { recursive: true });
      await writeFile(join(plain, "Groceries.md"), "- oat milk\n- lemons\n");
      await writeFile(join(plain, "Journal/Monday.md"), "A quiet start to the week.\n");
    }
    const extra = Object.fromEntries(
      Object.entries(spec.env ?? {}).filter(([name]) => name.startsWith("DDL_")),
    );
    const env: Record<string, string> = {
      DDL_HOME: home,
      DDL_AGENT_MODE: spec.agent ?? "mock",
      ...(LOG_LEVEL ? { DDL_LOG_LEVEL: LOG_LEVEL } : {}),
      ...(spec.lockVault ? { DDL_VAULT: vault } : {}),
      DDL_WEB_DIST: spec.web === false ? join(root, "no-web-build") : webDist,
      ...(spec.agent === "live"
        ? {
            DDL_AGENT_MOCK_ACTIONS: "1",
            ...(spec.noKey ? {} : { OPENROUTER_API_KEY: fake.apiKey }),
            DDL_OPENROUTER_BASE_URL: fake.baseUrl,
          }
        : {}),
      ...extra,
    };
    const entry: Entry = { id, root, env, port: 0, daemon: null, pending: Promise.resolve() };
    entries.set(id, entry);
    try {
      await boot(entry);
    } catch (error) {
      entries.delete(id);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    const running = entry.daemon!;
    return {
      id,
      url: running.url,
      port: running.port,
      token: readFileSync(running.config.tokenPath, "utf8").trim(),
      root,
      home,
      vault,
      ...(obsidian ? { obsidian } : {}),
    };
  };

  const remove = async (entry: Entry) => {
    entries.delete(entry.id);
    await entry.pending.catch(() => {});
    await entry.daemon?.close().catch(() => {});
    await rm(entry.root, { recursive: true, force: true });
  };

  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      const url = request.url ?? "/";
      if (request.headers.host !== `127.0.0.1:${port}`) return reply(403, { error: "host" });
      if (request.method === "GET" && url === "/") return reply(200, { ok: true });
      // A JSON body can't come from another site without a preflight this server never answers.
      if (request.headers["content-type"] !== "application/json") {
        return reply(415, { error: "json_only" });
      }
      const body = await readJson(request);
      if (request.method === "POST" && url === "/daemons") {
        return reply(201, await create(body as DaemonSpec));
      }
      if (request.method === "POST" && url === "/sync-vaults") {
        const created = sync.store.createVault(`E2E vault ${++counter}`);
        return reply(201, { url: sync.url, vault: created.vault.id, token: created.token });
      }
      const match = /^\/daemons\/(d\d+)(\/stop|\/start)?$/.exec(url);
      const entry = match ? entries.get(match[1]!) : undefined;
      if (!entry) return reply(404, { error: "not_found" });
      if (request.method === "DELETE" && !match![2]) {
        await remove(entry);
        return reply(200, { ok: true });
      }
      if (request.method === "POST" && match![2] === "/stop") {
        await entry.pending;
        await entry.daemon?.close();
        entry.daemon = null;
        return reply(200, { ok: true });
      }
      if (request.method === "POST" && match![2] === "/start") {
        await entry.pending;
        if (!entry.daemon) await boot(entry);
        return reply(200, { ok: true });
      }
      reply(404, { error: "not_found" });
    })().catch((error: unknown) => reply(500, { error: String(error) }));
  });
  server.listen(port, "127.0.0.1");
  process.stdout.write(
    `e2e daemons: control http://127.0.0.1:${port}, sync ${sync.url}, fake OpenRouter ${fake.baseUrl}\n`,
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      server.close();
      await Promise.all([...entries.values()].map(remove));
      await sync.close().catch(() => {});
      await fake.close();
      await rm(webDist, { recursive: true, force: true });
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  // One daemon's stray error must not take down every other test's daemon.
  const report = (error: unknown) => {
    console.error("e2e daemons: uncaught", error instanceof Error ? error.stack : error);
  };
  process.on("uncaughtException", report);
  process.on("unhandledRejection", report);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

main().catch((error: unknown) => {
  console.error(`✖ e2e daemons failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
