/**
 * The relay against a fake always-on machine (the daemon's app and WebSocket hub over a
 * FakeAgentRuntime on a loopback port), a raw recording server that shows exactly what leaves this
 * device, and a TCP proxy that cuts, stalls and restores the way to the machine.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer, type Socket } from "node:net";
import {
  type AgentPlacement,
  type AgentStatusResponse,
  API_ROUTES,
  API_VERSION,
  type OrchestratorActivity,
  type OrchestratorTrigger,
  summarizeThread,
  type ThreadListResponse,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { MachineCredential } from "../agent-location";
import { createApp } from "../app";
import { contractClient } from "../contract-test-helpers";
import { createSecurityPolicy } from "../security";
import {
  type MemoryLiveApp,
  RecordingLogger,
  startLiveApp,
  TestSocket,
  waitFor,
} from "../security/harness";
import { createSettingsStore } from "../settings-store";
import {
  createTestApp,
  FakeAgentRuntime,
  makeApproval,
  makeThread,
  SettableMachineCredential,
  SettablePlacement,
  testToken,
} from "../test-helpers";
import { WriteTracker } from "../write-tracker";
import { attachWebSocketHub } from "../ws";
import { callMachine, MachineUnavailableError } from "./http";
import type { LinkTimings } from "./link";
import { AgentRelay, RELAY_PROBLEMS } from "./relay";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 10_000 * TIME_SCALE;
const LINK: Partial<LinkTimings> = { pingEveryMs: 100, minBackoffMs: 20, maxBackoffMs: 200 };

const BRIEFING = {
  name: "Morning briefing",
  schedule: "every weekday at 7:30",
  instructions: "Brief me for the day: calendar, weather, leftovers.",
};

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Recorder {
  url: string;
  requests: Recorded[];
  /** WebSocket upgrades (answered with the daemon's `hello`). */
  upgrades: Array<{ url: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An HTTP server that records every request and upgrade, and answers with `respond`. */
async function startRecorder(
  respond: (request: Recorded, res: ServerResponse) => void = (_request, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end('{"threads":[]}');
  },
  options: { websocket?: boolean } = {},
): Promise<Recorder> {
  const requests: Recorded[] = [];
  const upgrades: Recorder["upgrades"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(request);
      respond(request, res);
    });
  });
  const wss = options.websocket ? new WebSocketServer({ server }) : null;
  wss?.on("connection", (ws, req) => {
    upgrades.push({ url: req.url ?? "", headers: req.headers });
    ws.send(JSON.stringify({ type: "hello", serverVersion: "test", apiVersion: API_VERSION }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    for (const client of wss?.clients ?? []) client.terminate();
    wss?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    upgrades,
    close,
  };
}

async function closedPortUrl(): Promise<string> {
  const recorder = await startRecorder();
  await recorder.close();
  return recorder.url;
}

/**
 * The machine behind a TCP proxy that can be cut (connections dropped, port closed), stalled and
 * healed. The machine allows the proxy's Host, the way it allows its remote hosts.
 */
async function proxiedMachine() {
  let port = 0;
  const pairs = new Set<[Socket, Socket]>();
  const server = createTcpServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      pairs.delete(pair);
    };
    for (const socket of pair) {
      socket.on("error", end);
      socket.on("close", end);
    }
  });
  const listen = (at: number) =>
    new Promise<void>((resolve) => server.listen(at, "127.0.0.1", () => resolve()));
  await listen(0);
  const own = (server.address() as AddressInfo).port;
  const cut = async () => {
    for (const [a, b] of pairs) {
      a.destroy();
      b.destroy();
    }
    pairs.clear();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(cut);
  const url = `http://127.0.0.1:${own}`;
  const target = await startLiveApp({
    runtime: machineRuntime,
    allowedOrigins: [url],
    hub: { coalesceMs: 5 },
  });
  cleanups.push(() => target.close());
  port = target.port;
  return {
    credential: { url, token: target.token },
    cut,
    heal: () => listen(own),
    /** Open connections stop carrying bytes (a network black hole); new ones work. */
    stall: () => {
      for (const [a, b] of pairs) {
        a.unpipe(b);
        b.unpipe(a);
        a.pause();
        b.pause();
      }
    },
  };
}

let machine: MemoryLiveApp;
let machineRuntime: FakeAgentRuntime;
let machineLog: RecordingLogger;

beforeEach(async () => {
  machineRuntime = new FakeAgentRuntime();
  machineRuntime.threads.set("thr_1", makeThread("thr_1"));
  machineRuntime.approvals = [makeApproval("apr_1")];
  machineRuntime.records.set("Daily/2026-09-23.md", [
    {
      taskId: "task_thr_1",
      notePath: "Daily/2026-09-23.md",
      date: "2026-09-23",
      text: "Find a dentist",
      line: 0,
      status: "working",
      threadId: "thr_1",
      updatedAt: 2,
      unread: 0,
    },
  ]);
  machineRuntime.artifacts.set("thr_1/art_1", {
    meta: {
      id: "art_1",
      threadId: "thr_1",
      title: "Dentists nearby",
      kind: "markdown",
      mimeType: "text/markdown",
      path: ".daily-do-list/artifacts/thr_1/art_1.md",
      size: 12,
      createdAt: 1,
    },
    body: new TextEncoder().encode("# Dentists\n\n"),
  });
  machineLog = new RecordingLogger();
  machine = await startLiveApp({
    runtime: machineRuntime,
    logger: machineLog,
    hub: { coalesceMs: 5 },
  });
  cleanups.push(() => machine.close());
});

const machineCredential = (url = `http://127.0.0.1:${machine.port}`): MachineCredential => ({
  url,
  token: machine.token,
});

interface DeviceOptions {
  credential?: MachineCredential | null;
  placement?: AgentPlacement;
  timeoutMs?: number;
  /** Start the relay (its link connects). Default true. */
  start?: boolean;
}

/** This device: its own runtime (with a thread the machine doesn't have) behind the relay. */
async function relayed(options: DeviceOptions) {
  const local = new FakeAgentRuntime();
  local.threads.set("thr_local", makeThread("thr_local", { title: "Only on this device" }));
  const placement = new SettablePlacement(options.placement ?? "always_on_machine");
  const machineSource = new SettableMachineCredential(
    options.credential === undefined ? machineCredential() : options.credential,
  );
  const logger = new RecordingLogger();
  const relay = new AgentRelay({
    local,
    placement,
    machine: machineSource,
    logger,
    linkTimings: LINK,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const setRelay = vi.spyOn(placement, "setRelay");
  if (options.start !== false) await relay.start();
  cleanups.push(() => relay.stop());
  const states = () => setRelay.mock.calls.map(([state]) => state);
  return { local, relay, placement, machineSource, logger, states };
}

async function device(options: DeviceOptions = {}) {
  const parts = await relayed(options);
  const app = await createTestApp({
    runtime: parts.relay,
    relay: parts.relay,
    logger: parts.logger,
  });
  return { ...parts, app, api: contractClient(app) };
}

/** This device on a real loopback server with its WebSocket hub, and a client connected to it. */
async function liveDevice(options: DeviceOptions = {}) {
  const parts = await relayed(options);
  const { relay, logger } = parts;
  const token = testToken();
  let handler: Parameters<typeof getRequestListener>[0] = () => new Response(null, { status: 503 });
  const server = createServer(getRequestListener((request, env) => handler(request, env)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const storage = new MemoryStorageProvider();
  const settings = await createSettingsStore({ storage });
  const writes = new WriteTracker();
  handler = createApp({
    storage,
    runtime: relay,
    settings,
    config: { port, allowedOrigins: [] },
    token,
    logger,
    writes,
    relay,
  }).fetch;
  const hub = attachWebSocketHub({
    server,
    policy: createSecurityPolicy({ port, token }),
    storage,
    runtime: relay,
    settings,
    writes,
    logger,
    coalesceMs: 5,
  });
  cleanups.push(async () => {
    await hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = await TestSocket.open(`ws://127.0.0.1:${port}${API_ROUTES.ws}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  cleanups.push(async () => client.ws.terminate());
  await client.next("hello");
  return { ...parts, client };
}

const connected = (relay: AgentRelay) => waitFor(() => relay.state === "connected", WAIT_MS);
const threadIds = (body: unknown) => (body as ThreadListResponse).threads.map((t) => t.id);
const machinePaths = () => machineLog.lines.filter((line) => line.startsWith("debug api "));

describe("the agent relay over HTTP", () => {
  it("forwards the agent's reads to the machine and keeps notes and settings local", async () => {
    const { app, api, relay } = await device();
    await connected(relay);

    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_1"]);
    expect((await api.call("thread", "GET", { params: { id: "thr_1" } })).status).toBe(200);
    expect((await api.call("thread", "GET", { params: { id: "thr_local" } })).status).toBe(404);
    expect((await api.call("approvals", "GET", { query: { status: "pending" } })).body).toEqual({
      approvals: [makeApproval("apr_1")],
    });
    expect((await api.call("approval", "GET", { params: { id: "apr_1" } })).status).toBe(200);
    const tasks = await api.call("tasks", "GET", { query: { notePath: "Daily/2026-09-23.md" } });
    expect((tasks.body as { records: unknown[] }).records).toHaveLength(1);

    const artifact = await app.request("/api/artifacts/thr_1/art_1");
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe("# Dentists\n\n");
    expect(artifact.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(artifact.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(artifact.headers.get("content-disposition")).toMatch(/^inline; filename="Dentists/);

    const note = await api.call("note", "PUT", {
      params: { path: "Inbox.md" },
      json: { content: "- [ ] x" },
    });
    expect(note.status).toBe(201);
    expect((await api.call("note", "GET", { params: { path: "Inbox.md" } })).status).toBe(200);
    expect(await machine.storage.read("Inbox.md")).toBeNull();
    expect((await api.call("settings", "GET")).status).toBe(200);
    expect((await api.call("syncStatus", "GET")).status).toBe(200);
    expect(machinePaths().some((line) => /\/api\/(notes|settings|sync)/.test(line))).toBe(false);
  });

  it("forwards agent actions and routine changes, and never acts on this device", async () => {
    const { api, local, relay } = await device();
    await connected(relay);

    const message = await api.call("threadMessages", "POST", {
      params: { id: "thr_1" },
      json: { text: "Prefer mornings" },
    });
    expect(message.body).toEqual({ ok: true });
    expect(machineRuntime.callsTo("postUserMessage")).toEqual([["thr_1", "Prefer mornings"]]);
    expect((await api.call("threadCancel", "POST", { params: { id: "thr_1" } })).status).toBe(200);
    expect((await api.call("threadRetry", "POST", { params: { id: "thr_1" } })).status).toBe(200);
    const decided = await api.call("approval", "POST", {
      params: { id: "apr_1" },
      json: { decision: "approve", scope: "once" },
    });
    expect(decided.body).toMatchObject({ approval: { id: "apr_1", status: "approved" } });
    const again = await api.call("approval", "POST", {
      params: { id: "apr_1" },
      json: { decision: "deny" },
    });
    expect(again.status).toBe(409);

    const created = await api.call("routines", "POST", { json: BRIEFING });
    expect(created.status).toBe(201);
    const id = (created.body as { routine: { id: string } }).routine.id;
    expect(machineRuntime.routineLibrary.get(id)?.name).toBe("Morning briefing");
    expect(local.routineLibrary.get(id)).toBeUndefined();
    const listed = await api.call("routines", "GET");
    expect((listed.body as { routines: Array<{ id: string }> }).routines.map((r) => r.id)).toEqual([
      id,
    ]);
    expect((await api.call("routine", "GET", { params: { id } })).status).toBe(200);
    expect((await api.call("routineRun", "POST", { params: { id } })).body).toMatchObject({
      threadId: "thr_run_1",
    });
    const paused = await api.call("routinePause", "POST", { params: { id } });
    expect(paused.body).toMatchObject({ routine: { paused: true } });
    const resumed = await api.call("routineResume", "POST", { params: { id } });
    expect(resumed.body).toMatchObject({ routine: { paused: false } });

    for (const method of [
      "postUserMessage",
      "cancelThread",
      "retryThread",
      "decideApproval",
      "runRoutine",
    ]) {
      expect(local.callsTo(method)).toEqual([]);
    }
  });

  it("reports the machine's agent with this device's placement", async () => {
    const { api, relay } = await device();
    await connected(relay);
    const { body } = await api.call("agentStatus", "GET");
    const status = body as AgentStatusResponse;
    expect(status).toMatchObject({
      mode: "mock",
      model: "mock",
      pendingApprovals: 1,
      execution: { provider: "fake" },
      placement: { placement: "always_on_machine", relay: "connected", runsOn: null },
    });
    expect(status.problem).toBeUndefined();
    expect(relay.status()).toEqual(status);
  });

  it("forwards nothing outside the allowlist", async () => {
    const { app, relay } = await device();
    await connected(relay);
    await waitFor(() => machinePaths().length >= 4, WAIT_MS);
    const before = machinePaths().length;
    expect((await app.request("/api/threads/thr_1", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/threads/thr_1/extra")).status).toBe(404);
    expect((await app.request("/api/threads/thr%2F1")).status).toBe(400);
    const put = await app.request("/api/approvals/apr_1", { method: "PUT", json: {} });
    expect(put.status).toBe(404);
    expect((await app.request("/api/routines/x/delete", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/connectors")).status).toBe(200);
    expect(machinePaths()).toHaveLength(before);
  });

  it("sends the machine only its token, the allowlisted target and a validated body", async () => {
    const recorder = await startRecorder(
      (request, res) => {
        const body = request.method === "POST" ? '{"ok":true}' : '{"threads":[]}';
        res.writeHead(200, { "content-type": "application/json" }).end(body);
      },
      { websocket: true },
    );
    const token = testToken();
    const { app, logger, relay } = await device({ credential: { url: recorder.url, token } });
    await connected(relay);
    // The resync after connecting: status, routines, approvals, threads.
    await waitFor(() => recorder.requests.length >= 4, WAIT_MS);
    await app.request("/api/threads?notePath=Daily%2Fa.md&token=leak&notePath=second&x=1", {
      origin: "http://127.0.0.1:7331",
      clientId: "client_1",
      headers: { cookie: "ddl_device=abc", "x-request-id": "req_1", "x-extra": "1" },
    });
    await app.request("/api/threads/thr_1/messages", {
      method: "POST",
      json: { text: "Prefer mornings" },
    });
    const invalid = await app.request("/api/threads/thr_1/messages", { method: "POST", json: {} });
    expect(invalid.status).toBe(400);

    expect(recorder.requests.slice(4).map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /api/threads?notePath=Daily%2Fa.md",
      "POST /api/threads/thr_1/messages",
    ]);
    for (const request of [...recorder.requests, ...recorder.upgrades]) {
      expect(request.url).not.toContain("token");
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers.host).toBe(new URL(recorder.url).host);
      for (const header of ["cookie", "origin", "x-ddl-client", "x-request-id", "x-extra"]) {
        expect(request.headers[header]).toBeUndefined();
      }
    }
    expect(recorder.upgrades.map((upgrade) => upgrade.url)).toEqual([API_ROUTES.ws]);
    const post = recorder.requests.at(-1)!;
    expect(post.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post.body)).toEqual({ text: "Prefer mornings" });
    const lines = logger.lines.join("\n");
    expect(lines).not.toContain(token);
    expect(lines).not.toContain("Prefer mornings");
  });

  it("answers from this device when the machine can't be reached", async () => {
    const { api, relay } = await device({ credential: { url: await closedPortUrl(), token: "t" } });
    await waitFor(() => relay.state === "unreachable", WAIT_MS);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    const message = await api.call("threadMessages", "POST", {
      params: { id: "thr_1" },
      json: { text: "Hi" },
    });
    expect(message.body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.unreachable,
    });
    const decide = await api.call("approval", "POST", {
      params: { id: "apr_1" },
      json: { decision: "approve" },
    });
    expect(decide.status).toBe(503);
    const created = await api.call("routines", "POST", { json: BRIEFING });
    expect(created.status).toBe(201);
    const id = (created.body as { routine: { id: string } }).routine.id;
    expect((await api.call("routineRun", "POST", { params: { id } })).status).toBe(503);
    const status = (await api.call("agentStatus", "GET")).body as AgentStatusResponse;
    expect(status).toMatchObject({
      problem: RELAY_PROBLEMS.unreachable,
      placement: { relay: "unreachable" },
    });
  });

  it("says the machine no longer accepts this device when it refuses the credential", async () => {
    const { api, relay } = await device({
      credential: { ...machineCredential(), token: "revoked" },
    });
    await waitFor(() => relay.state === "not_paired", WAIT_MS);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    const cancel = await api.call("threadCancel", "POST", { params: { id: "thr_1" } });
    expect(cancel.body).toEqual({ error: "agent_unavailable", message: RELAY_PROBLEMS.rejected });
    expect(machineRuntime.callsTo("cancelThread")).toEqual([]);
  });

  it("answers 503 when a relayed action times out", async () => {
    const hanging = await startRecorder(() => {});
    const { api } = await device({
      credential: { url: hanging.url, token: "t" },
      timeoutMs: 200,
      start: false,
    });
    const started = performance.now();
    const cancel = await api.call("threadCancel", "POST", { params: { id: "thr_1" } });
    expect(cancel.body).toEqual({
      error: "agent_unavailable",
      message: RELAY_PROBLEMS.unreachable,
    });
    expect(performance.now() - started).toBeLessThan(3_000 * TIME_SCALE);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
  });

  it("without a pairing, serves reads locally and says why actions can't run", async () => {
    const { api, relay, placement } = await device({ credential: null });
    expect(relay.state).toBe("not_paired");
    expect(placement.relay).toBe("not_paired");
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    const retry = await api.call("threadRetry", "POST", { params: { id: "thr_local" } });
    expect(retry.body).toEqual({ error: "agent_unavailable", message: RELAY_PROBLEMS.notPaired });
    const status = (await api.call("agentStatus", "GET")).body as AgentStatusResponse;
    expect(status).toMatchObject({
      problem: RELAY_PROBLEMS.notPaired,
      placement: { placement: "always_on_machine", relay: "not_paired" },
    });
    expect(machinePaths()).toEqual([]);
  });

  it("stays out of the way while the agent runs on this device", async () => {
    const { api, relay, local, placement } = await device({ placement: "this_device" });
    expect(relay.state).toBe("off");
    expect(placement.relay).toBeNull();
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    await api.call("threadMessages", "POST", { params: { id: "thr_local" }, json: { text: "Hi" } });
    expect(local.callsTo("postUserMessage")).toEqual([["thr_local", "Hi"]]);
    expect((await api.call("agentStatus", "GET")).body).toEqual(local.status());
    expect(machinePaths()).toEqual([]);
  });
});

describe("the agent relay over WebSocket", { timeout: 30_000 * TIME_SCALE }, () => {
  it("passes the machine's agent events to this device's clients, and not its own", async () => {
    const { client, relay, local } = await liveDevice();
    await connected(relay);
    await client.next("agent.status", (e) => e.status.placement?.relay === "connected", WAIT_MS);

    const thread = makeThread("thr_2", { title: "Book a table" });
    local.emit("thread.upsert", summarizeThread(makeThread("thr_local")));
    machineRuntime.emit("thread.upsert", summarizeThread(thread));
    const message = {
      id: "msg_1",
      kind: "text",
      role: "agent",
      author: "subagent:task_thr_2",
      text: "On it",
      createdAt: 3,
    } as const;
    machineRuntime.emit("thread.message", { threadId: "thr_2", message });
    machineRuntime.emit("thread.delta", { threadId: "thr_2", messageId: "msg_1", delta: "…" });
    machineRuntime.emit("approval.upsert", makeApproval("apr_2", { threadId: "thr_2" }));
    machineRuntime.emit("task.record", machineRuntime.records.get("Daily/2026-09-23.md")![0]!);
    machineRuntime.emit("routines.changed", []);
    machineRuntime.emit("status", { ...machineRuntime.status(), running: 3 });

    expect(
      (await client.next("thread.upsert", (e) => e.thread.id === "thr_2", WAIT_MS)).thread,
    ).toMatchObject({ title: thread.title });
    expect((await client.next("thread.message", undefined, WAIT_MS)).message).toEqual(message);
    expect((await client.next("thread.delta", undefined, WAIT_MS)).delta).toBe("…");
    const approval = await client.next(
      "approval.upsert",
      (e) => e.approval.id === "apr_2",
      WAIT_MS,
    );
    expect(approval.approval.threadId).toBe("thr_2");
    expect((await client.next("task.record", undefined, WAIT_MS)).record.taskId).toBe("task_thr_1");
    expect((await client.next("routines.changed", undefined, WAIT_MS)).routines).toEqual([]);
    const status = await client.next("agent.status", (e) => e.status.running === 3, WAIT_MS);
    expect(status.status).toMatchObject({
      execution: { provider: "fake" },
      placement: { placement: "always_on_machine", relay: "connected" },
    });
    await client.barrier();
    expect(
      client.events.some((e) => e.type === "thread.upsert" && e.thread.id === "thr_local"),
    ).toBe(false);
  });

  it("shows what the machine's orchestrator is doing, and this device's once it stops relaying", async () => {
    const trigger: OrchestratorTrigger = {
      kind: "note",
      notePath: "Daily/2026-09-23.md",
      lines: [{ line: 3, text: "find a plumber for Saturday" }],
      summary: "“find a plumber for Saturday”",
    };
    machineRuntime.orchestrator = { phase: "thinking", turnId: "msg_1", trigger, startedAt: 7 };
    const { client, relay, local, placement } = await liveDevice();
    await connected(relay);
    // A client joining mid-turn gets the machine's turn from the resync.
    const joined = await client.next(
      "orchestrator.activity",
      (e) => e.activity.turnId === "msg_1",
      WAIT_MS,
    );
    expect(joined.activity).toEqual(machineRuntime.orchestrator);
    expect(relay.status().orchestrator).toEqual(machineRuntime.orchestrator);

    local.emit("orchestrator.activity", { phase: "noticed", trigger });
    const done: OrchestratorActivity = {
      phase: "idle",
      turnId: "msg_1",
      trigger,
      startedAt: 7,
      outcome: { kind: "delegated", count: 1, threadId: "thr_1", text: "Find a plumber" },
    };
    machineRuntime.emit("orchestrator.activity", done);
    expect(
      (await client.next("orchestrator.activity", (e) => e.activity.phase === "idle", WAIT_MS))
        .activity,
    ).toEqual(done);
    await client.barrier();
    expect(
      client.events.some(
        (e) => e.type === "orchestrator.activity" && e.activity.phase === "noticed",
      ),
    ).toBe(false);

    placement.set("this_device");
    expect(relay.state).toBe("off");
    const own = await client.next(
      "orchestrator.activity",
      (e) => e.activity.turnId === undefined,
      WAIT_MS,
    );
    expect(own.activity).toEqual({ phase: "idle" });
    local.emit("orchestrator.activity", { phase: "noticed", trigger });
    await client.next("orchestrator.activity", (e) => e.activity.phase === "noticed", WAIT_MS);
  });

  it("sends surface watches, reads and typing to the machine, and its frames back", async () => {
    const { client, relay } = await liveDevice();
    await connected(relay);
    client.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:browser") === 1, WAIT_MS);
    machineRuntime.emit("surface.frame", {
      threadId: "thr_1",
      surface: "browser",
      mimeType: "image/jpeg",
      data: "AAAA",
      width: 10,
      height: 10,
      ts: 5,
    });
    expect((await client.next("surface.frame", undefined, WAIT_MS)).data).toBe("AAAA");
    client.send({ type: "thread.read", threadId: "thr_1" });
    client.send({ type: "editor.activity", notePath: "Daily/2026-09-23.md", line: 2 });
    client.send({ type: "surface.unsubscribe", threadId: "thr_1", surface: "browser" });
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:browser") === 0, WAIT_MS);
    expect(machineRuntime.callsTo("markThreadRead")).toEqual([["thr_1"]]);
    expect(machineRuntime.callsTo("noteEditorActivity")).toEqual([["Daily/2026-09-23.md", 2]]);
  });

  it("goes read-only while the machine is away, reconnects and resyncs clients", async () => {
    const proxy = await proxiedMachine();
    const { client, relay, states } = await liveDevice({ credential: proxy.credential });
    await connected(relay);
    client.send({ type: "surface.subscribe", threadId: "thr_1", surface: "computer" });
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:computer") === 1, WAIT_MS);

    await proxy.cut();
    await waitFor(() => relay.state === "unreachable", WAIT_MS);
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:computer") === 0, WAIT_MS);
    const away = await client.next(
      "agent.status",
      (e) => e.status.placement?.relay === "unreachable",
      WAIT_MS,
    );
    expect(away.status.problem).toBe(RELAY_PROBLEMS.unreachable);
    await expect(relay.cancelThread("thr_1")).rejects.toThrow(RELAY_PROBLEMS.unreachable);

    // What changed on the machine meanwhile reaches the client after the reconnect.
    machineRuntime.threads.set("thr_3", makeThread("thr_3", { title: "Book a table" }));
    machineRuntime.approvals.push(makeApproval("apr_3", { threadId: "thr_3" }));
    await proxy.heal();
    await connected(relay);
    await client.next("thread.upsert", (e) => e.thread.id === "thr_3", WAIT_MS);
    await client.next("approval.upsert", (e) => e.approval.id === "apr_3", WAIT_MS);
    await client.next("agent.status", (e) => e.status.pendingApprovals === 2, WAIT_MS);
    // The surface watch came back with the connection.
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:computer") === 1, WAIT_MS);
    expect(states()).toEqual(["connected", "unreachable", "connected"]);
  });

  it("drops a connection that stops answering and makes a new one", async () => {
    const proxy = await proxiedMachine();
    const { relay, states } = await liveDevice({ credential: proxy.credential });
    await connected(relay);
    proxy.stall();
    await waitFor(() => states().includes("unreachable"), WAIT_MS);
    await connected(relay);
  });
});

describe("switching where the agent runs", { timeout: 30_000 * TIME_SCALE }, () => {
  it("follows the placement live, surface watches included", async () => {
    const { client, relay, local, placement } = await liveDevice({ placement: "this_device" });
    client.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    await waitFor(() => local.activeSurfaces.get("thr_1:browser") === 1, WAIT_MS);
    expect(relay.listThreads().map((t) => t.id)).toEqual(["thr_local"]);

    placement.set("always_on_machine");
    await connected(relay);
    await client.next("agent.status", (e) => e.status.placement?.relay === "connected", WAIT_MS);
    await client.next("thread.upsert", (e) => e.thread.id === "thr_1", WAIT_MS);
    expect(local.activeSurfaces.get("thr_1:browser")).toBe(0);
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:browser") === 1, WAIT_MS);
    await expect(relay.postUserMessage("thr_local", "Hi")).rejects.toThrow(
      RELAY_PROBLEMS.unreachable,
    );

    placement.set("this_device");
    expect(relay.state).toBe("off");
    await client.next("agent.status", (e) => e.status.placement === undefined, WAIT_MS);
    await client.next("routines.changed", undefined, WAIT_MS);
    await waitFor(() => machineRuntime.activeSurfaces.get("thr_1:browser") === 0, WAIT_MS);
    expect(local.activeSurfaces.get("thr_1:browser")).toBe(1);
    await waitFor(() => machine.hub.clientCount === 0, WAIT_MS);
    await relay.postUserMessage("thr_local", "Hi");
    expect(local.callsTo("postUserMessage")).toEqual([["thr_local", "Hi"]]);
  });

  it("follows the credential live: pairing, a new token, forgetting the machine", async () => {
    const { api, relay, machineSource } = await device({ credential: null });
    expect(relay.state).toBe("not_paired");

    machineSource.set({ ...machineCredential(), token: "old" });
    await waitFor(
      () => relay.state === "not_paired" && relay.status().problem === RELAY_PROBLEMS.rejected,
      WAIT_MS,
    );
    machineSource.set(machineCredential());
    await connected(relay);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_1"]);
    await waitFor(() => machine.hub.clientCount === 1, WAIT_MS);

    machineSource.set(null);
    expect(relay.state).toBe("not_paired");
    expect(relay.status().problem).toBe(RELAY_PROBLEMS.notPaired);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    await waitFor(() => machine.hub.clientCount === 0, WAIT_MS);
  });
});

describe("calls to the machine", () => {
  it("refuse answers that are too large, aren't the daemon's, redirect or come late", async () => {
    const elsewhere = await startRecorder();
    const recorder = await startRecorder((request, res) => {
      if (request.url.startsWith("/api/threads/big")) {
        res.writeHead(200, { "content-type": "application/json" }).end("x".repeat(4096));
      } else if (request.url.startsWith("/api/threads/moved")) {
        res.writeHead(302, { location: `${elsewhere.url}/api/threads` }).end();
      } else if (request.url.startsWith("/api/threads/slow")) {
        // Never answers.
      } else {
        res.writeHead(502, { "content-type": "text/html" }).end("<h1>Bad gateway</h1>");
      }
    });
    const credential = { url: recorder.url, token: "t" };
    const get = (target: string, options = {}) =>
      callMachine(credential, { method: "GET", target }, options);
    await expect(get("/api/threads/big", { maxBytes: 1024 })).rejects.toThrow(
      MachineUnavailableError,
    );
    await expect(get("/api/threads")).rejects.toMatchObject({ reason: "unreachable" });
    await expect(get("/api/threads/moved")).rejects.toMatchObject({ reason: "unreachable" });
    await expect(get("/api/threads/slow", { timeoutMs: 100 })).rejects.toThrow("timed out");
    expect(elsewhere.requests).toEqual([]);
    await expect(get("https://elsewhere.example/api/threads")).rejects.toThrow(
      /outside the always-on machine/,
    );
    await expect(get("/ws")).rejects.toThrow(/outside the always-on machine/);
  });
});
