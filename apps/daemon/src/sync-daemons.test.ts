/**
 * Two daemons (two homes, two vault folders: two "devices") sharing one vault on an in-process
 * sync server, agent in mock mode: sync flows between them, exactly one runs the agent, the other
 * says where it runs, and it takes over when the first one goes away.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentPlacement,
  type AgentStatusResponse,
  API_ROUTES,
  type NoteResponse,
  type SettingsResponse,
  type SyncStatusResponse,
} from "@ddl/core";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeaseTimings } from "./agent-lease";
import { loadConfig } from "./config";
import { RELAY_PROBLEMS } from "./relay/relay";
import { eventually, RecordingLogger } from "./security/harness";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const LEASE: Partial<LeaseTimings> = {
  ttlMs: 5_000,
  renewEveryMs: 500,
  retryEveryMs: 200,
  takeoverRetryMs: 100,
  maxBackoffMs: 1_000,
  marginMs: 1_000,
};
/** Local changes reach the sync service this long after they settle (1.5 s in the app). */
const SYNC_DEBOUNCE_MS = 100;

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

async function startDevice(
  name: string,
  options: { sync?: boolean; placement?: AgentPlacement } = {},
): Promise<Device> {
  const root = join(dir.path, name);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "device.json"),
    JSON.stringify({ id: `dev_${name.toLowerCase().replace(/\W/g, "_")}`, name }),
  );
  if (options.placement) {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ agent: { placement: options.placement } }),
    );
  }
  const env: Record<string, string> = {
    DDL_HOME: home,
    DDL_VAULT: join(root, "vault"),
    DDL_WEB_DIST: join(root, "no-web-build"),
    DDL_AGENT_MODE: "mock",
    DDL_PORT: "0",
    DDL_LOG_LEVEL: "debug",
  };
  if (options.sync !== false) {
    writeFileSync(join(home, "sync-token"), `${vault.token}\n`, { mode: 0o600 });
    env.DDL_SYNC_URL = server.url;
    env.DDL_SYNC_VAULT = vault.id;
  }
  const config = loadConfig({ env, cwd: root, homedir: root, platform: "linux" });
  const daemon = await startDaemon({
    config,
    env,
    logger: logger.child({ device: name }),
    leaseTimings: LEASE,
    syncDebounceMs: SYNC_DEBOUNCE_MS,
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

async function send(device: Device, method: string, route: string, body?: unknown) {
  const response = await fetch(`${device.daemon.url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${device.apiToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const agentStatus = async (device: Device) =>
  (await get<AgentStatusResponse>(device, API_ROUTES.agentStatus)).body;

const agentProblem = async (device: Device) => (await agentStatus(device)).problem;

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

    // Only the device running the agent changes the agent's files on the sync service.
    const thread = ".daily-do-list/threads/thr_k3j9x0q2m1ab.json";
    const sidecar = (device: Device, path: string) =>
      join(dir.path, device.name, "vault", ...path.split("/"));
    mkdirSync(join(sidecar(laptop, thread), ".."), { recursive: true });
    writeFileSync(sidecar(laptop, thread), '{"by":"laptop"}');
    await eventually(async () =>
      expect(readFileSync(sidecar(desktop, thread), "utf8")).toBe('{"by":"laptop"}'),
    );
    writeFileSync(sidecar(desktop, thread), '{"by":"desktop, not running the agent"}');
    await eventually(async () =>
      expect(readFileSync(sidecar(desktop, thread), "utf8")).toBe('{"by":"laptop"}'),
    );
    expect(server.store.read(vault.id, thread)?.content).toBe('{"by":"laptop"}');

    await laptop.daemon.close();
    await eventually(async () => expect(await agentProblem(desktop)).toBeUndefined());
    expect(server.store.leaseHolder(vault.id, "agent")?.deviceName).toBe("Desktop");

    const lines = logger.lines.join("\n");
    expect(lines).toContain("This device runs the agent");
    expect(lines).not.toContain(vault.token);
  });

  it("hand the agent between the always-on machine and a device that runs it itself", async () => {
    const vm = await startDevice("vm-1", { placement: "always_on_host" });
    await eventually(async () =>
      expect((await agentStatus(vm)).placement).toEqual({
        placement: "always_on_host",
        heldHere: "no_machine",
        runsOn: { deviceId: "dev_vm_1", name: "vm-1", thisDevice: true, alwaysOnMachine: false },
        relay: "off",
      }),
    );
    await eventually(async () =>
      expect((await agentStatus(vm)).readiness).toMatchObject({
        harness: { kind: "pi", ready: true },
        modelCredential: true,
        computer: "unsupported",
        connectors: { configured: 0, connected: 0 },
      }),
    );
    const laptop = await startDevice("Laptop");
    // Without an always-on machine both ask as `interactive`: the first one keeps it.
    await eventually(async () =>
      expect(await agentStatus(laptop)).toMatchObject({
        problem: "The agent is running on vm-1.",
        placement: { placement: "this_device", heldHere: "no_machine", runsOn: { name: "vm-1" } },
      }),
    );

    const machine = { name: "vm-1", url: "https://vm-1.tailnet-name.ts.net" };
    expect(
      (await send(vm, "PUT", API_ROUTES.settings, { remote: { alwaysOnMachine: machine } })).status,
    ).toBe(200);
    // Now the machine asks as `host`, and the laptop takes the agent over. The machine's address
    // reaches the laptop through sync.
    await eventually(async () =>
      expect(
        (await get<SettingsResponse>(laptop, API_ROUTES.settings)).body.settings.remote,
      ).toEqual({ alwaysOnMachine: machine }),
    );
    // The placement and the problem come from different sources and can take a moment to agree.
    await eventually(async () => {
      const status = await agentStatus(laptop);
      expect(status.placement).toEqual({
        placement: "this_device",
        runsOn: {
          deviceId: "dev_laptop",
          name: "Laptop",
          thisDevice: true,
          alwaysOnMachine: false,
        },
        relay: "off",
      });
      expect(status.problem).toBeUndefined();
    });
    await eventually(async () =>
      expect(await agentStatus(vm)).toMatchObject({
        problem: "The agent is running on Laptop.",
        placement: { placement: "always_on_host", runsOn: { name: "Laptop", thisDevice: false } },
      }),
    );
    expect((await agentStatus(vm)).placement?.heldHere).toBeUndefined();
    expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({
      device: "dev_laptop",
      priority: "interactive",
    });

    const moved = await send(laptop, "PATCH", API_ROUTES.device, {
      placement: "always_on_machine",
    });
    expect(moved.body).toMatchObject({ placement: "always_on_machine" });
    await eventually(async () =>
      expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({
        device: "dev_vm_1",
        priority: "host",
      }),
    );
    // The problem is why this device can't act on the agent; `runsOn` says where it runs.
    await eventually(async () =>
      expect(await agentStatus(laptop)).toMatchObject({
        problem: RELAY_PROBLEMS.notPaired,
        placement: {
          placement: "always_on_machine",
          runsOn: { name: "vm-1", thisDevice: false, alwaysOnMachine: true },
          relay: "not_paired",
        },
      }),
    );
    expect((await agentStatus(laptop)).placement?.note).toBeUndefined();
    await eventually(async () => expect(await agentProblem(vm)).toBeUndefined());

    // And back: this device again takes it over.
    await send(laptop, "PATCH", API_ROUTES.device, { placement: "this_device" });
    await eventually(async () =>
      expect(server.store.leaseHolder(vault.id, "agent")?.device).toBe("dev_laptop"),
    );
    await eventually(async () => expect(await agentProblem(laptop)).toBeUndefined());
  });

  it("set up sync from Settings and turn it off again, live", async () => {
    const laptop = await startDevice("Laptop", { sync: false });
    await eventually(async () => expect(await agentProblem(laptop)).toBeUndefined());
    expect((await get<SyncStatusResponse>(laptop, API_ROUTES.syncStatus)).body.target).toBe("none");
    const call = (method: string, body?: unknown) =>
      fetch(`${laptop.daemon.url}${API_ROUTES.deviceSync}`, {
        method,
        headers: {
          authorization: `Bearer ${laptop.apiToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const put = await call("PUT", { url: server.url, vault: vault.id, token: vault.token });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain(vault.token);
    await eventually(async () =>
      expect(server.store.leaseHolder(vault.id, "agent")?.deviceName).toBe("Laptop"),
    );
    await eventually(async () => expect(await agentProblem(laptop)).toBeUndefined());
    const written = await fetch(`${laptop.daemon.url}${API_ROUTES.note("Inbox/synced.md")}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${laptop.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "- [ ] reaches the server\n" }),
    });
    expect(written.status).toBe(201);
    await eventually(async () =>
      expect(server.store.read(vault.id, "Inbox/synced.md")?.content).toBe(
        "- [ ] reaches the server\n",
      ),
    );

    expect((await call("DELETE")).status).toBe(200);
    expect(server.store.leaseHolder(vault.id, "agent")).toBeNull();
    expect((await get<SyncStatusResponse>(laptop, API_ROUTES.syncStatus)).body.target).toBe("none");
    await eventually(async () => expect(await agentProblem(laptop)).toBeUndefined());
    expect(logger.lines.join("\n")).not.toContain(vault.token);
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
