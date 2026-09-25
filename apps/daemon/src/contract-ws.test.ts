/**
 * WebSocket hub ⇄ contract conformance: everything the hub sends parses (strictly) as a
 * `ServerEvent` and carries the runtime's payload unchanged; valid client events are accepted and
 * invalid ones answered with a conformant `error` event.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientEventSchema, exact, ServerEventSchema } from "@ddl/contract";
import { arb, invalidFor } from "@ddl/contract/testing";
import {
  API_ROUTES,
  API_VERSION,
  type ObsidianImportJob,
  type ServerEvent,
  silentLogger,
  WS_CLOSE_CODES,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { createSecurityPolicy } from "./security";
import { createSettingsStore } from "./settings-store";
import { FakeAgentRuntime, testToken } from "./test-helpers";
import { WriteTracker } from "./write-tracker";
import { attachWebSocketHub, type WebSocketHub } from "./ws";

const numRuns = Math.max(10, Math.round((fc.readConfigureGlobal().numRuns ?? 100) / 4));

class Client {
  readonly ws: WebSocket;
  readonly messages: unknown[] = [];
  closeCode: number | undefined;
  private readonly waiters = new Set<() => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)));
      for (const wake of [...this.waiters]) wake();
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      for (const wake of [...this.waiters]) wake();
    });
  }

  /** Resolves with the first message after `from` matching `match`. */
  async next(
    match: (event: ServerEvent) => boolean,
    from = 0,
    timeoutMs = 1_000,
  ): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(from).find((m) => match(m as ServerEvent));
      if (found) return found as ServerEvent;
      if (Date.now() > deadline) throw new Error("timed out waiting for a server event");
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        setTimeout(wake, 20);
      });
    }
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Sends `messages`, then a non-JSON sentinel. The hub handles messages in order, so the errors
   * before the sentinel's (the only "not JSON" one) are exactly the ones `messages` caused.
   */
  async errorsFor(messages: unknown[]): Promise<ServerEvent[]> {
    const from = this.messages.length;
    for (const message of messages) this.send(message);
    this.ws.send("}{");
    const sentinel = await this.next(isJsonError, from);
    const errors = this.messages
      .slice(from, this.messages.indexOf(sentinel))
      .filter((m) => (m as ServerEvent).type === "error");
    return errors as ServerEvent[];
  }
}

function isJsonError(event: ServerEvent): boolean {
  return event.type === "error" && (event.code === "invalid_json" || /json/i.test(event.message));
}

let server: Server;
let hub: WebSocketHub;
let runtime: FakeAgentRuntime;
const importListeners = new Set<(job: ObsidianImportJob) => void>();
const imports = {
  onProgress(listener: (job: ObsidianImportJob) => void) {
    importListeners.add(listener);
    return () => importListeners.delete(listener);
  },
};
let url: string;
const sockets: WebSocket[] = [];

async function connect(): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const client = new Client(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await client.next((event) => event.type === "hello");
  return client;
}

beforeAll(async () => {
  const storage = new MemoryStorageProvider();
  runtime = new FakeAgentRuntime();
  const settings = await createSettingsStore({ storage });
  const writes = new WriteTracker();
  const token = testToken();
  let handler: Parameters<typeof getRequestListener>[0] = () => new Response(null, { status: 503 });
  server = createServer(getRequestListener((request, env) => handler(request, env)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  handler = createApp({
    storage,
    runtime,
    settings,
    config: { port, allowedOrigins: [] },
    token,
    logger: silentLogger,
    writes,
  }).fetch;
  hub = attachWebSocketHub({
    server,
    policy: createSecurityPolicy({ port, token }),
    storage,
    runtime,
    settings,
    writes,
    imports,
    logger: silentLogger,
    coalesceMs: 1,
  });
  url = `ws://127.0.0.1:${port}${API_ROUTES.ws}?token=${token}`;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await hub.close();
  await new Promise((resolve) => server.close(resolve));
});

function expectServerEvent(message: unknown): void {
  const parsed = exact(ServerEventSchema).safeParse(message);
  expect(parsed.error?.issues ?? [], String(JSON.stringify(message)).slice(0, 500)).toEqual([]);
}

describe("server events", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });

  it("starts with a conformant hello carrying API_VERSION", () => {
    expectServerEvent(client.messages[0]);
    expect(client.messages[0]).toMatchObject({ type: "hello", apiVersion: API_VERSION });
  });

  test.prop(
    [arb.taskAgentRecord(), arb.threadSummary(), arb.approvalRequest(), arb.agentStatusResponse()],
    {
      numRuns,
    },
  )(
    "record, thread, approval and status events carry the payload unchanged",
    async (record, thread, approval, status) => {
      const from = client.messages.length;
      runtime.emit("task.record", record);
      runtime.emit("thread.upsert", thread);
      runtime.emit("approval.upsert", approval);
      runtime.emit("status", status);
      const wire = JSON.parse(JSON.stringify({ record, thread, approval, status }));
      expect(await client.next((e) => e.type === "task.record", from)).toStrictEqual({
        type: "task.record",
        record: wire.record,
      });
      expect(await client.next((e) => e.type === "thread.upsert", from)).toStrictEqual({
        type: "thread.upsert",
        thread: wire.thread,
      });
      expect(await client.next((e) => e.type === "approval.upsert", from)).toStrictEqual({
        type: "approval.upsert",
        approval: wire.approval,
      });
      expect(await client.next((e) => e.type === "agent.status", from)).toStrictEqual({
        type: "agent.status",
        status: wire.status,
      });
      for (const message of client.messages.slice(from)) expectServerEvent(message);
    },
  );

  test.prop([arb.taskRecordsEvent(), arb.threadMessageEvent(), arb.threadDeltaEvent()], {
    numRuns,
  })(
    "records snapshots, messages and deltas carry the payload unchanged",
    async ({ type: _a, ...records }, { type: _b, ...message }, { type: _c, ...delta }) => {
      const from = client.messages.length;
      runtime.emit("task.records", records);
      runtime.emit("thread.message", message);
      runtime.emit("thread.delta", delta);
      const types = ["task.records", "thread.message", "thread.delta"] as const;
      const payloads = [records, message, delta];
      for (const [i, type] of types.entries()) {
        const event = await client.next((e) => e.type === type, from);
        expect(event).toStrictEqual(JSON.parse(JSON.stringify({ type, ...payloads[i] })));
        expectServerEvent(event);
      }
    },
  );

  test.prop([arb.routinesChangedEvent(), arb.routineNotificationEvent()], { numRuns })(
    "routine lists and notifications carry the payload unchanged",
    async ({ routines }, { notification }) => {
      const from = client.messages.length;
      runtime.emit("routines.changed", routines);
      runtime.emit("routine.notification", notification);
      const changed = await client.next((e) => e.type === "routines.changed", from);
      expect(changed).toStrictEqual(
        JSON.parse(JSON.stringify({ type: "routines.changed", routines })),
      );
      const notified = await client.next((e) => e.type === "routine.notification", from);
      expect(notified).toStrictEqual(
        JSON.parse(JSON.stringify({ type: "routine.notification", notification })),
      );
      expectServerEvent(changed);
      expectServerEvent(notified);
    },
  );

  test.prop([arb.obsidianImportJob()], { numRuns })(
    "import progress reaches clients as conformant import.progress events",
    async (job) => {
      const from = client.messages.length;
      for (const listener of importListeners) listener(job);
      const event = await client.next((e) => e.type === "import.progress", from);
      expect(event).toStrictEqual(JSON.parse(JSON.stringify({ type: "import.progress", job })));
      expectServerEvent(event);
    },
  );

  test.prop([arb.orchestratorActivity()], { numRuns })(
    "orchestrator activity carries the payload unchanged",
    async (activity) => {
      const from = client.messages.length;
      runtime.emit("orchestrator.activity", activity);
      const event = await client.next((e) => e.type === "orchestrator.activity", from);
      expect(event).toStrictEqual(
        JSON.parse(JSON.stringify({ type: "orchestrator.activity", activity })),
      );
      expectServerEvent(event);
    },
  );

  test.prop([arb.surfaceFrame()], { numRuns })(
    "frames reach subscribers as conformant surface.frame events",
    async (frame) => {
      const subscribe = {
        type: "surface.subscribe",
        threadId: frame.threadId,
        surface: frame.surface,
      };
      expect(await client.errorsFor([subscribe])).toEqual([]);
      const from = client.messages.length;
      runtime.emit("surface.frame", frame);
      const event = await client.next((e) => e.type === "surface.frame" && e.ts === frame.ts, from);
      expect(event).toStrictEqual(JSON.parse(JSON.stringify({ type: "surface.frame", ...frame })));
      expectServerEvent(event);
      client.send({
        type: "surface.unsubscribe",
        threadId: frame.threadId,
        surface: frame.surface,
      });
    },
  );
});

describe("client events", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });

  test.prop([fc.array(arb.clientEvent(), { minLength: 1, maxLength: 5 })], { numRuns })(
    "valid client events are accepted without an error",
    async (events) => {
      expect(await client.errorsFor(events)).toEqual([]);
      for (const event of events) {
        if (event.type === "surface.subscribe")
          client.send({ ...event, type: "surface.unsubscribe" });
      }
    },
  );

  /** Mutations the hub's own schema also rejects (it still tolerates unknown keys: see the drift tests). */
  const invalid = invalidFor(ClientEventSchema, arb.clientEvent()).filter(
    (value) =>
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !ClientEventSchema.safeParse(stripUnknownKeys(value as Record<string, unknown>)).success,
  );

  test.prop([invalid], { numRuns })(
    "invalid client events get a conformant error event",
    async (event) => {
      const [error, ...more] = await client.errorsFor([event]);
      expect(more).toEqual([]);
      expectServerEvent(error);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    },
  );

  it.fails("DRIFT (ws.ts): client events with unknown keys are rejected, as the contract says", async () => {
    const errors = await client.errorsFor([
      { type: "thread.read", threadId: "thr_1", sneaky: true },
    ]);
    expect(errors).toHaveLength(1);
  });

  it.fails("DRIFT (ws.ts): an incompatible hello.apiVersion gets an error and close 4426", async () => {
    const own = await connect();
    const from = own.messages.length;
    own.send({ type: "hello", clientId: "web_1", apiVersion: API_VERSION + 1 });
    own.ws.send("}{");
    const error = await own.next((e) => e.type === "error", from);
    expect(error).toMatchObject({ code: "incompatible_api_version" });
    await own.next(() => own.closeCode !== undefined, from).catch(() => undefined);
    expect(own.closeCode).toBe(WS_CLOSE_CODES.incompatibleApiVersion);
  });
});

/** What the hub validates today: declared keys, except the handshake fields it doesn't read yet. */
function stripUnknownKeys(value: Record<string, unknown>): Record<string, unknown> {
  const option = ClientEventSchema.options.find((o) => o.shape.type.value === value.type);
  if (!option) return value;
  const ignored = value.type === "hello" ? ["apiVersion", "clientVersion"] : [];
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => Object.hasOwn(option.shape, key) && !ignored.includes(key),
    ),
  );
}
