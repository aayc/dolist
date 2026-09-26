/**
 * Test-only helpers for the security and robustness suites: the daemon's HTTP + WebSocket surface
 * on 127.0.0.1:0 over any storage, raw HTTP over TCP (for requests `fetch` cannot express), a
 * logger that records every line, and an on-disk vault surrounded by canary files.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { inspect } from "node:util";
import { API_ROUTES, type Logger, type ServerEvent, silentLogger, sleep } from "@ddl/core";
import { MemoryStorageProvider, type StorageProvider } from "@ddl/storage";
import { fc } from "@fast-check/vitest";
import { getRequestListener } from "@hono/node-server";
import { vi } from "vitest";
import { type ClientOptions, WebSocket } from "ws";
import { createApp } from "../app";
import { PairedDeviceStore } from "../paired-devices";
import { PairingCodes } from "../pairing";
import { createRemoteHosts, type RemoteHostRegistry } from "../remote-hosts";
import { createSecurityPolicy } from "../security";
import { createSettingsStore, type SettingsStore } from "../settings-store";
import { FakeAgentRuntime, tempDir, testToken } from "../test-helpers";
import { WriteTracker } from "../write-tracker";
import { attachWebSocketHub, type WebSocketHub, type WebSocketHubOptions } from "../ws";

/**
 * A share of the global fast-check run count (FC_NUM_RUNS) for properties that do real I/O, so the
 * default suite stays fast while deeper sweeps still scale.
 */
export function ioRuns(share: number): number {
  return Math.max(10, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * share));
}

/** Test timeout for I/O properties, generous enough for deep FC_NUM_RUNS sweeps. */
export function ioTimeout(share: number): number {
  return Math.max(5_000, ioRuns(share) * 100);
}

type HubTuning = Pick<
  WebSocketHubOptions,
  "heartbeatMs" | "coalesceMs" | "dropThresholdBytes" | "maxBufferedBytes"
>;

export interface LiveAppOptions<S extends StorageProvider> {
  storage?: S;
  runtime?: FakeAgentRuntime;
  webDist?: string | null;
  allowedOrigins?: string[];
  remoteHosts?: RemoteHostRegistry;
  devices?: PairedDeviceStore;
  pairing?: PairingCodes;
  logger?: Logger;
  hub?: HubTuning;
}

export interface LiveApp<S extends StorageProvider> {
  readonly port: number;
  /** `127.0.0.1:<port>`, the canonical Host. */
  readonly host: string;
  readonly token: string;
  readonly storage: S;
  readonly runtime: FakeAgentRuntime;
  readonly settings: SettingsStore;
  readonly remoteHosts: RemoteHostRegistry;
  readonly devices: PairedDeviceStore;
  readonly pairing: PairingCodes;
  readonly writes: WriteTracker;
  readonly hub: WebSocketHub;
  readonly server: Server;
  wsUrl(query?: string): string;
  /** `fetch` with the bearer token. */
  api(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export type MemoryLiveApp = LiveApp<MemoryStorageProvider>;

/** The app and the WebSocket hub on a real loopback server, wired like `startDaemon`. */
export async function startLiveApp<S extends StorageProvider = MemoryStorageProvider>(
  options: LiveAppOptions<S> = {},
): Promise<LiveApp<S>> {
  const storage = options.storage ?? (new MemoryStorageProvider() as StorageProvider as S);
  const runtime = options.runtime ?? new FakeAgentRuntime();
  const logger = options.logger ?? silentLogger;
  const settings = await createSettingsStore({ storage });
  const writes = new WriteTracker();
  const token = testToken();
  let handler: Parameters<typeof getRequestListener>[0] = () => new Response(null, { status: 503 });
  const server = createServer(getRequestListener((request, env) => handler(request, env)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const allowedOrigins = options.allowedOrigins ?? [];
  const remoteHosts = options.remoteHosts ?? createRemoteHosts();
  const devices = options.devices ?? new PairedDeviceStore({ path: null, logger });
  const pairing = options.pairing ?? new PairingCodes();
  handler = createApp({
    storage,
    runtime,
    settings,
    config: { port, allowedOrigins },
    token,
    remoteHosts,
    devices,
    pairing,
    logger,
    webDist: options.webDist ?? null,
    writes,
  }).fetch;
  const hub = attachWebSocketHub({
    server,
    policy: createSecurityPolicy({
      port,
      token,
      extraOrigins: allowedOrigins,
      remoteHosts,
      devices,
    }),
    devices,
    storage,
    runtime,
    settings,
    writes,
    logger,
    coalesceMs: 5,
    ...options.hub,
  });
  let closed: Promise<void> | undefined;
  return {
    port,
    host: `127.0.0.1:${port}`,
    token,
    storage,
    runtime,
    settings,
    remoteHosts,
    devices,
    pairing,
    writes,
    hub,
    server,
    wsUrl: (query = `token=${token}`) => `ws://127.0.0.1:${port}${API_ROUTES.ws}?${query}`,
    api: (path, init = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
      }),
    close() {
      closed ??= (async () => {
        await hub.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      })();
      return closed;
    },
  };
}

export interface RawResponse {
  /** 0 when no status line arrived. */
  status: number;
  /** Lower-cased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: string;
  /** The server closed the connection before the helper gave up. */
  closed: boolean;
  elapsedMs: number;
}

export interface RawRequestOptions {
  /** Give up (and report what arrived) after this long. */
  timeoutMs?: number;
  /** Resolve only once the server closes the connection (or on timeout). */
  waitForClose?: boolean;
}

/** Writes `payload` verbatim to a fresh TCP connection and parses the first HTTP response. */
export function rawRequest(
  port: number,
  payload: string | Buffer,
  options: RawRequestOptions = {},
): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect(port, "127.0.0.1");
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...parseResponse(data), closed, elapsedMs: performance.now() - started });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!options.waitForClose && isCompleteResponse(data)) finish(false);
    });
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    socket.write(payload);
  });
}

function parseResponse(data: Buffer): Omit<RawResponse, "closed" | "elapsedMs"> {
  const text = data.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) return { status: 0, headers: {}, body: "" };
  const [statusLine = "", ...lines] = text.slice(0, end).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
  return { status, headers, body: data.subarray(end + 4).toString("utf8") };
}

function isCompleteResponse(data: Buffer): boolean {
  const text = data.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) return false;
  const { status, headers } = parseResponse(data);
  if (status === 101 || status === 204 || status === 304) return true;
  const length = headers["content-length"];
  if (length !== undefined) return data.length - (end + 4) >= Number(length);
  if (headers["transfer-encoding"]?.includes("chunked")) return text.endsWith("0\r\n\r\n");
  return false;
}

/** A raw HTTP/1.1 request; `headers` are written in order, verbatim (duplicates allowed). */
export function httpRequest(
  method: string,
  target: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body = "",
): string {
  const lines = headers.map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return `${method} ${target} HTTP/1.1\r\n${lines}\r\n${body}`;
}

export const WS_UPGRADE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Upgrade", "websocket"],
  ["Connection", "Upgrade"],
  ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
  ["Sec-WebSocket-Version", "13"],
];

/** Collects server events and lets tests await specific ones. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly events: ServerEvent[] = [];
  private readonly waiters = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.events.push(JSON.parse(String(data)) as ServerEvent);
      for (const wake of [...this.waiters]) wake();
    });
  }

  static open(url: string, options: ClientOptions = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const socket = new TestSocket(ws);
      ws.once("open", () => resolve(socket));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Resolves with the first event (consumed) of `type` that matches `predicate`. */
  next<T extends ServerEvent["type"]>(
    type: T,
    predicate: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const take = (): boolean => {
        const index = this.events.findIndex(
          (e) => e.type === type && predicate(e as Extract<ServerEvent, { type: T }>),
        );
        if (index === -1) return false;
        resolve(this.events.splice(index, 1)[0] as Extract<ServerEvent, { type: T }>);
        return true;
      };
      if (take()) return;
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const wake = () => {
        if (!take()) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      this.waiters.add(wake);
    });
  }

  /**
   * Resolves once the server has handled everything sent before and its answers have arrived: it
   * processes frames in order and answers a ping with a pong right away.
   */
  barrier(timeoutMs = 2_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for a pong")), timeoutMs);
      this.ws.once("pong", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.ping();
    });
  }

  count(type: ServerEvent["type"]): number {
    return this.events.filter((event) => event.type === type).length;
  }

  closed(): Promise<{ code: number; reason: string }> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "" });
    return new Promise((resolve) =>
      this.ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
    );
  }
}

/** The status an upgrade attempt ends with: "open" or "HTTP <status>". */
export function upgradeOutcome(url: string, options: ClientOptions = {}): Promise<string> {
  return TestSocket.open(url, options).then(
    (socket) => {
      socket.ws.terminate();
      return "open";
    },
    (error: Error) => error.message,
  );
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition not met in time");
    await sleep(2);
  }
}

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

/** Retries `assertion` until it passes; 30 s (scaled on slow CI) is a failure bound only. */
export const eventually = (assertion: () => Promise<void>) =>
  vi.waitFor(assertion, { timeout: 30_000 * TIME_SCALE, interval: 50 });

/** A Logger that keeps every line it is given (fields rendered in full, errors included). */
export class RecordingLogger implements Logger {
  readonly lines: string[];
  private readonly bindings: Record<string, unknown>;

  constructor(lines: string[] = [], bindings: Record<string, unknown> = {}) {
    this.lines = lines;
    this.bindings = bindings;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new RecordingLogger(this.lines, { ...this.bindings, ...bindings });
  }

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    const extra = { ...this.bindings, ...fields };
    this.lines.push(`${level} ${message} ${inspect(extra, { depth: 8, breakLength: Infinity })}`);
  }
}

export type TreeSnapshot = Map<string, string>;

export interface CanaryVault {
  /** Temp directory holding the vault and the canaries around it. */
  readonly root: string;
  readonly vault: string;
  snapshot(): TreeSnapshot;
  cleanup(): void;
}

/** Files outside the vault (including a sibling whose name extends the vault's) and hidden inside. */
export const CANARY_FILES: Readonly<Record<string, string>> = {
  "outside.md": "outside canary",
  "secret.env": "OPENROUTER_API_KEY=canary",
  "vault-evil/escaped.md": "sibling canary",
  "vault/.obsidian/app.json": '{"canary":true}',
  "vault/.trash/old.md": "trashed canary",
  "vault/.hidden.md": "hidden canary",
  "vault/.git/config": "[core]\n",
  "vault/.daily-do-list/state/canary.json": "{}",
  "vault/Notes/visible.md": "visible note",
};

export function createCanaryVault(): CanaryVault {
  const dir = tempDir("ddl-canary-");
  for (const [path, content] of Object.entries(CANARY_FILES)) {
    const abs = join(dir.path, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return {
    root: dir.path,
    vault: join(dir.path, "vault"),
    snapshot: () => snapshotTree(dir.path),
    cleanup: dir.cleanup,
  };
}

/** Every entry under `root` (symlinks not followed) mapped to its kind and content hash. */
export function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      const stats = lstatSync(abs);
      if (stats.isDirectory()) {
        out.set(rel, "dir");
        walk(abs);
      } else if (stats.isSymbolicLink()) {
        out.set(rel, "symlink");
      } else {
        out.set(rel, createHash("sha1").update(readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

/** Paths added, removed or changed between two snapshots. */
export function changedPaths(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, value] of after) if (before.get(path) !== value) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

/** Changed paths that are not visible entries inside `vault/` (relative to the canary root). */
export function forbiddenChanges(changes: readonly string[]): string[] {
  return changes.filter((path) => {
    if (!path.startsWith("vault/")) return true;
    return path
      .slice("vault/".length)
      .split("/")
      .some((segment) => segment.startsWith("."));
  });
}
