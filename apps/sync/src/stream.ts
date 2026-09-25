import {
  type Logger,
  SYNC_STREAM_CLOSE_CODES,
  type SyncChange,
  type SyncStreamMessage,
} from "@ddl/core";
import { WebSocket } from "ws";
import type { SyncStore } from "./store";

const CLOSE_GRACE_MS = 1_000;

export interface StreamHubOptions {
  store: SyncStore;
  heartbeatMs: number;
  /** Open streams per vault; more are refused at the upgrade. */
  maxPerVault: number;
  /** A client this far behind is dropped; it reconnects and catches up from the change log. */
  maxBufferedBytes: number;
  logger: Logger;
  now: () => number;
}

interface Subscriber {
  readonly ws: WebSocket;
  readonly vault: string;
  /** The token hash it authenticated with: the stream closes when the vault's token changes. */
  readonly tokenHash: Uint8Array;
  alive: boolean;
}

/**
 * Live change feeds, one set of WebSockets per vault. `publish` pushes every accepted change to
 * the vault's streams; a heartbeat carries the latest `seq` (so a client can tell it missed
 * something), pings to detect dead connections and re-checks each stream's token.
 */
export class StreamHub {
  readonly #options: StreamHubOptions;
  readonly #vaults = new Map<string, Set<Subscriber>>();
  readonly #heartbeat: ReturnType<typeof setInterval>;

  constructor(options: StreamHubOptions) {
    this.#options = options;
    this.#heartbeat = setInterval(() => this.#beat(), options.heartbeatMs);
    this.#heartbeat.unref();
  }

  canAccept(vault: string): boolean {
    return (this.#vaults.get(vault)?.size ?? 0) < this.#options.maxPerVault;
  }

  accept(vault: string, tokenHash: Uint8Array, ws: WebSocket): void {
    const subscriber: Subscriber = { ws, vault, tokenHash, alive: true };
    let subscribers = this.#vaults.get(vault);
    if (!subscribers) {
      subscribers = new Set();
      this.#vaults.set(vault, subscribers);
    }
    subscribers.add(subscriber);
    ws.on("pong", () => {
      subscriber.alive = true;
    });
    ws.on("error", (error) => this.#options.logger.debug("stream error", { error: error.message }));
    ws.on("close", () => {
      const set = this.#vaults.get(vault);
      set?.delete(subscriber);
      if (set?.size === 0) this.#vaults.delete(vault);
    });
    this.#send(subscriber, {
      type: "ready",
      seq: this.#options.store.latestSeq(vault),
      heartbeatMs: this.#options.heartbeatMs,
    });
  }

  publish(vault: string, changes: readonly SyncChange[]): void {
    const subscribers = this.#vaults.get(vault);
    if (!subscribers || changes.length === 0) return;
    const frames = changes.map((change) =>
      JSON.stringify({ type: "change", ...change } satisfies SyncStreamMessage),
    );
    for (const subscriber of [...subscribers]) {
      for (const frame of frames) this.#sendRaw(subscriber, frame);
    }
  }

  count(vault?: string): number {
    if (vault !== undefined) return this.#vaults.get(vault)?.size ?? 0;
    let total = 0;
    for (const set of this.#vaults.values()) total += set.size;
    return total;
  }

  /** Drops every stream without a close handshake, as a network failure would. */
  terminateAll(): void {
    for (const set of this.#vaults.values()) for (const { ws } of set) ws.terminate();
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
    const sockets = [...this.#vaults.values()].flatMap((set) => [...set].map((s) => s.ws));
    if (sockets.length === 0) return;
    const closed = sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve();
          else ws.once("close", () => resolve());
        }),
    );
    for (const ws of sockets)
      ws.close(SYNC_STREAM_CLOSE_CODES.shuttingDown, "Server shutting down");
    const straggler = setTimeout(() => {
      for (const ws of sockets) ws.terminate();
    }, CLOSE_GRACE_MS);
    await Promise.all(closed);
    clearTimeout(straggler);
  }

  #beat(): void {
    const { store, now } = this.#options;
    for (const [vault, subscribers] of this.#vaults) {
      const frame = JSON.stringify({
        type: "heartbeat",
        seq: store.latestSeq(vault),
        at: now(),
      } satisfies SyncStreamMessage);
      for (const subscriber of [...subscribers]) {
        const { ws } = subscriber;
        if (!store.isCurrentToken(vault, subscriber.tokenHash)) {
          ws.close(SYNC_STREAM_CLOSE_CODES.tokenRevoked, "Token revoked");
          continue;
        }
        if (!subscriber.alive) {
          ws.terminate();
          continue;
        }
        subscriber.alive = false;
        ws.ping();
        this.#sendRaw(subscriber, frame);
      }
    }
  }

  #send(subscriber: Subscriber, message: SyncStreamMessage): void {
    this.#sendRaw(subscriber, JSON.stringify(message));
  }

  #sendRaw(subscriber: Subscriber, data: string): void {
    const { ws } = subscriber;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.#options.maxBufferedBytes) {
      this.#options.logger.warn("Dropping a stream that is not reading", {
        vault: subscriber.vault,
      });
      ws.terminate();
      return;
    }
    ws.send(data);
  }
}
