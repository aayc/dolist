import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type Logger, SYNC_ID_PATTERN, SYNC_LIMITS, silentLogger } from "@ddl/core";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createSyncApp } from "./app";
import { type RateLimit, RateLimiter } from "./rate-limit";
import { SyncStore } from "./store";
import { StreamHub } from "./stream";
import { parseBearer } from "./tokens";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7332;
/** Modest: bursts cover a first sync of a few hundred notes; a runaway client is slowed down. */
export const DEFAULT_RATE_LIMIT: RateLimit = { perSecond: 100, burst: 1_000 };
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_STREAMS_PER_VAULT = 32;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const STATS_INTERVAL_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;

export interface SyncServerOptions {
  /** A database file, `:memory:`, or an open store (which the caller keeps and closes). */
  db: string | SyncStore;
  /** Default 127.0.0.1. Anything public belongs behind a TLS-terminating proxy. */
  host?: string;
  /** Default 7332; 0 picks a free port. */
  port?: number;
  /** Largest file content, UTF-8 bytes. Default 5 MiB. */
  maxFileBytes?: number;
  /** Storage quota per vault in bytes (only used when this server opens the database). */
  quotaBytes?: number;
  rateLimit?: RateLimit;
  heartbeatMs?: number;
  maxStreamsPerVault?: number;
  logger?: Logger;
  now?: () => number;
}

export interface RunningSyncServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly store: SyncStore;
  readonly hub: StreamHub;
  close(): Promise<void>;
}

/** Starts the sync service: the HTTP API plus the per-vault WebSocket streams. */
export async function createSyncServer(options: SyncServerOptions): Promise<RunningSyncServer> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  const ownsStore = typeof options.db === "string";
  const store =
    typeof options.db === "string"
      ? new SyncStore(options.db, {
          now,
          ...(options.quotaBytes !== undefined ? { quotaBytes: options.quotaBytes } : {}),
        })
      : options.db;
  const limiter = new RateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT, now);
  const hub = new StreamHub({
    store,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    maxPerVault: options.maxStreamsPerVault ?? DEFAULT_STREAMS_PER_VAULT,
    maxBufferedBytes: MAX_BUFFERED_BYTES,
    logger,
    now,
  });
  const stats = new TrafficStats(logger);
  const app = createSyncApp({
    store,
    hub,
    limiter,
    maxFileBytes: options.maxFileBytes ?? SYNC_LIMITS.fileBytes,
    logger,
    onRequest: (vault, status) => stats.count(vault, status),
  });

  const server = createServer(getRequestListener(app.fetch));
  // Clients send nothing on the stream; anything big is misbehaving.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const outcome = authorizeUpgrade(req, store, limiter, hub);
    if (typeof outcome === "number") {
      rejectUpgrade(socket, outcome);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      stats.count(outcome.vault, 101);
      hub.accept(outcome.vault, outcome.tokenHash, ws);
    });
  });

  const host = options.host ?? DEFAULT_HOST;
  let port: number;
  try {
    port = await listen(server, host, options.port ?? DEFAULT_PORT);
  } catch (error) {
    await hub.close();
    if (ownsStore) store.close();
    throw error;
  }
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  logger.info("Sync server listening", { url });

  let closing: Promise<void> | undefined;
  const close = async () => {
    stats.stop();
    await hub.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeServer(server);
    if (ownsStore) store.close();
  };
  return {
    url,
    host,
    port,
    store,
    hub,
    close: () => {
      closing ??= close();
      return closing;
    },
  };
}

type UpgradeOutcome = { vault: string; tokenHash: Uint8Array } | 401 | 404 | 429;

function authorizeUpgrade(
  req: IncomingMessage,
  store: SyncStore,
  limiter: RateLimiter,
  hub: StreamHub,
): UpgradeOutcome {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://sync.invalid").pathname;
  } catch {
    return 404;
  }
  const match = /^\/v1\/vaults\/([^/]+)\/stream$/.exec(pathname);
  if (!match) return 404;
  let vault: string;
  try {
    vault = decodeURIComponent(match[1]!);
  } catch {
    return 404;
  }
  // Node keeps only one of repeated Authorization headers; ambiguous upgrades are refused.
  if (headerCount(req.rawHeaders, "authorization") !== 1) return 401;
  const token = parseBearer(req.headers.authorization);
  const tokenHash =
    token !== undefined && SYNC_ID_PATTERN.test(vault) ? store.authenticate(vault, token) : null;
  if (!tokenHash) return 401;
  if (limiter.take(vault) !== null || !hub.canAccept(vault)) return 429;
  return { vault, tokenHash };
}

function headerCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) count++;
  }
  return count;
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 429): void {
  const reason = { 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests" }[status];
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} on ${host} is already in use`)
          : error,
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
    server.close((error) => {
      clearTimeout(force);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

/** Per-vault request counts, logged at info once a minute when there was traffic. */
class TrafficStats {
  readonly #logger: Logger;
  readonly #counts = new Map<string, { requests: number; errors: number }>();
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(logger: Logger) {
    this.#logger = logger;
    this.#timer = setInterval(() => this.#flush(), STATS_INTERVAL_MS);
    this.#timer.unref();
  }

  count(vault: string, status: number): void {
    const entry = this.#counts.get(vault) ?? { requests: 0, errors: 0 };
    entry.requests++;
    if (status >= 400) entry.errors++;
    this.#counts.set(vault, entry);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#flush();
  }

  #flush(): void {
    for (const [vault, { requests, errors }] of this.#counts) {
      this.#logger.info("Vault traffic", { vault, requests, errors });
    }
    this.#counts.clear();
  }
}
