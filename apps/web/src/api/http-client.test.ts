import { API_VERSION, CLIENT_ID_HEADER, type ServerEvent } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionChange } from "./client";
import { ConflictError, HttpError } from "./errors";
import { HttpDaemonClient } from "./http-client";
import type { SocketLike } from "./socket";

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function setup(responder: (url: string, init: RequestInit) => Response) {
  const requests: Captured[] = [];
  const sockets: FakeSocket[] = [];
  const client = new HttpDaemonClient({
    baseUrl: "http://127.0.0.1:7331",
    token: "test-token",
    clientId: "web_test",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return responder(url, init);
    }) as unknown as typeof fetch,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { client, requests, sockets };
}

describe("HttpDaemonClient REST", () => {
  it("sends auth + client id headers and JSON bodies to encoded routes", async () => {
    const { client, requests } = setup(() =>
      jsonResponse(200, { path: "a", version: "v2", mtime: 1 }),
    );
    await client.writeNote("Daily/Sept notes #1.md", { content: "x", baseVersion: "v1" });
    const [request] = requests;
    expect(request?.url).toBe("http://127.0.0.1:7331/api/notes/Daily/Sept%20notes%20%231.md");
    expect(request?.init.method).toBe("PUT");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers[CLIENT_ID_HEADER]).toBe("web_test");
    expect(JSON.parse(String(request?.init.body))).toEqual({ content: "x", baseVersion: "v1" });
  });

  it("turns a 409 into a ConflictError carrying the current note", async () => {
    const current = { path: "a.md", content: "theirs", version: "v9", mtime: 2 };
    const { client } = setup(() => jsonResponse(409, { error: "conflict", current }));
    const error = await client
      .writeNote("a.md", { content: "mine", baseVersion: "v1" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).current).toEqual(current);
  });

  it("surfaces other failures as HttpError with the server message", async () => {
    const { client } = setup(() =>
      jsonResponse(404, { error: "not_found", message: "No such note" }),
    );
    const error = await client.readNote("missing.md").catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).message).toBe("No such note");
  });

  it("keeps a 429's Retry-After", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ error: "rate_limited", message: "Too many" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "12" },
        }),
    );
    await expect(client.createPairingCode()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 12,
    });
  });

  it("uses the daily route with create and tolerates empty bodies", async () => {
    const { client, requests } = setup((url) =>
      url.includes("/api/daily/")
        ? jsonResponse(200, { path: "Daily/x.md" })
        : new Response(null, { status: 204 }),
    );
    await client.getDailyNote("2026-09-23");
    expect(requests[0]?.url).toBe("http://127.0.0.1:7331/api/daily/2026-09-23?create=1");
    await expect(client.deleteNote("a.md")).resolves.toBeUndefined();
  });

  it("normalizes connector and approval responses", async () => {
    const { client } = setup((url) =>
      url.endsWith("/api/connectors")
        ? jsonResponse(200, {
            connectors: [{ name: "mail", transport: "http", state: "idle", toolCount: 2 }],
          })
        : jsonResponse(200, { approval: { id: "apr_1", status: "approved" } }),
    );
    expect((await client.getConnectors()).map((c) => c.name)).toEqual(["mail"]);
    expect((await client.decideApproval("apr_1", { decision: "approve" }))?.id).toBe("apr_1");
  });
});

describe("HttpDaemonClient event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says hello, dispatches valid events and drops malformed ones", () => {
    const { client, sockets } = setup(() => jsonResponse(200, {}));
    const events: ServerEvent[] = [];
    client.onEvent((event) => events.push(event));
    client.connect();
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:7331/ws?token=test-token");
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "hello",
      clientId: "web_test",
      apiVersion: API_VERSION,
      clientVersion: expect.stringMatching(/^web\//),
    });
    socket.receive({ type: "thread.delta", threadId: "t", messageId: "m", delta: "hi" });
    socket.receive({ type: "thread.delta", threadId: "t" });
    socket.receive({ type: "unknown" });
    socket.receive("not json");
    expect(events).toEqual([{ type: "thread.delta", threadId: "t", messageId: "m", delta: "hi" }]);
    client.disconnect();
  });

  it("reconnects with backoff, reports reconnected and replays surface subscriptions", async () => {
    const { client, sockets } = setup(() => jsonResponse(200, {}));
    const changes: ConnectionChange[] = [];
    client.onConnectionChange((change) => changes.push(change));
    client.connect();
    sockets[0]!.open();
    client.send({ type: "surface.subscribe", threadId: "thr_1", surface: "browser" });
    sockets[0]!.drop();
    expect(client.connectionState).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(changes.at(-1)).toEqual({ state: "online", reconnected: true });
    const replayed = sockets[1]!.sent.map((s) => JSON.parse(s));
    expect(replayed).toContainEqual({
      type: "surface.subscribe",
      threadId: "thr_1",
      surface: "browser",
    });

    client.send({ type: "surface.unsubscribe", threadId: "thr_1", surface: "browser" });
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    sockets[2]!.open();
    expect(sockets[2]!.sent.map((s) => JSON.parse(s).type)).toEqual(["hello"]);
    client.disconnect();
    expect(client.connectionState).toBe("offline");
  });
});

describe("HttpDaemonClient with a device cookie (a paired remote browser)", () => {
  function cookieSetup(responder: (url: string, init: RequestInit) => Response) {
    const requests: Captured[] = [];
    const sockets: FakeSocket[] = [];
    const onUnauthorized = vi.fn();
    const client = new HttpDaemonClient({
      baseUrl: "https://vm-name.tailnet-name.ts.net",
      token: null,
      onUnauthorized,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return responder(url, init);
      }) as unknown as typeof fetch,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    return { client, requests, sockets, onUnauthorized };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends no Authorization header and lets the browser send the cookie", async () => {
    const { client, requests } = cookieSetup(() => jsonResponse(200, { devices: [] }));
    await client.listDevices();
    await client.updateDevice({ placement: "always_on_machine" });
    for (const { init } of requests) {
      expect(init.headers).not.toHaveProperty("Authorization");
      expect(init.credentials).toBe("same-origin");
    }
    expect(requests[1]).toMatchObject({
      url: "https://vm-name.tailnet-name.ts.net/api/device",
      init: { method: "PATCH", body: JSON.stringify({ placement: "always_on_machine" }) },
    });
  });

  it("opens the socket without a token in the URL", () => {
    const { client, sockets } = cookieSetup(() => jsonResponse(200, {}));
    client.connect();
    expect(sockets[0]!.url).toBe("wss://vm-name.tailnet-name.ts.net/ws");
    client.disconnect();
  });

  it("reports a 401 once (the device was revoked) and stops the socket", async () => {
    const { client, sockets, onUnauthorized } = cookieSetup(() =>
      jsonResponse(401, { error: "unauthorized", message: "Missing or invalid bearer token" }),
    );
    client.connect();
    sockets[0]!.open();
    await expect(client.getDevice()).rejects.toMatchObject({ status: 401 });
    await expect(client.listDevices()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(client.connectionState).toBe("offline");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);
  });

  it("probes with a request when the socket drops, since a refused upgrade has no status", async () => {
    let revoked = false;
    const { client, requests, sockets, onUnauthorized } = cookieSetup(() =>
      revoked ? jsonResponse(401, { error: "unauthorized" }) : jsonResponse(200, {}),
    );
    client.connect();
    sockets[0]!.open();
    revoked = true;
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.map((r) => r.url)).toEqual(["https://vm-name.tailnet-name.ts.net/api/health"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("with the embedded token, a 401 is just an error and nothing probes", async () => {
    const { client, requests, sockets } = setup(() => jsonResponse(401, { error: "unauthorized" }));
    client.connect();
    sockets[0]!.open();
    await expect(client.getDevice()).rejects.toMatchObject({ status: 401 });
    expect(client.connectionState).toBe("online");
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    client.disconnect();
  });
});
