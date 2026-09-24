import type { Socket } from "node:net";
import type { SurfaceFrame, SurfaceKind, ThreadMessage } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  type MemoryLiveApp,
  RecordingLogger,
  startLiveApp,
  TestSocket,
  upgradeOutcome,
  waitFor,
} from "./harness";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SURFACES_PER_CLIENT = 16;

const frame = (threadId: string, surface: SurfaceKind, ts: number): SurfaceFrame => ({
  threadId,
  surface,
  mimeType: "image/jpeg",
  data: "AAAA",
  width: 1,
  height: 1,
  ts,
});

const textMessage = (id: string, text = "done"): ThreadMessage => ({
  id,
  kind: "text",
  role: "agent",
  author: "subagent:research",
  text,
  createdAt: 1,
});

/** The client's TCP socket, to simulate a peer that stops reading. */
const rawSocket = (ws: WebSocket): Socket => (ws as unknown as { _socket: Socket })._socket;

/** Waits on real time without setTimeout (which some tests fake). */
async function spinUntil(condition: () => boolean, maxMs = 1_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let app: MemoryLiveApp;
const sockets: TestSocket[] = [];

beforeAll(async () => {
  app = await startLiveApp();
});
afterAll(() => app.close());

async function connect(options?: Parameters<typeof TestSocket.open>[1]): Promise<TestSocket> {
  const socket = await TestSocket.open(app.wsUrl(), options);
  sockets.push(socket);
  await socket.next("hello");
  return socket;
}

// Also runs after every generated case of a property (@fast-check/vitest re-runs hooks per case).
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.ws.terminate();
  await waitFor(() => app.hub.clientCount === 0);
  await waitFor(() => [...app.runtime.activeSurfaces.values()].every((n) => n === 0));
});

describe("malformed client messages", () => {
  const corpus: Array<[string, string | Buffer]> = [
    ["not JSON", "not json"],
    ["empty", ""],
    ["truncated", '{"type":"ping"'],
    ["NUL", "\u0000"],
    ["number", "42"],
    ["null", "null"],
    ["array", '[{"type":"ping"}]'],
    ["unknown type", '{"type":"shell.exec","command":"rm -rf ~"}'],
    ["type of wrong kind", '{"type":1}'],
    ["missing fields", '{"type":"surface.subscribe"}'],
    ["unknown surface", '{"type":"surface.subscribe","threadId":"t","surface":"camera"}'],
    ["empty thread id", '{"type":"thread.read","threadId":""}'],
    ["long thread id", JSON.stringify({ type: "thread.read", threadId: "t".repeat(201) })],
    ["negative line", '{"type":"editor.activity","notePath":"a.md","line":-1}'],
    ["fractional line", '{"type":"editor.activity","notePath":"a.md","line":1.5}'],
    ["client id with spaces", '{"type":"hello","clientId":"tab 1"}'],
    ["client id too long", JSON.stringify({ type: "hello", clientId: "a".repeat(129) })],
    ["deeply nested", `${"[".repeat(20_000)}${"]".repeat(20_000)}`],
    ["prototype keys", '{"__proto__":{"type":"ping"}}'],
  ];

  it("answers each with exactly one error event and keeps the connection usable", async () => {
    const client = await connect();
    for (const [name, message] of corpus) {
      client.ws.send(message);
      await client.barrier();
      const errors = client.events.splice(0).filter((event) => event.type === "error");
      expect(errors, name).toEqual([
        expect.objectContaining({ type: "error", message: expect.any(String) }),
      ]);
    }
    client.ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
    expect((await client.next("error")).message).toMatch(/binary/i);
    client.send({ type: "ping" });
    await client.barrier();
    expect(client.ws.readyState).toBe(client.ws.OPEN);
    expect(app.runtime.calls.filter((c) => c.method.startsWith("subscribe"))).toEqual([]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  test.prop([fc.jsonValue()], { numRuns: 60 })(
    "never closes the connection or throws on arbitrary JSON",
    async (value) => {
      const client = sockets[0] ?? (await connect());
      client.send(JSON.stringify(value));
      client.send({ type: "ping" });
      await client.barrier();
      expect(client.ws.readyState).toBe(client.ws.OPEN);
    },
  );

  it("closes with 1009 when a message exceeds 64 KiB, and only that connection", async () => {
    const bystander = await connect();
    const client = await connect();
    const closed = client.closed();
    client.send({ type: "thread.read", threadId: "x".repeat(MAX_MESSAGE_BYTES) });
    expect((await closed).code).toBe(1009);
    await bystander.barrier();
    expect(bystander.ws.readyState).toBe(bystander.ws.OPEN);
  });

  it("accepts a message just under the limit", async () => {
    const client = await connect();
    const padding = MAX_MESSAGE_BYTES - JSON.stringify({ type: "ping", p: "" }).length;
    client.send({ type: "ping", p: "x".repeat(padding) });
    await client.barrier();
    expect(client.ws.readyState).toBe(client.ws.OPEN);
  });
});

describe("hello handshake", () => {
  it("delivers broadcasts without a hello, and accepts repeated hellos", async () => {
    const silent = await connect();
    const chatty = await connect();
    chatty.send({ type: "hello", clientId: "tab_a" });
    chatty.send({ type: "hello", clientId: "tab_b" });
    await chatty.barrier();
    app.runtime.emit("status", app.runtime.status());
    await Promise.all([silent.next("agent.status"), chatty.next("agent.status")]);
    expect(chatty.count("error")).toBe(0);
  });
});

describe("surface subscriptions", () => {
  it(`caps each client at ${MAX_SURFACES_PER_CLIENT} surfaces under a subscribe flood`, async () => {
    const client = await connect();
    const before = app.runtime.callsTo("subscribeSurface").length;
    for (let i = 0; i < 500; i++) {
      client.send({ type: "surface.subscribe", threadId: `flood_${i}`, surface: "browser" });
    }
    await client.barrier();
    expect(app.runtime.callsTo("subscribeSurface").length - before).toBe(MAX_SURFACES_PER_CLIENT);
    const errors = client.events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(500 - MAX_SURFACES_PER_CLIENT);
    client.ws.close();
    await waitFor(() => app.hub.clientCount === 0);
    const released = app.runtime
      .callsTo("releaseSurface")
      .filter(([t]) => String(t).startsWith("flood_"));
    expect(released).toHaveLength(MAX_SURFACES_PER_CLIENT);
  });

  it("subscribes the runtime once however often a surface is requested, and ignores unknown unsubscribes", async () => {
    const client = await connect();
    const before = app.runtime.callsTo("subscribeSurface").length;
    for (let i = 0; i < 300; i++) {
      client.send({ type: "surface.subscribe", threadId: "same", surface: "computer" });
      client.send({ type: "surface.unsubscribe", threadId: `never_${i}`, surface: "browser" });
    }
    await client.barrier();
    expect(app.runtime.callsTo("subscribeSurface").length - before).toBe(1);
    expect(client.count("error")).toBe(0);
    for (let i = 0; i < 3; i++) {
      client.send({ type: "surface.unsubscribe", threadId: "same", surface: "computer" });
    }
    await client.barrier();
    expect(app.runtime.activeSurfaces.get("same:computer")).toBe(0);
  });

  type Command =
    | { kind: "sub" | "unsub"; client: number; thread: string; surface: SurfaceKind }
    | { kind: "frame"; thread: string; surface: SurfaceKind }
    | { kind: "close"; client: number };

  const target = {
    thread: fc.constantFrom("t1", "t2", "t3"),
    surface: fc.constantFrom<SurfaceKind>("browser", "computer"),
  };
  const command: fc.Arbitrary<Command> = fc.oneof(
    fc.record({
      kind: fc.constantFrom("sub" as const, "unsub" as const),
      client: fc.nat(2),
      ...target,
    }),
    fc.record({ kind: fc.constant("frame" as const), ...target }),
    fc.record({ kind: fc.constant("close" as const), client: fc.nat(2) }),
  );

  test.prop([fc.array(command, { minLength: 1, maxLength: 25 })], { numRuns: 30 })(
    "deliver each frame exactly to the clients subscribed when it is emitted",
    async (commands) => {
      const clients = await Promise.all([0, 1, 2].map(() => connect()));
      const subscribed = clients.map(() => new Set<string>());
      const expected: number[][] = clients.map(() => []);
      const open = clients.map(() => true);
      let ts = 0;
      for (const cmd of commands) {
        if (cmd.kind === "frame") {
          ts++;
          const key = `${cmd.thread}:${cmd.surface}`;
          subscribed.forEach((keys, i) => {
            if (open[i] && keys.has(key)) expected[i]!.push(ts);
          });
          app.runtime.emit("surface.frame", frame(cmd.thread, cmd.surface, ts));
          continue;
        }
        const client = clients[cmd.client]!;
        if (!open[cmd.client]) continue;
        if (cmd.kind === "close") {
          open[cmd.client] = false;
          const count = app.hub.clientCount;
          client.ws.close();
          await waitFor(() => app.hub.clientCount === count - 1);
          continue;
        }
        client.send({
          type: `surface.${cmd.kind === "sub" ? "subscribe" : "unsubscribe"}`,
          threadId: cmd.thread,
          surface: cmd.surface,
        });
        await client.barrier();
        const key = `${cmd.thread}:${cmd.surface}`;
        if (cmd.kind === "sub") subscribed[cmd.client]!.add(key);
        else subscribed[cmd.client]!.delete(key);
      }
      for (const [i, client] of clients.entries()) {
        if (!open[i]) continue;
        await client.barrier();
        const got = client.events.filter((e) => e.type === "surface.frame").map((e) => e.ts);
        expect(got, `client ${i}`).toEqual(expected[i]);
      }
      for (const key of ["t1", "t2", "t3"].flatMap((t) => [`${t}:browser`, `${t}:computer`])) {
        const wanted = subscribed.some((keys, i) => open[i] && keys.has(key)) ? 1 : 0;
        expect(app.runtime.activeSurfaces.get(key) ?? 0, key).toBe(wanted);
      }
    },
  );
});

describe("client signals", () => {
  it("forwards editor activity only for visible, in-vault paths", async () => {
    const client = await connect();
    const before = app.runtime.callsTo("noteEditorActivity").length;
    for (const notePath of [
      ".daily-do-list/threads/x.json",
      ".obsidian/workspace.json",
      "../outside.md",
      "Notes/../../outside.md",
      "a\u0000b.md",
      "/",
      ".",
    ]) {
      client.send({ type: "editor.activity", notePath, line: 1 });
    }
    client.send({ type: "editor.activity", notePath: "Notes\\..\\Daily//today.md", line: 3 });
    await client.barrier();
    expect(app.runtime.callsTo("noteEditorActivity").slice(before)).toEqual([
      ["Daily/today.md", 3],
    ]);
  });
});

describe("backpressure", () => {
  let slowApp: MemoryLiveApp;
  const logger = new RecordingLogger();
  beforeAll(async () => {
    slowApp = await startLiveApp({
      logger,
      hub: { dropThresholdBytes: 256 * 1024, maxBufferedBytes: 64 * 1024 * 1024 },
    });
  });
  afterAll(() => slowApp.close());

  it("skips token deltas for a client that stops reading, but delivers every essential event", async () => {
    const slow = await TestSocket.open(slowApp.wsUrl());
    await slow.next("hello");
    rawSocket(slow.ws).pause();
    const delta = "x".repeat(64 * 1024);
    let deltas = 0;
    for (let i = 0; i < 400; i++) {
      slowApp.runtime.emit("thread.delta", { threadId: "thr_1", messageId: "m1", delta });
      deltas++;
      if (i % 20 === 19) {
        slowApp.runtime.emit("thread.message", {
          threadId: "thr_1",
          message: textMessage(`m${i}`),
        });
      }
    }
    rawSocket(slow.ws).resume();
    for (let i = 19; i < 400; i += 20) {
      await slow.next("thread.message", (e) => e.message.id === `m${i}`, 5_000);
    }
    await slow.barrier();
    const received = slow.count("thread.delta");
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(deltas);
    slow.ws.terminate();
  });

  it("disconnects a client whose backlog of essential events passes the hard limit", async () => {
    const tiny = await startLiveApp({
      logger,
      hub: { dropThresholdBytes: 64 * 1024, maxBufferedBytes: 512 * 1024 },
    });
    try {
      const stuck = await TestSocket.open(tiny.wsUrl());
      const healthy = await TestSocket.open(tiny.wsUrl());
      await Promise.all([stuck.next("hello"), healthy.next("hello")]);
      rawSocket(stuck.ws).pause();
      const closed = stuck.closed();
      const text = "y".repeat(100 * 1024);
      for (let i = 0; i < 120 && tiny.hub.clientCount === 2; i++) {
        tiny.runtime.emit("thread.message", {
          threadId: "thr_1",
          message: textMessage(`big${i}`, text),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      await waitFor(() => tiny.hub.clientCount === 1);
      rawSocket(stuck.ws).resume();
      expect((await closed).code).toBe(1006);
      expect(logger.lines.some((line) => line.includes("not reading"))).toBe(true);
      await healthy.barrier();
      expect(healthy.ws.readyState).toBe(healthy.ws.OPEN);
      healthy.ws.terminate();
    } finally {
      await tiny.close();
    }
  });
});

describe("heartbeat", () => {
  it("terminates a client that stops answering pings and keeps one that answers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const beating = await startLiveApp({ hub: { heartbeatMs: 30_000 } });
    try {
      const alive = await TestSocket.open(beating.wsUrl());
      const dead = await TestSocket.open(beating.wsUrl(), { autoPong: false });
      await Promise.all([alive.next("hello"), dead.next("hello")]);
      let pings = 0;
      alive.ws.on("ping", () => pings++);
      const deadClosed = dead.closed();

      for (let beat = 1; beat <= 3; beat++) {
        vi.advanceTimersByTime(30_000);
        await waitFor(() => pings === beat);
        // The pong precedes the barrier on the wire, so the server has recorded it afterwards.
        await alive.barrier();
      }
      expect((await deadClosed).code).toBe(1006);
      expect(beating.hub.clientCount).toBe(1);
      expect(alive.ws.readyState).toBe(alive.ws.OPEN);
      alive.ws.terminate();
    } finally {
      vi.useRealTimers();
      await beating.close();
    }
  });
});

describe("many clients and shutdown", () => {
  it("fans out to 64 concurrent clients and forgets each one that leaves", async () => {
    const crowd = await Promise.all(Array.from({ length: 64 }, () => connect()));
    expect(app.hub.clientCount).toBe(64);
    app.runtime.emit("status", app.runtime.status());
    await Promise.all(crowd.map((client) => client.next("agent.status")));
    for (const client of crowd.slice(0, 32)) client.ws.close();
    await waitFor(() => app.hub.clientCount === 32);
    app.hub.broadcast({ type: "error", message: "broadcast" });
    await Promise.all(crowd.slice(32).map((client) => client.next("error")));
  });

  it("closes open sockets with 1001, terminates ones that never answer, then refuses upgrades", async () => {
    const closing = await startLiveApp();
    try {
      const polite = await TestSocket.open(closing.wsUrl());
      const stuck = await TestSocket.open(closing.wsUrl());
      await Promise.all([polite.next("hello"), stuck.next("hello")]);
      const politeClosed = polite.closed();
      const stuckClosed = stuck.closed();
      rawSocket(stuck.ws).pause();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let finished = false;
      const done = closing.hub.close().then(() => {
        finished = true;
      });
      expect((await politeClosed).code).toBe(1001);
      await spinUntil(() => closing.hub.clientCount === 1);
      await spinUntil(() => false, 50);
      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await spinUntil(() => finished);
      vi.useRealTimers();
      await done;
      expect(closing.hub.clientCount).toBe(0);
      rawSocket(stuck.ws).resume();
      await stuckClosed;
      expect(await upgradeOutcome(closing.wsUrl())).toBe("HTTP 426");
    } finally {
      vi.useRealTimers();
      await closing.close();
    }
  });
});
