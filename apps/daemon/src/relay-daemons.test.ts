/**
 * Devices sharing one vault on an in-process sync server, agents in mock mode: the always-on
 * machine runs the agent, a laptop relays to it (its credential is the machine's master token over
 * loopback), and devices that can't reach it show its work read-only from the synced sidecar.
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
  ORCHESTRATOR_THREAD_ID,
  type RoutineResponse,
  type RoutineRunResponse,
  type ThreadListResponse,
  type ThreadResponse,
} from "@ddl/core";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseTimings } from "./agent-lease";
import { loadConfig } from "./config";
import { declaredResponse, expectConforms, routePath } from "./contract-test-helpers";
import type { LinkTimings } from "./relay/link";
import { RELAY_PROBLEMS } from "./relay/relay";
import {
  type MachineCredential,
  SettableMachineCredential,
  SettablePlacement,
} from "./relay/sources";
import { RecordingLogger, TestSocket } from "./security/harness";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 30_000 * TIME_SCALE;
const LEASE: Partial<LeaseTimings> = {
  ttlMs: 5_000,
  renewEveryMs: 500,
  retryEveryMs: 200,
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
  placement: SettablePlacement;
  machine: SettableMachineCredential;
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
  options: { placement: AgentPlacement; machine?: MachineCredential | null; port?: number },
): Promise<Device> {
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
    DDL_PORT: String(options.port ?? 0),
    DDL_LOG_LEVEL: "debug",
    DDL_SYNC_URL: server.url,
    DDL_SYNC_VAULT: vault.id,
  };
  const config = loadConfig({ env, cwd: root, homedir: root, platform: "linux" });
  const placement = new SettablePlacement(options.placement);
  const machine = new SettableMachineCredential(options.machine ?? null);
  const daemon = await startDaemon({
    config,
    env,
    logger: logger.child({ device: name }),
    leaseTimings: LEASE,
    placement,
    machine,
    relayLinkTimings: LINK,
  });
  running.push(daemon);
  const apiToken = readFileSync(config.tokenPath, "utf8").trim();
  return { name, daemon, apiToken, root, placement, machine };
}

const credentialFor = (device: Device): MachineCredential => ({
  url: device.daemon.url,
  token: device.apiToken,
});

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
  const binary = declaredResponse(name, method, response.status)?.kind === "binary";
  const body = binary ? await response.arrayBuffer() : await response.json().catch(() => undefined);
  expectConforms(name, method, response.status, body);
  return { status: response.status, body: body as T };
}

const status = async (device: Device) =>
  (await call<AgentStatusResponse>(device, "GET", "agentStatus")).body;

async function openSocket(device: Device): Promise<TestSocket> {
  const socket = await TestSocket.open(
    `${device.daemon.url.replace("http", "ws")}${API_ROUTES.ws}`,
    {
      headers: { authorization: `Bearer ${device.apiToken}` },
    },
  );
  sockets.push(socket);
  await socket.next("hello");
  return socket;
}

const eventually = (assertion: () => Promise<void>) =>
  vi.waitFor(assertion, { timeout: WAIT_MS, interval: 100 });

const sayToOrchestrator = (device: Device, text: string) =>
  call(device, "POST", "threadMessages", {
    params: { id: ORCHESTRATOR_THREAD_ID },
    json: { text },
  });

const threadText = (thread: ThreadResponse["thread"]) =>
  thread.messages.map((message) => (message.kind === "text" ? message.text : "")).join("\n");

/** The machine runs the agent; waits until it does. */
async function startMachine(port?: number): Promise<Device> {
  const machine = await startDevice("Machine", {
    placement: "always_on_host",
    ...(port ? { port } : {}),
  });
  await eventually(async () => expect((await status(machine)).problem).toBeUndefined());
  return machine;
}

/** A laptop relaying to `machine`; waits until the link is up. */
async function startLaptop(machine: Device): Promise<Device> {
  const laptop = await startDevice("Laptop", {
    placement: "always_on_machine",
    machine: credentialFor(machine),
  });
  await eventually(async () => expect((await status(laptop)).placement?.relay).toBe("connected"));
  return laptop;
}

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

describe("the agent relay between daemons", { timeout: 120_000 * TIME_SCALE }, () => {
  it("lets a laptop show and act on the always-on machine's agent", async () => {
    const machine = await startMachine();
    await call(machine, "PATCH", "settings", { json: { agent: { settleMs: 200 } } });
    const laptop = await startLaptop(machine);
    const socket = await openSocket(laptop);
    expect(await status(laptop)).toMatchObject({
      mode: "mock",
      placement: { placement: "always_on_machine", relay: "connected" },
    });

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
    const chat = await call<ThreadResponse>(laptop, "GET", "thread", {
      params: { id: ORCHESTRATOR_THREAD_ID },
    });
    expect(threadText(chat.body.thread)).toContain("What can you do?");

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
      {
        query: { notePath },
      },
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
    expect([200, 202]).toContain(
      (
        await call(laptop, "POST", "threadMessages", {
          params: { id: threadId },
          json: { text: "Thanks!" },
        })
      ).status,
    );
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
    expect(lines).not.toContain(machine.apiToken);
    expect(lines).not.toContain(vault.token);
    expect(lines).not.toContain("Thanks!");
  });

  it("goes read-only while the machine is down and recovers when it returns", async () => {
    const machine = await startMachine();
    const laptop = await startLaptop(machine);
    const socket = await openSocket(laptop);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Remember the plants")).status);
    await chatSyncedTo(laptop, "Remember the plants");

    await machine.daemon.close();
    await eventually(async () =>
      expect((await status(laptop)).placement?.relay).toBe("unreachable"),
    );
    await socket.next("agent.status", (e) => e.status.placement?.relay === "unreachable", WAIT_MS);
    expect((await status(laptop)).problem).toBe(RELAY_PROBLEMS.unreachable);
    const threads = await call<ThreadListResponse>(laptop, "GET", "threads");
    expect(threads.body.threads.map((t) => t.id)).toContain(ORCHESTRATOR_THREAD_ID);
    const chat = await call<ThreadResponse>(laptop, "GET", "thread", {
      params: { id: ORCHESTRATOR_THREAD_ID },
    });
    expect(threadText(chat.body.thread)).toContain("Remember the plants");
    expect((await sayToOrchestrator(laptop, "Are you there?")).body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.unreachable,
    });
    const cancel = await call(laptop, "POST", "threadCancel", {
      params: { id: ORCHESTRATOR_THREAD_ID },
    });
    expect(cancel.status).toBe(503);

    await startMachine(machine.daemon.port);
    await eventually(async () => expect((await status(laptop)).placement?.relay).toBe("connected"));
    await socket.next("agent.status", (e) => e.status.placement?.relay === "connected", WAIT_MS);
    expect([200, 202]).toContain((await sayToOrchestrator(laptop, "Back again")).status);
  });

  it("shows the synced work read-only where the machine's agent can't be reached", async () => {
    const machine = await startMachine();
    expect([200, 202]).toContain((await sayToOrchestrator(machine, "Water the plants")).status);
    const unpaired = await startDevice("Laptop", { placement: "always_on_machine", machine: null });
    const desktop = await startDevice("Desktop", { placement: "this_device" });
    await eventually(async () =>
      expect((await status(desktop)).problem).toBe("The agent is running on Machine."),
    );
    expect(await status(unpaired)).toMatchObject({
      problem: RELAY_PROBLEMS.notPaired,
      placement: { placement: "always_on_machine", relay: "not_paired" },
    });

    for (const [device, problem] of [
      [unpaired, RELAY_PROBLEMS.notPaired],
      [desktop, "The agent is running on Machine."],
    ] as const) {
      await chatSyncedTo(device, "Water the plants");
      await eventually(async () => {
        const chat = await call<ThreadResponse>(device, "GET", "thread", {
          params: { id: ORCHESTRATOR_THREAD_ID },
        });
        expect(threadText(chat.body.thread)).toContain("Water the plants");
      });
      const threads = await call<ThreadListResponse>(device, "GET", "threads");
      expect(threads.body.threads.map((t) => t.id)).toContain(ORCHESTRATOR_THREAD_ID);
      expect((await call(device, "GET", "approvals")).status).toBe(200);
      expect((await sayToOrchestrator(device, "Hello?")).body).toEqual({
        error: "agent_unavailable",
        message: problem,
      });
    }
  });
});
