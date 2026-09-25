import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred, LEASE_EPOCH_HEADER } from "@ddl/core";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeStorageContract } from "./contract-suite";
import { RemoteStorageProvider, reconnectDelay, type WebSocketWithHeaders } from "./remote";
import { SyncRequestError } from "./remote-client";
import { startTestSyncServer, type TestSyncServer } from "./testing/sync-server";
import { StaleLeaseError, StorageError, type StorageEvent } from "./types";

describeStorageContract("RemoteStorageProvider", async () => {
  const sync = await startTestSyncServer();
  // The suite writes the agent's files too, which only the agent lease holder may do.
  const { epoch } = sync.holdAgentLease("dev_contract");
  return {
    provider: sync.provider("dev_contract", { leaseEpoch: () => epoch }),
    cleanup: () => sync.close(),
  };
});

/** A WebSocket stand-in the test drives by hand (HTTP still goes to the real server). */
class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.closed = true;
  }
}
const FakeWebSocket = FakeSocket as unknown as WebSocketWithHeaders;

const remote = (event: Pick<StorageEvent, "kind" | "path">): StorageEvent =>
  event.kind === "deleted"
    ? { ...event, self: false }
    : { ...event, version: expect.any(String) as string, self: false };

describe("RemoteStorageProvider", () => {
  let sync: TestSyncServer;

  beforeEach(async () => {
    FakeSocket.instances.length = 0;
    sync = await startTestSyncServer();
  });

  afterEach(async () => {
    await sync.close();
  });

  it("is named after its server and vault", () => {
    const provider = sync.provider("dev_a");
    const host = new URL(sync.url).host;
    expect(provider).toMatchObject({
      kind: "remote",
      id: `remote-${host}-${sync.vault}`,
      displayName: `${host}/${sync.vault}`,
      deviceName: "Device dev_a",
      capabilities: { watch: true, atomicWrites: true, folders: true },
    });
  });

  it("reports other devices' changes as they happen, and its own only once", async () => {
    const a = sync.provider("dev_a");
    const b = sync.provider("dev_b");
    const events: StorageEvent[] = [];
    a.watch((event) => events.push(event));
    await vi.waitFor(() => expect(a.streamConnected).toBe(true));

    const own = await a.write("own.md", "mine");
    await b.write("Notes/theirs.md", "one");
    await b.write("Notes/theirs.md", "two");
    await b.write(".DS_Store", "junk");
    await b.delete("Notes/theirs.md");

    await vi.waitFor(() => expect(events.filter((event) => !event.self)).toHaveLength(3));
    expect(events).toEqual([
      { kind: "created", path: "own.md", version: own.version, self: true },
      remote({ kind: "created", path: "Notes/theirs.md" }),
      remote({ kind: "modified", path: "Notes/theirs.md" }),
      remote({ kind: "deleted", path: "Notes/theirs.md" }),
    ]);
  });

  it("replays the changes it missed while disconnected", async () => {
    const a = sync.provider("dev_a", { reconnectDelayMs: { initial: 1_500, max: 1_500 } });
    const b = sync.provider("dev_b");
    const events: StorageEvent[] = [];
    a.watch((event) => events.push(event));
    await vi.waitFor(() => expect(a.streamConnected).toBe(true));

    sync.server.hub.terminateAll();
    await vi.waitFor(() => expect(a.streamConnected).toBe(false));
    await b.write("while-away.md", "hello");
    await b.write("while-away.md", "hello again");
    expect(a.streamConnected).toBe(false);

    await vi.waitFor(() => expect(a.streamConnected).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() =>
      expect(events).toEqual([remote({ kind: "created", path: "while-away.md" })]),
    );
  });

  it("reconnects when the server comes back, and catches up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ddl-remote-restart-"));
    const db = join(dir, "sync.db");
    let server: RunningSyncServer | undefined = await createSyncServer({ db, port: 0 });
    const { vault, token } = server.store.createVault("Restart");
    const port = server.port;
    const connect = (deviceId: string) =>
      new RemoteStorageProvider({
        url: `http://127.0.0.1:${port}`,
        vault: vault.id,
        token,
        deviceId,
        deviceName: deviceId,
        reconnectDelayMs: { initial: 50, max: 200 },
      });
    const a = connect("dev_a");
    const b = connect("dev_b");
    try {
      const events: StorageEvent[] = [];
      a.watch((event) => events.push(event));
      await vi.waitFor(() => expect(a.streamConnected).toBe(true));
      await server.close();
      await vi.waitFor(() => expect(a.streamConnected).toBe(false));

      server = await listenAgain(db, port);
      await b.write("after-restart.md", "back");
      await vi.waitFor(() => expect(a.streamConnected).toBe(true), { timeout: 5_000 });
      await vi.waitFor(() =>
        expect(events).toEqual([remote({ kind: "created", path: "after-restart.md" })]),
      );
    } finally {
      await a.dispose();
      await b.dispose();
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("catches up when a heartbeat shows it missed a change", async () => {
    const b = sync.provider("dev_b");
    await b.write("one.md", "1");
    const a = sync.provider("dev_a", { WebSocket: FakeWebSocket });
    const events: StorageEvent[] = [];
    a.watch((event) => events.push(event));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe(`${sync.url.replace("http", "ws")}/v1/vaults/${sync.vault}/stream`);
    await a.list();
    socket.receive({ type: "ready", seq: 1, heartbeatMs: 25_000 });

    await b.write("two.md", "2");
    socket.receive({ type: "heartbeat", seq: 2, at: Date.now() });
    await vi.waitFor(() => expect(events).toEqual([remote({ kind: "created", path: "two.md" })]));
  });

  it("catches up on changes between its first listing and the stream getting ready", async () => {
    const b = sync.provider("dev_b");
    const a = sync.provider("dev_a", { WebSocket: FakeWebSocket });
    await a.list();
    const events: StorageEvent[] = [];
    a.watch((event) => events.push(event));
    await b.write("early.md", "made before the stream was ready");
    FakeSocket.instances[0]!.receive({ type: "ready", seq: 1, heartbeatMs: 25_000 });
    await vi.waitFor(() => expect(events).toEqual([remote({ kind: "created", path: "early.md" })]));
  });

  it("catches up when its first listing arrives after the stream got ready", async () => {
    const answered = deferred<void>();
    const gate = deferred<void>();
    const gatedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/files")) {
        answered.resolve();
        await gate.promise;
      }
      return response;
    };
    const b = sync.provider("dev_b");
    const a = sync.provider("dev_a", { WebSocket: FakeWebSocket, fetch: gatedFetch });
    const events: StorageEvent[] = [];
    a.watch((event) => events.push(event));
    const listing = a.list();
    await answered.promise;
    await b.write("late.md", "made while the listing was on its way");
    FakeSocket.instances[0]!.receive({ type: "ready", seq: 1, heartbeatMs: 25_000 });
    expect(events).toEqual([]);
    gate.resolve();
    expect(await listing).toEqual([]);
    await vi.waitFor(() => expect(events).toEqual([remote({ kind: "created", path: "late.md" })]));
  });

  it("closes the stream when the last listener leaves", async () => {
    const a = sync.provider("dev_a");
    const off = a.watch(() => {});
    await vi.waitFor(() => expect(sync.server.hub.count(sync.vault)).toBe(1));
    off();
    await vi.waitFor(() => expect(sync.server.hub.count(sync.vault)).toBe(0));
    expect(a.streamConnected).toBe(false);
  });

  it("sends the lease epoch with changes to the agent's files while it holds the lease", async () => {
    const sent: Array<{ method: string; path: string; epoch: string | null }> = [];
    const recording: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (init?.method && init.method !== "GET") {
        sent.push({
          method: init.method,
          path: decodeURIComponent(url.pathname.replace(/^.*\/vaults\/[^/]+/, "")),
          epoch: headers.get(LEASE_EPOCH_HEADER),
        });
      }
      return fetch(input, init);
    };
    const grant = sync.holdAgentLease("dev_a");
    let epoch: number | null = grant.epoch;
    const a = sync.provider("dev_a", { fetch: recording, leaseEpoch: () => epoch });
    await a.write(".daily-do-list/threads/t.json", "{}");
    await a.write(".daily-do-list/settings.json", "{}");
    await a.write("Daily/a.md", "a");
    await a.rename("Daily/a.md", ".daily-do-list/state/a.md");
    await a.deleteFolder(".daily-do-list/state");
    epoch = null;
    const refused = await a.delete(".daily-do-list/threads/t.json").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StaleLeaseError);
    expect(refused).toMatchObject({ path: ".daily-do-list/threads/t.json", currentEpoch: 1 });
    expect(sent).toEqual([
      { method: "PUT", path: "/files/.daily-do-list/threads/t.json", epoch: "1" },
      { method: "PUT", path: "/files/.daily-do-list/settings.json", epoch: null },
      { method: "PUT", path: "/files/Daily/a.md", epoch: null },
      { method: "POST", path: "/rename", epoch: "1" },
      { method: "DELETE", path: "/folders", epoch: "1" },
      { method: "DELETE", path: "/files/.daily-do-list/threads/t.json", epoch: null },
    ]);
  });

  it("reports a rejected token without revealing it", async () => {
    const secret = randomBytes(32).toString("base64url");
    const intruder = sync.provider("dev_x", { token: secret });
    const error = await intruder.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
    expect((error as Error).message).toMatch(/rejected the token/);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });

  it("reports an unreachable server as a StorageError", async () => {
    const closed = await createSyncServer({ db: ":memory:", port: 0 });
    const url = closed.url;
    await closed.close();
    const provider = sync.provider("dev_a", { url });
    const error = await provider.read("a.md").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncRequestError);
    expect(error).toMatchObject({ status: 0 });
    expect((error as Error).message).toMatch(/Could not reach the sync server/);
  });

  it("gives up on requests that take too long", async () => {
    const silent: Server = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = silent.address() as AddressInfo;
      const provider = sync.provider("dev_a", {
        url: `http://127.0.0.1:${port}`,
        requestTimeoutMs: 200,
      });
      await expect(provider.list()).rejects.toThrow(/timed out/);
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("waits and retries when the server asks it to slow down", async () => {
    const limited = await startTestSyncServer({ rateLimit: { perSecond: 1_000, burst: 1 } });
    try {
      const provider = limited.provider("dev_a");
      const [first, second] = await Promise.all([provider.list(), provider.list()]);
      expect(first).toEqual([]);
      expect(second).toEqual([]);
    } finally {
      await limited.close();
    }
  });

  it("refuses to talk to anything but http(s)", () => {
    expect(() => sync.provider("dev_a", { url: "ftp://example.invalid" })).toThrow(StorageError);
  });
});

describe("reconnectDelay", () => {
  const delay = (attempt: number, random: number) =>
    reconnectDelay(attempt, { initial: 500, max: 30_000 }, () => random);

  it("doubles from the initial delay up to the cap, with up to half of it as jitter", () => {
    expect([0, 1, 2, 5, 6, 60].map((attempt) => delay(attempt, 1))).toEqual([
      500, 1_000, 2_000, 16_000, 30_000, 30_000,
    ]);
    expect([0, 1, 60].map((attempt) => delay(attempt, 0))).toEqual([250, 500, 15_000]);
  });
});

/** A server on the same database and port (the old one may still hold the port briefly). */
async function listenAgain(db: string, port: number): Promise<RunningSyncServer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createSyncServer({ db, port });
    } catch (error) {
      if (attempt >= 50 || !String(error).includes("already in use")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
