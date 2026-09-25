import { ServerEventSchema } from "@ddl/contract";
import {
  API_ROUTES,
  type ClientEvent,
  type Logger,
  type ServerEvent,
  type SurfaceKind,
  type Unsubscribe,
} from "@ddl/core";
import { type RawData, WebSocket } from "ws";
import type { MachineCredential } from "./sources";

/**
 * `connecting` until the first connection is up, then `connected`, or until the next success
 * `unreachable` (`rejected` when the machine refused this device's credential).
 */
export type LinkState = "connecting" | "connected" | "unreachable" | "rejected";

export interface LinkTimings {
  /** The upgrade and the machine's `hello`. */
  handshakeMs: number;
  /** How often the connection is checked: a ping that isn't answered by the next one closes it. */
  pingEveryMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_LINK_TIMINGS: LinkTimings = {
  handshakeMs: 5_000,
  pingEveryMs: 15_000,
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
};

/** The largest event accepted from the machine: frames (screenshots) are the big ones. */
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export interface MachineLinkOptions {
  credential: MachineCredential;
  onState(state: LinkState): void;
  /** Every validated event after the machine's `hello`. */
  onEvent(event: ServerEvent): void;
  logger: Logger;
  timings?: Partial<LinkTimings>;
}

/**
 * One WebSocket to the always-on machine's daemon: `/ws` with the token in the `Authorization`
 * header, never in the URL. It reconnects with backoff until closed and subscribes again, on every
 * connection, to the surfaces someone here watches.
 */
export class MachineLink {
  readonly credential: MachineCredential;
  readonly #options: MachineLinkOptions;
  readonly #timings: LinkTimings;
  readonly #surfaces = new Map<string, { threadId: string; surface: SurfaceKind; count: number }>();
  #ws: WebSocket | null = null;
  #state: LinkState = "connecting";
  #connected = false;
  #alive = true;
  #attempt = 0;
  #closed = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;

  constructor(options: MachineLinkOptions) {
    this.credential = options.credential;
    this.#options = options;
    this.#timings = { ...DEFAULT_LINK_TIMINGS, ...options.timings };
  }

  get state(): LinkState {
    return this.#state;
  }

  connect(): void {
    if (!this.#closed && !this.#ws) this.#open();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
    clearInterval(this.#ping);
    const ws = this.#ws;
    this.#ws = null;
    this.#connected = false;
    if (ws?.readyState === WebSocket.OPEN) ws.close(1000, "Relay closed");
    else ws?.terminate();
  }

  /** Sends an event while connected; false when it couldn't be sent. */
  send(event: ClientEvent): boolean {
    const ws = this.#ws;
    if (!this.#connected || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(event));
    return true;
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    const key = `${threadId}\u0000${surface}`;
    const entry = this.#surfaces.get(key);
    if (entry) entry.count++;
    else {
      this.#surfaces.set(key, { threadId, surface, count: 1 });
      this.send({ type: "surface.subscribe", threadId, surface });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#surfaces.get(key);
      if (!current || --current.count > 0) return;
      this.#surfaces.delete(key);
      this.send({ type: "surface.unsubscribe", threadId, surface });
    };
  }

  #open(): void {
    const url = new URL(API_ROUTES.ws, this.credential.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.credential.token}` },
      handshakeTimeout: this.#timings.handshakeMs,
      maxPayload: MAX_EVENT_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    this.#ws = ws;
    let refusedWith: number | undefined;
    let hello: ReturnType<typeof setTimeout> | undefined;
    ws.on("unexpected-response", (_request, response) => {
      refusedWith = response.statusCode;
      response.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      hello = setTimeout(() => ws.terminate(), this.#timings.handshakeMs);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary || this.#ws !== ws) return;
      const event = parseEvent(data);
      if (!event) {
        this.#options.logger.debug("Ignoring an event from the always-on machine");
        return;
      }
      if (event.type === "hello") {
        clearTimeout(hello);
        this.#onConnected(ws);
        return;
      }
      if (this.#connected) this.#options.onEvent(event);
    });
    ws.on("pong", () => {
      if (this.#ws === ws) this.#alive = true;
    });
    ws.on("error", (error) => {
      this.#options.logger.debug("The link to the always-on machine failed", {
        error: error.message,
      });
    });
    ws.on("close", () => {
      clearTimeout(hello);
      if (this.#ws !== ws) return;
      this.#ws = null;
      clearInterval(this.#ping);
      const wasConnected = this.#connected;
      this.#connected = false;
      if (this.#closed) return;
      if (wasConnected) this.#options.logger.info("Lost the link to the always-on machine");
      this.#setState(refusedWith === 401 ? "rejected" : "unreachable");
      this.#scheduleRetry();
    });
  }

  #onConnected(ws: WebSocket): void {
    this.#connected = true;
    this.#attempt = 0;
    this.#alive = true;
    clearInterval(this.#ping);
    this.#ping = setInterval(() => this.#checkAlive(), this.#timings.pingEveryMs);
    this.#ping.unref();
    for (const { threadId, surface } of this.#surfaces.values()) {
      ws.send(
        JSON.stringify({ type: "surface.subscribe", threadId, surface } satisfies ClientEvent),
      );
    }
    this.#options.logger.info("Linked to the always-on machine");
    this.#setState("connected");
  }

  /** A connection that didn't answer the previous ping is closed (and retried). */
  #checkAlive(): void {
    const ws = this.#ws;
    if (!ws || !this.#connected) return;
    if (!this.#alive) {
      ws.terminate();
      return;
    }
    this.#alive = false;
    ws.ping();
  }

  #scheduleRetry(): void {
    this.#attempt++;
    const { minBackoffMs, maxBackoffMs } = this.#timings;
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** (this.#attempt - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      if (!this.#closed && !this.#ws) this.#open();
    }, delay);
    this.#retry.unref();
  }

  #setState(state: LinkState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#options.onState(state);
  }
}

/**
 * A server event, validated against the contract. Frames are only checked for their routing
 * fields: their image data is megabytes of base64 and many of them arrive every second.
 */
function parseEvent(data: RawData): ServerEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawDataToString(data));
  } catch {
    return null;
  }
  if (isFrame(raw)) return raw;
  const parsed = ServerEventSchema.safeParse(raw);
  return parsed.success ? (parsed.data as ServerEvent) : null;
}

function isFrame(raw: unknown): raw is Extract<ServerEvent, { type: "surface.frame" }> {
  if (typeof raw !== "object" || raw === null) return false;
  const event = raw as Record<string, unknown>;
  return (
    event.type === "surface.frame" &&
    typeof event.threadId === "string" &&
    (event.surface === "browser" || event.surface === "computer") &&
    typeof event.data === "string" &&
    (event.mimeType === "image/jpeg" || event.mimeType === "image/png")
  );
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
