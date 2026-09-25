/**
 * Two daemons (two homes, two vault folders: two "devices") sharing one vault on an in-process
 * sync server, agent in mock mode: sync flows between them, exactly one runs the agent, the other
 * says where it runs, and it takes over when the first one goes away.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentStatusResponse,
  API_ROUTES,
  type NoteResponse,
  type SyncStatusResponse,
} from "@ddl/core";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseTimings } from "./agent-lease";
import { loadConfig } from "./config";
import { RecordingLogger } from "./security/harness";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const LEASE: Partial<LeaseTimings> = {
  ttlMs: 5_000,
  renewEveryMs: 500,
  retryEveryMs: 200,
  maxBackoffMs: 1_000,
  marginMs: 1_000,
};

interface Device {
  name: string;
  daemon: RunningDaemon;
  apiToken: string;
}

let dir: { path: string; cleanup: () => void };
let server: RunningSyncServer;
let vault: { id: string; token: string };
let logger: RecordingLogger;
const running: RunningDaemon[] = [];

beforeEach(async () => {
  dir = tempDir("ddl-sync-daemons-");
  server = await createSyncServer({ db: ":memory:", port: 0 });
  const created = server.store.createVault("Shared vault");
  vault = { id: created.vault.id, token: created.token };
  logger = new RecordingLogger();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await server.close();
  dir.cleanup();
});

async function startDevice(name: string): Promise<Device> {
  const root = join(dir.path, name);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "sync-token"), `${vault.token}\n`, { mode: 0o600 });
  writeFileSync(
    join(home, "device.json"),
    JSON.stringify({ id: `dev_${name.toLowerCase()}`, name }),
  );
  const env = {
    DDL_HOME: home,
    DDL_VAULT: join(root, "vault"),
    DDL_WEB_DIST: join(root, "no-web-build"),
    DDL_AGENT_MODE: "mock",
    DDL_PORT: "0",
    DDL_LOG_LEVEL: "debug",
    DDL_SYNC_URL: server.url,
    DDL_SYNC_VAULT: vault.id,
  };
  const config = loadConfig({ env, cwd: root, homedir: root, platform: "linux" });
  const daemon = await startDaemon({
    config,
    env,
    logger: logger.child({ device: name }),
    leaseTimings: LEASE,
  });
  running.push(daemon);
  return { name, daemon, apiToken: readFileSync(config.tokenPath, "utf8").trim() };
}

async function get<T>(device: Device, route: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${device.daemon.url}${route}`, {
    headers: { authorization: `Bearer ${device.apiToken}` },
  });
  return { status: response.status, body: (await response.json()) as T };
}

const agentProblem = async (device: Device) =>
  (await get<AgentStatusResponse>(device, API_ROUTES.agentStatus)).body.problem;

const eventually = (assertion: () => Promise<void>) =>
  vi.waitFor(assertion, { timeout: 20_000 * TIME_SCALE, interval: 50 });

describe("two daemons sharing a vault through the sync service", {
  timeout: 60_000 * TIME_SCALE,
}, () => {
  it("sync notes both ways, run the agent on exactly one of them, and hand it over", async () => {
    const laptop = await startDevice("Laptop");
    await eventually(async () => expect(await agentProblem(laptop)).toBeUndefined());
    const desktop = await startDevice("Desktop");
    await eventually(async () =>
      expect(await agentProblem(desktop)).toBe("The agent is running on Laptop."),
    );
    expect(await agentProblem(laptop)).toBeUndefined();

    const write = (device: Device, path: string, content: string) =>
      fetch(`${device.daemon.url}${API_ROUTES.note(path)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${device.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
    const read = async (device: Device, path: string) =>
      (await get<NoteResponse>(device, API_ROUTES.note(path))).body.content;
    expect((await write(laptop, "Inbox/idea.md", "- [ ] written on the laptop\n")).status).toBe(
      201,
    );
    await eventually(async () =>
      expect(await read(desktop, "Inbox/idea.md")).toBe("- [ ] written on the laptop\n"),
    );
    expect((await write(desktop, "Inbox/reply.md", "- [ ] written on the desktop\n")).status).toBe(
      201,
    );
    await eventually(async () =>
      expect(await read(laptop, "Inbox/reply.md")).toBe("- [ ] written on the desktop\n"),
    );

    const host = new URL(server.url).host;
    for (const device of [laptop, desktop]) {
      await eventually(async () =>
        expect((await get<SyncStatusResponse>(device, API_ROUTES.syncStatus)).body).toMatchObject({
          state: "idle",
          target: "remote",
          remoteHost: host,
          deviceName: device.name,
          conflicts: [],
        }),
      );
    }

    await laptop.daemon.close();
    await eventually(async () => expect(await agentProblem(desktop)).toBeUndefined());
    expect(server.store.leaseHolder(vault.id, "agent")?.deviceName).toBe("Desktop");

    const lines = logger.lines.join("\n");
    expect(lines).toContain("This device runs the agent");
    expect(lines).not.toContain(vault.token);
  });

  it("keep the agent off while the sync server can't vouch for them", async () => {
    await server.close();
    const alone = await startDevice("Laptop");
    await eventually(async () =>
      expect(await agentProblem(alone)).toMatch(/stays off here until the sync server confirms/),
    );
    const status = (await get<SyncStatusResponse>(alone, API_ROUTES.syncStatus)).body;
    expect(status).toMatchObject({ target: "remote", deviceName: "Laptop" });
    server = await createSyncServer({ db: ":memory:", port: 0 });
  });
});
