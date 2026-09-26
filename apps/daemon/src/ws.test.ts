import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  API_ROUTES,
  API_VERSION,
  CLIENT_ID_HEADER,
  type ClientEvent,
  type ServerEvent,
  type ServerEventOf,
  type ServerEventType,
  type SurfaceFrame,
  silentLogger,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { type ClientOptions, WebSocket } from "ws";
import { createApp } from "./app";
import { createSecurityPolicy } from "./security";
import { waitFor } from "./security/harness";
import { createSettingsStore } from "./settings-store";
import { FakeAgentRuntime, makeApproval, testToken } from "./test-helpers";
import { DAEMON_VERSION } from "./version";
import { WriteTracker } from "./write-tracker";
import { attachWebSocketHub, type WebSocketHub, type WebSocketHubOptions } from "./ws";

interface Harness {
  port: number;
  token: string;
  storage: MemoryStorageProvider;
  runtime: FakeAgentRuntime;
  hub: WebSocketHub;
  server: Server;
  url(query?: string): string;
  api(path: string, init?: RequestInit): Promise<Response>;
}

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const h of harnesses.splice(0)) {
    await h.hub.close();
    await new Promise((resolve) => h.server.close(resolve));
  }
});

async function startHarness(options: Partial<WebSocketHubOptions> = {}): Promise<Harness> {
  const storage = new MemoryStorageProvider();
  const runtime = new FakeAgentRuntime();
  const settings = await createSettingsStore({ storage });
  const writes = new WriteTracker();
  const token = testToken();
  let handler: Parameters<typeof getRequestListener>[0] = () => new Response(null, { status: 503 });
  const server = createServer(getRequestListener((request, env) => handler(request, env)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  handler = createApp({
    storage,
    runtime,
    settings,
    config: { port, allowedOrigins: [] },
    token,
    logger: silentLogger,
    writes,
  }).fetch;
  const hub = attachWebSocketHub({
    server,
    policy: createSecurityPolicy({ port, token }),
    storage,
    runtime,
    settings,
    writes,
    logger: silentLogger,
    coalesceMs: 5,
    ...options,
  });
  const harness: Harness = {
    port,
    token,
    storage,
    runtime,
    hub,
    server,
    url: (query = `token=${token}`) => `ws://127.0.0.1:${port}${API_ROUTES.ws}?${query}`,
    api: (path, init = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      }),
  };
  harnesses.push(harness);
  return harness;
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerEvent);
      for (const wake of [...this.waiters]) wake();
    });
  }

  static connect(url: string, options: ClientOptions = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      sockets.push(ws);
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(event: ClientEvent | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(event));
  }

  /** Resolves with (and consumes) the first message of `type` matching `predicate`. */
  next<T extends ServerEventType>(
    type: T,
    predicate: (event: ServerEventOf<T>) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<ServerEventOf<T>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const index = this.messages.findIndex(
          (m) => m.type === type && predicate(m as ServerEventOf<T>),
        );
        if (index === -1) return false;
        const [match] = this.messages.splice(index, 1);
        resolve(match as ServerEventOf<T>);
        return true;
      };
      if (check()) return;
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const wake = () => {
        if (!check()) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      this.waiters.add(wake);
    });
  }

  has(type: ServerEventType): boolean {
    return this.messages.some((m) => m.type === type);
  }

  /** Resolves once the server has processed everything this client sent before. */
  async barrier(): Promise<void> {
    this.send({ type: "barrier" });
    await this.next("error");
  }
}

function rejectionStatus(url: string, options: ClientOptions = {}): Promise<string> {
  return TestClient.connect(url, options).then(
    () => "connected",
    (error: Error) => error.message,
  );
}

const frame = (threadId: string, surface: SurfaceFrame["surface"] = "browser"): SurfaceFrame => ({
  threadId,
  surface,
  mimeType: "image/jpeg",
  data: "AAAA",
  width: 1,
  height: 1,
  ts: 1,
});

describe("WebSocket authentication", () => {
  it("greets clients authenticated with ?token=", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url(), { origin: `http://127.0.0.1:${h.port}` });
    expect(await client.next("hello")).toEqual({
      type: "hello",
      serverVersion: DAEMON_VERSION,
      apiVersion: API_VERSION,
    });
  });

  it("accepts the dev proxy's Authorization header and Vite's origin", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url(""), {
      headers: { authorization: `Bearer ${h.token}`, host: "localhost:5173" },
      origin: "http://localhost:5173",
    });
    expect((await client.next("hello")).apiVersion).toBe(API_VERSION);
  });

  it("rejects missing or wrong tokens, foreign origins and hosts, and other paths", async () => {
    const h = await startHarness();
    expect(await rejectionStatus(h.url(""))).toBe("HTTP 401");
    expect(await rejectionStatus(h.url(`token=${testToken()}`))).toBe("HTTP 401");
    expect(await rejectionStatus(h.url(), { origin: "http://evil.example" })).toBe("HTTP 403");
    expect(await rejectionStatus(h.url(), { origin: "null" })).toBe("HTTP 403");
    expect(await rejectionStatus(h.url(), { headers: { host: "evil.example:7331" } })).toBe(
      "HTTP 403",
    );
    expect(await rejectionStatus(`ws://127.0.0.1:${h.port}/api/ws?token=${h.token}`)).toBe(
      "HTTP 404",
    );
    expect(h.hub.clientCount).toBe(0);
  });
});

describe("vault.changed", () => {
  it("tags API writes with the writer's clientId and external edits as external", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url());
    client.send({ type: "hello", clientId: "tab_a" });
    await client.next("hello");

    const res = await h.api(API_ROUTES.note("Daily/2026-09-23.md"), {
      method: "PUT",
      headers: { [CLIENT_ID_HEADER]: "tab_a", "content-type": "application/json" },
      body: JSON.stringify({ content: "- [ ] Call the dentist", baseVersion: null }),
    });
    const { version } = (await res.json()) as { version: string };
    expect(await client.next("vault.changed")).toEqual({
      type: "vault.changed",
      origin: "client",
      clientId: "tab_a",
      changes: [{ path: "Daily/2026-09-23.md", kind: "created", version }],
    });

    await h.storage.write(".daily-do-list/threads/t.json", "{}");
    h.storage.simulateExternalChange("Edited in Obsidian.md", "hello");
    const external = await client.next("vault.changed");
    expect(external).toMatchObject({
      origin: "external",
      changes: [{ path: "Edited in Obsidian.md", kind: "created" }],
    });
    expect(external.clientId).toBeUndefined();
  });

  it("attributes in-process writes that bypass the API to the agent", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url());
    await h.storage.write("Report.md", "# Findings");
    expect(await client.next("vault.changed")).toMatchObject({
      origin: "agent",
      changes: [{ path: "Report.md", kind: "created" }],
    });
  });
});

describe("runtime events", () => {
  it("broadcasts task, thread, approval, status and settings events to every client", async () => {
    const h = await startHarness();
    const a = await TestClient.connect(h.url());
    const b = await TestClient.connect(h.url());
    await Promise.all([a.next("hello"), b.next("hello")]);

    const approval = makeApproval("apr_1");
    h.runtime.emit("approval.upsert", approval);
    h.runtime.emit("thread.message", {
      threadId: "thr_1",
      message: { id: "m1", kind: "status", status: "working", author: "system", createdAt: 1 },
    });
    h.runtime.emit("status", h.runtime.status());
    h.runtime.emit("task.records", { notePath: "a.md", records: [] });

    for (const client of [a, b]) {
      expect((await client.next("approval.upsert")).approval).toEqual(approval);
      expect((await client.next("thread.message")).threadId).toBe("thr_1");
      expect((await client.next("agent.status")).status.mode).toBe("mock");
      expect((await client.next("task.records")).notePath).toBe("a.md");
    }

    await h.api(API_ROUTES.settings, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    expect((await a.next("settings.changed")).settings.theme).toBe("dark");
  });

  it("drops token deltas under backpressure but never essential events", async () => {
    const h = await startHarness({ dropThresholdBytes: -1 });
    const client = await TestClient.connect(h.url());
    await client.next("hello");
    h.runtime.emit("thread.delta", { threadId: "thr_1", messageId: "m1", delta: "Hel" });
    h.runtime.emit("task.record", {
      taskId: "t1",
      notePath: "a.md",
      date: null,
      text: "x",
      line: 0,
      status: "working",
      threadId: null,
      updatedAt: 1,
      unread: 0,
    });
    await client.next("task.record");
    expect(client.has("thread.delta")).toBe(false);
  });
});

describe("live surfaces", () => {
  it("subscribes the runtime once per surface and routes frames only to subscribers", async () => {
    const h = await startHarness();
    const a = await TestClient.connect(h.url());
    const b = await TestClient.connect(h.url());
    await Promise.all([a.next("hello"), b.next("hello")]);

    a.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    a.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    await a.barrier();
    b.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    await b.barrier();
    b.send({ type: "surface.unsubscribe", threadId: "thr_1", surface: "browser" });
    await b.barrier();
    expect(h.runtime.callsTo("subscribeSurface")).toEqual([["thr_1", "browser"]]);
    expect(h.runtime.callsTo("releaseSurface")).toEqual([]);
    expect(h.runtime.activeSurfaces.get("thr_1:browser")).toBe(1);

    h.runtime.emit("surface.frame", frame("thr_1"));
    h.runtime.emit("surface.frame", frame("thr_2"));
    h.runtime.emit("status", h.runtime.status());
    expect(await a.next("surface.frame")).toMatchObject({ threadId: "thr_1", surface: "browser" });
    await Promise.all([a.next("agent.status"), b.next("agent.status")]);
    expect(a.has("surface.frame")).toBe(false);
    expect(b.has("surface.frame")).toBe(false);

    a.ws.close();
    await waitFor(() => h.runtime.activeSurfaces.get("thr_1:browser") === 0);
    expect(h.runtime.callsTo("releaseSurface")).toEqual([["thr_1", "browser"]]);
  });
});

describe("client signals", () => {
  it("forwards editor activity and read receipts, ignoring hidden paths", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url());
    await client.next("hello");
    client.send({ type: "editor.activity", notePath: ".daily-do-list/x.md", line: 1 });
    client.send({ type: "editor.activity", notePath: "Daily//2026-09-23.md", line: 4 });
    client.send({ type: "thread.read", threadId: "thr_1" });
    client.send({ type: "ping" });
    await waitFor(() => h.runtime.callsTo("markThreadRead").length === 1);
    expect(h.runtime.callsTo("noteEditorActivity")).toEqual([["Daily/2026-09-23.md", 4]]);
    expect(h.runtime.callsTo("markThreadRead")).toEqual([["thr_1"]]);
  });

  it("answers malformed messages with an error event", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url());
    await client.next("hello");
    client.ws.send("not json");
    expect((await client.next("error")).message).toBe("Messages must be JSON");
    client.send({ type: "editor.activity", notePath: "a.md", line: -1 });
    expect((await client.next("error")).message).toBe("Invalid message");
    client.send({ type: "hello", clientId: "has spaces" });
    expect((await client.next("error")).message).toBe("Invalid message");
  });
});

describe("connection lifecycle", () => {
  it("terminates clients that stop answering pings", async () => {
    const h = await startHarness({ heartbeatMs: 30 });
    const client = await TestClient.connect(h.url(), { autoPong: false });
    await client.next("hello");
    await new Promise<void>((resolve) => client.ws.once("close", () => resolve()));
    await waitFor(() => h.hub.clientCount === 0);
  });

  it("closes clients with 1001 on shutdown", async () => {
    const h = await startHarness();
    const client = await TestClient.connect(h.url());
    await client.next("hello");
    const closed = new Promise<number>((resolve) =>
      client.ws.once("close", (code) => resolve(code)),
    );
    await h.hub.close();
    expect(await closed).toBe(1001);
  });
});
