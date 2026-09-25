import { SYNC_DEVICE_HEADER } from "@ddl/core";
import { WebSocket } from "ws";
import { createSyncServer, type RunningSyncServer, type SyncServerOptions } from "./server";

export interface TestVault {
  id: string;
  token: string;
}

export interface ApiRequest {
  body?: unknown;
  /** Sent as is (overrides `body`). */
  rawBody?: string;
  query?: Record<string, string>;
  /** `null` sends no Authorization header; a string sends `Bearer <token>`. */
  token?: string | null;
  /** `null` sends no device header. Default `dev_a`. */
  device?: string | null;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field
  body: any;
  headers: Headers;
}

export interface TestServer {
  server: RunningSyncServer;
  url: string;
  a: TestVault;
  b: TestVault;
  /** A request to `route` of vault `vault` (default: vault a, with its token). */
  api(method: string, route: string, init?: ApiRequest, vault?: TestVault): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** An in-process server (`:memory:`, ephemeral loopback port) with two vaults, a and b. */
export async function startTestServer(
  options: Partial<SyncServerOptions> = {},
): Promise<TestServer> {
  const server = await createSyncServer({ db: ":memory:", port: 0, ...options });
  const created = [server.store.createVault("Alpha"), server.store.createVault("Beta")];
  const [a, b] = created.map(({ vault, token }) => ({ id: vault.id, token })) as [
    TestVault,
    TestVault,
  ];
  const api = async (method: string, route: string, init: ApiRequest = {}, vault = a) => {
    const url = new URL(`${server.url}/v1/vaults/${vault.id}${route}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    const headers: Record<string, string> = { ...init.headers };
    const token = init.token === undefined ? vault.token : init.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const device = init.device === undefined ? "dev_a" : init.device;
    if (device !== null) headers[SYNC_DEVICE_HEADER] = device;
    let body: string | undefined = init.rawBody;
    if (body === undefined && init.body !== undefined) body = JSON.stringify(init.body);
    if (body !== undefined) headers["content-type"] ??= "application/json";
    const response = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { server, url: server.url, a, b, api, close: () => server.close() };
}

/** Percent-encodes each segment of a vault path, like clients do. */
export function filePath(path: string): string {
  return `/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export type Frame = Record<string, unknown> & { type: string };

/** A stream client that records frames; `next` waits for one matching `type`. */
export class StreamClient {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  closeCode: number | undefined;
  readonly #waiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  #read = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      this.frames.push(frame);
      this.#drain();
    });
    ws.on("close", (code) => {
      this.closeCode = code;
    });
  }

  static open(url: string, vault: string, token: string): Promise<StreamClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace("http", "ws")}/v1/vaults/${vault}/stream`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const client = new StreamClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  /** The next unread frame of `type` (frames of other types before it are skipped). */
  next(type: string, timeoutMs = 5_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), timeoutMs);
      this.#waiters.push({
        type,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
      this.#drain();
    });
  }

  closed(): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
  }

  #drain(): void {
    while (this.#waiters.length > 0 && this.#read < this.frames.length) {
      const frame = this.frames[this.#read++]!;
      const index = this.#waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index !== -1) this.#waiters.splice(index, 1)[0]!.resolve(frame);
    }
  }
}

/** The HTTP status an upgrade to `path` with these headers gets (101 when it's accepted). */
export function upgradeStatus(
  url: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}${path}`, { headers });
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once("error", (error) => {
      if (!String(error).includes("Unexpected server response")) reject(error);
    });
  });
}
