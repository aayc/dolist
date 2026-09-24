import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentRuntime } from "@ddl/agent";
import {
  API_ROUTES,
  API_VERSION,
  type ClientEvent,
  isHiddenPath,
  type Logger,
  normalizePath,
  type ServerEvent,
  type SurfaceFrame,
  type SurfaceKind,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { errorMessage } from "./errors";
import { isValidClientId } from "./http-utils";
import type { SecurityPolicy } from "./security";
import type { SettingsStore } from "./settings-store";
import { parseBearer } from "./token";
import { VaultChangeBatcher } from "./vault-events";
import { DAEMON_VERSION } from "./version";
import type { WriteTracker } from "./write-tracker";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_COALESCE_MS = 30;
/** Above this, frames and token deltas are skipped for the client (the final message repairs it). */
const DEFAULT_DROP_THRESHOLD_BYTES = 1024 * 1024;
/** Above this, the client cannot keep up even with essential events; it reconnects and resyncs. */
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SURFACES_PER_CLIENT = 16;
const CLOSE_GRACE_MS = 1_000;

const IdSchema = z.string().min(1).max(200);
const SurfaceSchema = z.enum(["browser", "computer"]);

const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), clientId: z.string().refine(isValidClientId) }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("surface.subscribe"), threadId: IdSchema, surface: SurfaceSchema }),
  z.object({ type: z.literal("surface.unsubscribe"), threadId: IdSchema, surface: SurfaceSchema }),
  z.object({ type: z.literal("thread.read"), threadId: IdSchema }),
  z.object({
    type: z.literal("editor.activity"),
    notePath: z.string().min(1).max(1024),
    line: z.int().min(0),
  }),
]) satisfies z.ZodType<ClientEvent>;

export interface WebSocketHubOptions {
  server: Server;
  policy: SecurityPolicy;
  storage: StorageProvider;
  runtime: AgentRuntime;
  settings: SettingsStore;
  writes: WriteTracker;
  logger: Logger;
  heartbeatMs?: number;
  coalesceMs?: number;
  dropThresholdBytes?: number;
  maxBufferedBytes?: number;
}

export interface WebSocketHub {
  readonly clientCount: number;
  broadcast(event: ServerEvent): void;
  close(): Promise<void>;
}

interface Client {
  readonly ws: WebSocket;
  clientId: string | undefined;
  readonly surfaces: Set<string>;
  alive: boolean;
}

/**
 * The `/ws` endpoint: authenticates the upgrade (Host, Origin, token via `?token=` or the dev
 * proxy's `Authorization` header), pushes vault/agent/settings events, and routes live surface
 * frames only to clients subscribed to that thread's surface.
 */
export function attachWebSocketHub(options: WebSocketHubOptions): WebSocketHub {
  const { server, policy, runtime, logger } = options;
  const dropThreshold = options.dropThresholdBytes ?? DEFAULT_DROP_THRESHOLD_BYTES;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const clients = new Set<Client>();
  const surfaceSubscriptions = new Map<string, { count: number; release: Unsubscribe }>();

  const send = (client: Client, data: string, droppable: boolean): void => {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxBuffered) {
      logger.warn("Dropping a WebSocket client that is not reading");
      ws.terminate();
      return;
    }
    if (droppable && ws.bufferedAmount > dropThreshold) return;
    ws.send(data);
  };

  const broadcast = (event: ServerEvent, droppable = false): void => {
    if (clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of clients) send(client, data, droppable);
  };

  const sendError = (client: Client, message: string): void => {
    send(client, JSON.stringify({ type: "error", message } satisfies ServerEvent), false);
  };

  const sendFrame = (frame: SurfaceFrame): void => {
    const key = surfaceKey(frame.threadId, frame.surface);
    let data: string | undefined;
    for (const client of clients) {
      if (!client.surfaces.has(key)) continue;
      data ??= JSON.stringify({ type: "surface.frame", ...frame } satisfies ServerEvent);
      send(client, data, true);
    }
  };

  const subscribeSurface = (client: Client, threadId: string, surface: SurfaceKind): void => {
    const key = surfaceKey(threadId, surface);
    if (client.surfaces.has(key)) return;
    if (client.surfaces.size >= MAX_SURFACES_PER_CLIENT) {
      sendError(client, "Too many surface subscriptions");
      return;
    }
    const existing = surfaceSubscriptions.get(key);
    if (existing) {
      existing.count++;
    } else {
      try {
        surfaceSubscriptions.set(key, {
          count: 1,
          release: runtime.subscribeSurface(threadId, surface),
        });
      } catch (error) {
        logger.warn("Surface subscription failed", { error: errorMessage(error) });
        sendError(client, "Could not subscribe to the surface");
        return;
      }
    }
    client.surfaces.add(key);
  };

  const unsubscribeSurface = (client: Client, key: string): void => {
    if (!client.surfaces.delete(key)) return;
    const entry = surfaceSubscriptions.get(key);
    if (!entry || --entry.count > 0) return;
    surfaceSubscriptions.delete(key);
    safely(logger, "release surface", entry.release);
  };

  const handleEvent = (client: Client, event: ClientEvent): void => {
    switch (event.type) {
      case "hello":
        client.clientId = event.clientId;
        return;
      case "ping":
        return;
      case "surface.subscribe":
        subscribeSurface(client, event.threadId, event.surface);
        return;
      case "surface.unsubscribe":
        unsubscribeSurface(client, surfaceKey(event.threadId, event.surface));
        return;
      case "thread.read":
        safely(logger, "markThreadRead", () => runtime.markThreadRead(event.threadId));
        return;
      case "editor.activity": {
        const notePath = visiblePath(event.notePath);
        if (notePath) {
          safely(logger, "noteEditorActivity", () =>
            runtime.noteEditorActivity(notePath, event.line),
          );
        }
        return;
      }
    }
  };

  const handleMessage = (client: Client, data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      sendError(client, "Binary messages are not supported");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawDataToString(data));
    } catch {
      sendError(client, "Messages must be JSON");
      return;
    }
    const parsed = ClientEventSchema.safeParse(raw);
    if (!parsed.success) {
      sendError(client, "Invalid message");
      return;
    }
    handleEvent(client, parsed.data);
  };

  const onConnection = (ws: WebSocket): void => {
    const client: Client = { ws, clientId: undefined, surfaces: new Set(), alive: true };
    clients.add(client);
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data, isBinary) => handleMessage(client, data, isBinary));
    ws.on("error", (error) => logger.debug("WebSocket error", { error: error.message }));
    ws.on("close", () => {
      clients.delete(client);
      for (const key of [...client.surfaces]) unsubscribeSurface(client, key);
    });
    send(
      client,
      JSON.stringify({
        type: "hello",
        serverVersion: DAEMON_VERSION,
        apiVersion: API_VERSION,
      } satisfies ServerEvent),
      false,
    );
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    const rejection = upgradeRejection(req, policy);
    if (rejection === null) wss.handleUpgrade(req, socket, head, onConnection);
    else rejectUpgrade(socket, rejection);
  };
  server.on("upgrade", onUpgrade);

  const batcher = new VaultChangeBatcher({
    writes: options.writes,
    delayMs: options.coalesceMs ?? DEFAULT_COALESCE_MS,
    emit: (event) => broadcast(event),
  });

  const subscriptions: Unsubscribe[] = [
    options.storage.watch((event) => batcher.push(event)),
    options.settings.onChange((settings) => broadcast({ type: "settings.changed", settings })),
    runtime.on("task.records", ({ notePath, records }) =>
      broadcast({ type: "task.records", notePath, records }),
    ),
    runtime.on("task.record", (record) => broadcast({ type: "task.record", record })),
    runtime.on("thread.upsert", (thread) => broadcast({ type: "thread.upsert", thread })),
    runtime.on("thread.message", ({ threadId, message }) =>
      broadcast({ type: "thread.message", threadId, message }),
    ),
    runtime.on("thread.delta", ({ threadId, messageId, delta }) =>
      broadcast({ type: "thread.delta", threadId, messageId, delta }, true),
    ),
    runtime.on("approval.upsert", (approval) => broadcast({ type: "approval.upsert", approval })),
    runtime.on("status", (status) => broadcast({ type: "agent.status", status })),
    runtime.on("surface.frame", sendFrame),
  ];

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    batcher.cancel();
    for (const unsubscribe of subscriptions) safely(logger, "unsubscribe", unsubscribe);
    for (const client of clients) client.ws.close(1001, "Server shutting down");
    const straggler = setTimeout(() => {
      for (const client of clients) client.ws.terminate();
    }, CLOSE_GRACE_MS);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    clearTimeout(straggler);
    for (const entry of surfaceSubscriptions.values()) {
      safely(logger, "release surface", entry.release);
    }
    surfaceSubscriptions.clear();
  };
  let closing: Promise<void> | undefined;

  return {
    get clientCount() {
      return clients.size;
    },
    broadcast: (event) => broadcast(event),
    close() {
      closing ??= close();
      return closing;
    },
  };
}

function surfaceKey(threadId: string, surface: SurfaceKind): string {
  return `${threadId}\u0000${surface}`;
}

function visiblePath(input: string): string | null {
  try {
    const path = normalizePath(input);
    return path && !isHiddenPath(path) ? path : null;
  } catch {
    return null;
  }
}

/** The HTTP status to refuse an upgrade with, or null when it is authorized. */
function upgradeRejection(req: IncomingMessage, policy: SecurityPolicy): 401 | 403 | 404 | null {
  const target = parseRequestTarget(req.url);
  if (target?.url.pathname !== API_ROUTES.ws) return 404;
  // Node keeps only the first of repeated Host/Authorization headers while the HTTP guard sees them
  // joined (and refuses), so ambiguous upgrades are refused as well.
  if (headerCount(req.rawHeaders, "host") !== 1 || !policy.isHostAllowed(req.headers.host)) {
    return 403;
  }
  if (target.absolute && !policy.isHostAllowed(target.url.host)) return 403;
  const origin = req.headers.origin;
  if (origin !== undefined && !policy.isOriginAllowed(origin)) return 403;
  if (headerCount(req.rawHeaders, "authorization") > 1) return 401;
  const token = target.url.searchParams.get("token") ?? parseBearer(req.headers.authorization);
  return policy.verifyToken(token) ? null : 401;
}

/** Origin-form targets are paths even when they start with `//`; absolute-form ones name a host. */
function parseRequestTarget(raw: string | undefined): { url: URL; absolute: boolean } | null {
  const target = raw ?? "/";
  const absolute = !target.startsWith("/");
  try {
    return { url: new URL(absolute ? target : `http://daemon.invalid${target}`), absolute };
  } catch {
    return null;
  }
}

function headerCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) count++;
  }
  return count;
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status];
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function safely(logger: Logger, label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logger.warn("WebSocket hub callback failed", { label, error: errorMessage(error) });
  }
}
