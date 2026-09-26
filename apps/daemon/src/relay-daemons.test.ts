/**
 * Devices sharing one vault on an in-process sync server, agents in mock mode, set up the way
 * users do it: placement in each device's config, the always-on machine in the vault's settings,
 * and a laptop paired with the machine through a pairing code. The machine runs the agent, the
 * laptop relays to it, and devices that can't act on it show its work read-only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpMethod } from "@ddl/contract";
import {
  type AgentPlacement,
  type AgentStatusResponse,
  API_ROUTES,
  type ApiRouteName,
  type ApprovalListResponse,
  type MachineStatusResponse,
  ORCHESTRATOR_THREAD_ID,
  type PairedDevicesResponse,
  type PairingCodeResponse,
  type RoutineResponse,
  type RoutineRunResponse,
  type SettingsResponse,
  type ThreadListResponse,
  type ThreadResponse,
} from "@ddl/core";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeaseTimings } from "./agent-lease";
import { loadConfig } from "./config";
import { declaredResponse, expectConforms, routePath } from "./contract-test-helpers";
import { MACHINE_TOKEN_FILE } from "./machine-link";
import type { LinkTimings } from "./relay/link";
import { RELAY_PROBLEMS } from "./relay/relay";
import { eventually, RecordingLogger, TestSocket } from "./security/harness";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 30_000 * TIME_SCALE;
const LEASE: Partial<LeaseTimings> = {
  ttlMs: 5_000,
  renewEveryMs: 500,
  retryEveryMs: 200,
  takeoverRetryMs: 100,
  maxBackoffMs: 1_000,
  marginMs: 1_000,
};
const LINK: Partial<LinkTimings> = { pingEveryMs: 500, minBackoffMs: 50, maxBackoffMs: 500 };
const TASK = "Order a replacement water filter";

interface Device {
  name: string;
  daemon: RunningDaemon;
  apiToken: string;
  root: string;
  home: string;
}

let dir: { path: string; cleanup: () => void };
let server: RunningSyncServer;
let vault: { id: string; token: string };
let logger: RecordingLogger;
const running: RunningDaemon[] = [];
const sockets: TestSocket[] = [];

beforeEach(async () => {
  dir = tempDir("ddl-relay-daemons-");
  server = await createSyncServer({ db: ":memory:", port: 0 });
  const created = server.store.createVault("Shared vault");
  vault = { id: created.vault.id, token: created.token };
  logger = new RecordingLogger();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.ws.terminate();
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await server.close();
  dir.cleanup();
});

async function startDevice(
  name: string,
  options: { placement: AgentPlacement; port?: number },
): Promise<Device> {
  const root = join(dir.path, name);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "sync-token"), `${vault.token}\n`, { mode: 0o600 });
  writeFileSync(
    join(home, "device.json"),
    JSON.stringify({ id: `dev_${name.toLowerCase()}`, name }),
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ agent: { placement: options.placement } }),
  );
  const env = {
    DDL_HOME: home,
    DDL_VAULT: join(root, "vault"),
    DDL_WEB_DIST: join(root, "no-web-build"),
    DDL_AGENT_MODE: "mock",
    DDL_PORT: String(options.port ?? 0),
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
    relayLinkTimings: LINK,
  });
  running.push(daemon);
  const apiToken = readFileSync(config.tokenPath, "utf8").trim();
  return { name, daemon, apiToken, root, home };
}

/** Calls a route of the contract and checks the answer against it. */
async function call<T = unknown>(
  device: Device,
  method: HttpMethod,
  name: ApiRouteName,
  init: { params?: Record<string, string>; query?: Record<string, string>; json?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const search = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const response = await fetch(`${device.daemon.url}${routePath(name, init.params)}${search}`, {
    method,
    headers: {
      authorization: `Bearer ${device.apiToken}`,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const kind = declaredResponse(name, method, response.status)?.kind;
  const body =
    kind === "binary"
      ? await response.arrayBuffer()
      : kind === "empty"
        ? undefined
        : await response.json().catch(() => undefined);
  expectConforms(name, method, response.status, body);
  return { status: response.status, body: body as T };
}

const status = async (device: Device) =>
  (await call<AgentStatusResponse>(device, "GET", "agentStatus")).body;

async function openSocket(device: Device): Promise<TestSocket> {
  const socket = await TestSocket.open(
    `${device.daemon.url.replace("http", "ws")}${API_ROUTES.ws}`,
    { headers: { authorization: `Bearer ${device.apiToken}` } },
  );
  sockets.push(socket);
  await socket.next("hello");
  return socket;
}

const sayToOrchestrator = (device: Device, text: string) =>
  call(device, "POST", "threadMessages", {
    params: { id: ORCHESTRATOR_THREAD_ID },
    json: { text },
  });

const threadText = (thread: ThreadResponse["thread"]) =>
  thread.messages.map((message) => (message.kind === "text" ? message.text : "")).join("\n");

const leaseHolder = () => server.store.leaseHolder(vault.id, "agent");

/** The machine runs the agent; waits until it does. */
async function startMachine(port?: number): Promise<Device> {
  const machine = await startDevice("Machine", {
    placement: "always_on_host",
    ...(port ? { port } : {}),
  });
  await eventually(async () => expect((await status(machine)).problem).toBeUndefined());
  return machine;
}

/**
 * A laptop set to use the always-on machine. Until it pairs, the vault has no always-on machine,
 * so its agent is held on it (and the machine, first to ask, holds the lease).
 */
async function startLaptop(): Promise<Device> {
  const laptop = await startDevice("Laptop", { placement: "always_on_machine" });
  await eventually(async () =>
    expect(await status(laptop)).toMatchObject({
      problem: "The agent is running on Machine.",
      placement: { placement: "always_on_machine", heldHere: "no_machine", relay: "off" },
    }),
  );
  return laptop;
}

/** Pairs `laptop` with `machine` using a code the machine issued, as Settings does. */
async function pair(laptop: Device, machine: Device): Promise<void> {
  const issued = await call<PairingCodeResponse>(machine, "POST", "pairingCodes", {
    json: { name: laptop.name },
  });
  expect(issued.status).toBe(201);
  const paired = await call<MachineStatusResponse>(laptop, "POST", "machinePair", {
    json: { url: machine.daemon.url, code: issued.body.code, name: machine.name },
  });
  expect(paired.body).toMatchObject({
    paired: true,
    reachable: true,
    machine: { name: machine.name, url: machine.daemon.url },
  });
}

const relayOf = async (device: Device) => (await status(device)).placement?.relay;

async function startPairedLaptop(machine: Device): Promise<Device> {
  const laptop = await startLaptop();
  await pair(laptop, machine);
  await eventually(async () => expect(await relayOf(laptop)).toBe("connected"));
  return laptop;
}

/** This device's token for the machine, as the machine link saved it. */
const machineToken = (device: Device): string =>
  (JSON.parse(readFileSync(join(device.home, MACHINE_TOKEN_FILE), "utf8")) as { token: string })
    .token;

/** Waits until sync has brought the orchestrator's chat, holding `text`, into `device`'s vault. */
async function chatSyncedTo(device: Device, text: string): Promise<void> {
  const file = join(
    device.root,
    "vault",
    ".daily-do-list",
    "threads",
    `${ORCHESTRATOR_THREAD_ID}.json`,
  );
  await eventually(async () => expect(readFileSync(file, "utf8")).toContain(text));
}

/** The orchestrator's chat as `device` serves it holds `text` (read-only views follow sync). */
async function chatShows(device: Device, text: string): Promise<void> {
  await eventually(async () => {
    const chat = await call<ThreadResponse>(device, "GET", "thread", {
      params: { id: ORCHESTRATOR_THREAD_ID },
    });
    expect(threadText(chat.body.thread)).toContain(text);
  });
}

describe("the agent relay between daemons", { timeout: 120_000 * TIME_SCALE }, () => {
  it("lets a paired laptop show and act on the always-on machine's agent", async () => {
    const machine = await startMachine();
    await call(machine, "PATCH", "settings", { json: { agent: { settleMs: 200 } } });
    const laptop = await startLaptop();
    // Pairing changes the vault's settings: start from the machine's.
    await eventually(async () =>
      expect(
        (await call<SettingsResponse>(laptop, "GET", "settings")).body.settings.agent.settleMs,
      ).toBe(200),
    );
    await pair(laptop, machine);
    await eventually(async () =>
      expect(await status(laptop)).toMatchObject({
        mode: "mock",
        placement: {
          placement: "always_on_machine",
          relay: "connected",
          runsOn: { name: "Machine", thisDevice: false, alwaysOnMachine: true },
        },
      }),
    );
    expect((await status(laptop)).problem).toBeUndefined();
    const socket = await openSocket(laptop);

    // The orchestrator chat.
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "What can you do?")).status);
    await socket.next(
      "thread.message",
      (e) =>
        e.threadId === ORCHESTRATOR_THREAD_ID &&
        e.message.kind === "text" &&
        e.message.role === "agent",
      WAIT_MS,
    );
    await chatShows(laptop, "What can you do?");

    // A task on the machine: its thread, records, artifact and approval, through the laptop.
    const daily = await call<{ path: string }>(machine, "GET", "daily", {
      params: { date: "today" },
      query: { create: "1" },
    });
    const notePath = daily.body.path;
    await call(machine, "PUT", "note", {
      params: { path: notePath },
      json: { content: `- [ ] ${TASK}\n` },
    });
    const pending = await socket.next(
      "approval.upsert",
      (e) => e.approval.status === "pending",
      WAIT_MS,
    );
    const threadId = pending.approval.threadId!;
    await socket.next("thread.upsert", (e) => e.thread.id === threadId, WAIT_MS);
    const approvals = await call<ApprovalListResponse>(laptop, "GET", "approvals", {
      query: { status: "pending" },
    });
    expect(approvals.body.approvals.map((a) => a.id)).toEqual([pending.approval.id]);
    const threads = await call<ThreadListResponse>(laptop, "GET", "threads", {
      query: { notePath },
    });
    expect(threads.body.threads.map((t) => t.id)).toEqual([threadId]);
    const records = await call<{ records: Array<{ threadId: string | null }> }>(
      laptop,
      "GET",
      "tasks",
      { query: { notePath } },
    );
    expect(records.body.records.map((r) => r.threadId)).toEqual([threadId]);
    const thread = (
      await call<ThreadResponse>(laptop, "GET", "thread", { params: { id: threadId } })
    ).body.thread;
    const [artifact] = thread.artifacts;
    expect(artifact).toBeDefined();
    const bytes = await call<ArrayBuffer>(laptop, "GET", "artifact", {
      params: { threadId, artifactId: artifact!.id },
    });
    const direct = await call<ArrayBuffer>(machine, "GET", "artifact", {
      params: { threadId, artifactId: artifact!.id },
    });
    expect(Buffer.from(bytes.body).equals(Buffer.from(direct.body))).toBe(true);

    const decided = await call(laptop, "POST", "approval", {
      params: { id: pending.approval.id },
      json: { decision: "approve", scope: "once" },
    });
    expect(decided.body).toMatchObject({ approval: { status: "approved" } });
    await eventually(async () => {
      const current = await call<ThreadResponse>(laptop, "GET", "thread", {
        params: { id: threadId },
      });
      expect(current.body.thread.status).toBe("done");
    });
    const reply = await call(laptop, "POST", "threadMessages", {
      params: { id: threadId },
      json: { text: "Thanks!" },
    });
    expect([200, 202]).toContain(reply.status);
    await eventually(async () => {
      const onMachine = await call<ThreadResponse>(machine, "GET", "thread", {
        params: { id: threadId },
      });
      expect(threadText(onMachine.body.thread)).toContain("Thanks!");
    });

    // Routines: created on the machine, run there now.
    const created = await call<RoutineResponse>(laptop, "POST", "routines", {
      json: {
        name: "Morning briefing",
        schedule: "every weekday at 7:30",
        instructions: "Brief me for the day.",
      },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const run = await call<RoutineRunResponse>(laptop, "POST", "routineRun", {
      params: { id: routineId },
    });
    expect(run.status).toBe(200);
    await socket.next(
      "routines.changed",
      (e) => e.routines.some((r) => r.id === routineId),
      WAIT_MS,
    );
    const runs = await call<ThreadListResponse>(laptop, "GET", "threads", { query: { routineId } });
    expect(runs.body.threads.map((t) => t.id)).toContain(run.body.threadId);

    const lines = logger.lines.join("\n");
    expect(lines).not.toContain(machineToken(laptop));
    expect(lines).not.toContain(machine.apiToken);
    expect(lines).not.toContain(vault.token);
    expect(lines).not.toContain("Thanks!");
  });

  it("goes read-only while the machine is down and recovers when it returns", async () => {
    const machine = await startMachine();
    const laptop = await startPairedLaptop(machine);
    const socket = await openSocket(laptop);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Remember the plants")).status);
    await chatSyncedTo(laptop, "Remember the plants");

    await machine.daemon.close();
    await eventually(async () => expect(await relayOf(laptop)).toBe("unreachable"));
    await socket.next("agent.status", (e) => e.status.placement?.relay === "unreachable", WAIT_MS);
    expect((await status(laptop)).problem).toBe(RELAY_PROBLEMS.unreachable);
    await chatShows(laptop, "Remember the plants");
    const threads = await call<ThreadListResponse>(laptop, "GET", "threads");
    expect(threads.body.threads.map((t) => t.id)).toContain(ORCHESTRATOR_THREAD_ID);
    expect((await sayToOrchestrator(laptop, "Are you there?")).body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.unreachable,
    });
    const cancel = await call(laptop, "POST", "threadCancel", {
      params: { id: ORCHESTRATOR_THREAD_ID },
    });
    expect(cancel.status).toBe(503);
    // The laptop never asks for the lease: the machine gets it back when it returns.
    expect(leaseHolder()).toBeNull();

    await startMachine(machine.daemon.port);
    await eventually(async () => expect(await relayOf(laptop)).toBe("connected"));
    await socket.next("agent.status", (e) => e.status.placement?.relay === "connected", WAIT_MS);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Back again")).status);
    expect(leaseHolder()?.device).toBe("dev_machine");
  });

  it("switches live: pairing, running here, relaying again", async () => {
    const machine = await startMachine();
    const laptop = await startLaptop();
    await pair(laptop, machine);
    await eventually(async () => expect(await relayOf(laptop)).toBe("connected"));
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Paired now")).status);
    await chatShows(laptop, "Paired now");

    // Running it on this device: it outranks the always-on machine and takes the agent over.
    await call(laptop, "PATCH", "device", { json: { placement: "this_device" } });
    await eventually(async () => expect(leaseHolder()?.device).toBe("dev_laptop"));
    // The placement and the problem come from different sources and can take a moment to agree.
    await eventually(async () => {
      const current = await status(laptop);
      expect(current).toMatchObject({
        placement: { placement: "this_device", relay: "off", runsOn: { thisDevice: true } },
      });
      expect(current.problem).toBeUndefined();
    });
    await chatShows(laptop, "Paired now");
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Now here")).status);
    await eventually(async () =>
      expect((await status(machine)).problem).toBe("The agent is running on Laptop."),
    );

    // And back to the always-on machine, through the relay again.
    await call(laptop, "PATCH", "device", { json: { placement: "always_on_machine" } });
    await eventually(async () => expect(leaseHolder()?.device).toBe("dev_machine"));
    await eventually(async () => expect((await status(machine)).problem).toBeUndefined());
    await eventually(async () => expect(await relayOf(laptop)).toBe("connected"));
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "And back")).status);
    await chatShows(machine, "And back");
  });

  it("tells a revoked laptop to pair again, and one without a credential that it isn't paired", async () => {
    const machine = await startMachine();
    const laptop = await startPairedLaptop(machine);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Water the plants")).status);

    // The machine revokes the laptop: its socket closes and the credential stops working.
    const devices = await call<PairedDevicesResponse>(machine, "GET", "devices");
    const id = devices.body.devices.find((device) => device.name === laptop.name)?.id;
    expect(id).toBeDefined();
    expect((await call(machine, "DELETE", "pairedDevice", { params: { id: id! } })).status).toBe(
      204,
    );
    await eventually(async () =>
      expect(await status(laptop)).toMatchObject({
        problem: RELAY_PROBLEMS.rejected,
        placement: { placement: "always_on_machine", relay: "not_paired" },
      }),
    );
    expect((await sayToOrchestrator(laptop, "Hello?")).body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.rejected,
    });

    // Paired again, then forgotten: no credential at all.
    await pair(laptop, machine);
    await eventually(async () => expect(await relayOf(laptop)).toBe("connected"));
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Paired again")).status);
    const forgotten = await call<MachineStatusResponse>(laptop, "DELETE", "machinePairing");
    expect(forgotten.body).toMatchObject({ paired: false, machine: { name: machine.name } });
    await eventually(async () =>
      expect(await status(laptop)).toMatchObject({
        problem: RELAY_PROBLEMS.notPaired,
        placement: { placement: "always_on_machine", relay: "not_paired" },
      }),
    );
    await chatSyncedTo(laptop, "Paired again");
    await chatShows(laptop, "Paired again");
    const threads = await call<ThreadListResponse>(laptop, "GET", "threads");
    expect(threads.body.threads.map((t) => t.id)).toContain(ORCHESTRATOR_THREAD_ID);
    expect((await call(laptop, "GET", "approvals")).status).toBe(200);
    expect((await sayToOrchestrator(laptop, "Hello?")).body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.notPaired,
    });
    expect(leaseHolder()?.device).toBe("dev_machine");
  });

  it("shows the agent read-only where another device runs it, relayed or not", async () => {
    const machine = await startMachine();
    const laptop = await startPairedLaptop(machine);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Water the plants")).status);
    // The vault's always-on machine reached the machine: it now holds the lease as the host.
    await eventually(async () =>
      expect(leaseHolder()).toMatchObject({ device: "dev_machine", priority: "host" }),
    );

    // A desktop that runs the agent itself takes it over from the always-on machine.
    // It joins a vault whose settings changed (the always-on machine), and must not reset them.
    const desktop = await startDevice("Desktop", { placement: "this_device" });
    await eventually(async () => expect(leaseHolder()?.device).toBe("dev_desktop"));
    const settings = await call<SettingsResponse>(desktop, "GET", "settings");
    expect(settings.body.settings.remote.alwaysOnMachine?.name).toBe("Machine");
    const elsewhere = "The agent is running on Desktop.";
    await eventually(async () => expect((await status(machine)).problem).toBe(elsewhere));

    // The machine shows the synced work read-only and says where the agent runs.
    await chatShows(machine, "Water the plants");
    expect((await sayToOrchestrator(machine, "Hello?")).body).toEqual({
      error: "agent_unavailable",
      message: elsewhere,
    });
    // The laptop keeps relaying to the machine, and gets its read-only answers.
    await eventually(async () =>
      expect(await status(laptop)).toMatchObject({
        problem: elsewhere,
        placement: { relay: "connected", runsOn: { name: "Desktop", thisDevice: false } },
      }),
    );
    await chatShows(laptop, "Water the plants");
    expect((await sayToOrchestrator(laptop, "Hello?")).body).toEqual({
      error: "agent_unavailable",
      message: elsewhere,
    });
  });
});
