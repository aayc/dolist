/**
 * The relay's HTTP side against a fake always-on machine (the daemon's app over a FakeAgentRuntime
 * on a loopback port) and a raw recording server that shows exactly what leaves this device.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentPlacement, AgentStatusResponse, ThreadListResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractClient } from "../contract-test-helpers";
import { type MemoryLiveApp, RecordingLogger, startLiveApp } from "../security/harness";
import {
  createTestApp,
  FakeAgentRuntime,
  makeApproval,
  makeThread,
  testToken,
} from "../test-helpers";
import { callMachine, MachineUnavailableError } from "./http";
import { AgentRelay, RELAY_PROBLEMS } from "./relay";
import { type MachineCredential, SettableMachineCredential, SettablePlacement } from "./sources";

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
  close(): Promise<void>;
}

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A plain HTTP server that records every request and answers with `respond`. */
async function startRecorder(
  respond: (request: Recorded, res: ServerResponse) => void = (_request, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end('{"threads":[]}');
  },
): Promise<Recorder> {
  const requests: Recorded[] = [];
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const recorder = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(recorder);
  return recorder;
}

async function closedPortUrl(): Promise<string> {
  const recorder = await startRecorder();
  await recorder.close();
  return recorder.url;
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
  machine = await startLiveApp({ runtime: machineRuntime, logger: machineLog });
  servers.push(machine);
});

const machineCredential = (): MachineCredential => ({
  url: `http://127.0.0.1:${machine.port}`,
  token: machine.token,
});

/** This device: its own runtime (with a thread the machine doesn't have) behind the relay. */
async function device(
  options: {
    credential?: MachineCredential | null;
    placement?: AgentPlacement;
    timeoutMs?: number;
  } = {},
) {
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
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const app = await createTestApp({ runtime: relay, relay, logger });
  return { app, api: contractClient(app), local, relay, placement, logger };
}

const threadIds = (body: unknown) => (body as ThreadListResponse).threads.map((t) => t.id);
const machinePaths = () =>
  machineLog.lines.filter((line) => line.startsWith("debug api ")).map((line) => line);

describe("the agent relay over HTTP", () => {
  it("forwards the agent's reads to the machine and keeps notes and settings local", async () => {
    const { app, api } = await device();

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

    expect(
      (
        await api.call("note", "PUT", {
          params: { path: "Inbox.md" },
          json: { content: "- [ ] x" },
        })
      ).status,
    ).toBe(201);
    expect((await api.call("note", "GET", { params: { path: "Inbox.md" } })).status).toBe(200);
    expect(await machine.storage.read("Inbox.md")).toBeNull();
    expect((await api.call("settings", "GET")).status).toBe(200);
    expect((await api.call("syncStatus", "GET")).status).toBe(200);
    expect(machinePaths().some((line) => /\/api\/(notes|settings|sync)/.test(line))).toBe(false);
  });

  it("forwards agent actions and routine changes, and never acts on this device", async () => {
    const { api, local } = await device();

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
    expect(
      (await api.call("approval", "POST", { params: { id: "apr_1" }, json: { decision: "deny" } }))
        .status,
    ).toBe(409);

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

    for (const method of ["postUserMessage", "cancelThread", "retryThread", "decideApproval"]) {
      expect(local.callsTo(method)).toEqual([]);
    }
    expect(local.callsTo("runRoutine")).toEqual([]);
  });

  it("reports the machine's agent with this device's placement", async () => {
    const { api, relay } = await device();
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
    const { app } = await device();
    const before = machinePaths().length;
    expect((await app.request("/api/threads/thr_1", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/threads/thr_1/extra")).status).toBe(404);
    expect((await app.request("/api/threads/thr%2F1")).status).toBe(400);
    expect((await app.request("/api/approvals/apr_1", { method: "PUT", json: {} })).status).toBe(
      404,
    );
    expect((await app.request("/api/routines/x/delete", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/connectors")).status).toBe(200);
    expect(machinePaths()).toHaveLength(before);
  });

  it("sends the machine only its token, the allowlisted target and a validated body", async () => {
    const recorder = await startRecorder((request, res) => {
      const body = request.method === "POST" ? '{"ok":true}' : '{"threads":[]}';
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    const token = testToken();
    const { app, logger } = await device({ credential: { url: recorder.url, token } });
    await app.request("/api/threads?notePath=Daily%2Fa.md&token=leak&notePath=second&x=1", {
      origin: "http://127.0.0.1:7331",
      clientId: "client_1",
      headers: { cookie: "ddl_device=abc", "x-forwarded-for": "10.0.0.1", "x-extra": "1" },
    });
    await app.request("/api/threads/thr_1/messages", {
      method: "POST",
      json: { text: "Prefer mornings" },
    });
    const invalid = await app.request("/api/threads/thr_1/messages", { method: "POST", json: {} });
    expect(invalid.status).toBe(400);

    expect(recorder.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /api/threads?notePath=Daily%2Fa.md",
      "POST /api/threads/thr_1/messages",
    ]);
    const [list, post] = recorder.requests;
    expect(list!.headers.authorization).toBe(`Bearer ${token}`);
    expect(list!.headers.host).toBe(new URL(recorder.url).host);
    for (const header of ["cookie", "origin", "x-ddl-client", "x-forwarded-for", "x-extra"]) {
      expect(list!.headers[header]).toBeUndefined();
    }
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post!.body)).toEqual({ text: "Prefer mornings" });
    const lines = logger.lines.join("\n");
    expect(lines).not.toContain(token);
    expect(lines).not.toContain("Prefer mornings");
  });

  it("answers from this device when the machine can't be reached", async () => {
    const { api } = await device({ credential: { url: await closedPortUrl(), token: "t" } });
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    expect(
      (await api.call("threadMessages", "POST", { params: { id: "thr_1" }, json: { text: "Hi" } }))
        .body,
    ).toEqual({ error: "agent_unavailable", message: RELAY_PROBLEMS.unreachable });
    const decide = await api.call("approval", "POST", {
      params: { id: "apr_1" },
      json: { decision: "approve" },
    });
    expect(decide.status).toBe(503);
    const created = await api.call("routines", "POST", { json: BRIEFING });
    expect(created.status).toBe(201);
    const id = (created.body as { routine: { id: string } }).routine.id;
    expect((await api.call("routineRun", "POST", { params: { id } })).status).toBe(503);
  });

  it("says the machine no longer accepts this device when it refuses the credential", async () => {
    const { api } = await device({ credential: { ...machineCredential(), token: "revoked" } });
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    const cancel = await api.call("threadCancel", "POST", { params: { id: "thr_1" } });
    expect(cancel.body).toEqual({ error: "agent_unavailable", message: RELAY_PROBLEMS.rejected });
    expect(machineRuntime.callsTo("cancelThread")).toEqual([]);
  });

  it("gives up on a machine that doesn't answer in time or redirects", async () => {
    const elsewhere = await startRecorder();
    const hanging = await startRecorder((request, res) => {
      if (request.method === "POST") return;
      res.writeHead(302, { location: `${elsewhere.url}${request.url}` }).end();
    });
    const { api } = await device({
      credential: { url: hanging.url, token: "t" },
      timeoutMs: 200,
    });
    const started = performance.now();
    const cancel = await api.call("threadCancel", "POST", { params: { id: "thr_1" } });
    expect(cancel.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(threadIds((await api.call("threads", "GET")).body)).toEqual(["thr_local"]);
    expect(elsewhere.requests).toEqual([]);
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

describe("calls to the machine", () => {
  it("refuse answers that are too large or aren't the daemon's", async () => {
    const recorder = await startRecorder((request, res) => {
      if (request.url.startsWith("/api/threads/big")) {
        res.writeHead(200, { "content-type": "application/json" }).end("x".repeat(4096));
      } else {
        res.writeHead(502, { "content-type": "text/html" }).end("<h1>Bad gateway</h1>");
      }
    });
    const credential = { url: recorder.url, token: "t" };
    await expect(
      callMachine(credential, { method: "GET", target: "/api/threads/big" }, { maxBytes: 1024 }),
    ).rejects.toThrow(MachineUnavailableError);
    await expect(
      callMachine(credential, { method: "GET", target: "/api/threads" }),
    ).rejects.toMatchObject({ reason: "unreachable" });
    await expect(
      callMachine(credential, { method: "GET", target: "https://elsewhere.example/api/threads" }),
    ).rejects.toThrow(/outside the always-on machine/);
    await expect(callMachine(credential, { method: "GET", target: "/ws" })).rejects.toThrow(
      /outside the always-on machine/,
    );
  });
});
