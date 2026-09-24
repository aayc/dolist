import type { ConnectionState } from "./client";

/** The subset of the WebSocket API we rely on (injectable for tests and native shells). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export interface ReconnectingSocketOptions {
  url(): string;
  onOpen(reconnected: boolean): void;
  onMessage(data: string): void;
  onStateChange(state: ConnectionState, reconnected: boolean): void;
  createSocket?(url: string): SocketLike;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Keep-alive message sent while open (proxies drop idle sockets). */
  pingMessage?: string;
  pingIntervalMs?: number;
  random?(): number;
}

/** WebSocket with exponential backoff + jitter, keep-alive pings and fast retry on network/visibility changes. */
export class ReconnectingSocket {
  private readonly options: ReconnectingSocketOptions;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private everOpened = false;
  private removeWindowListeners: (() => void) | null = null;

  constructor(options: ReconnectingSocketOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.onStateChange(this.everOpened ? "reconnecting" : "connecting", false);
    this.listenToWindow();
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearRetry();
    this.stopPing();
    this.removeWindowListeners?.();
    this.removeWindowListeners = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client closed");
    this.options.onStateChange("offline", false);
  }

  send(data: string): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(data);
    return true;
  }

  /** Skips the remaining backoff delay. */
  retryNow(): void {
    if (this.stopped || this.socket) return;
    this.clearRetry();
    this.open();
  }

  private open(): void {
    let socket: SocketLike;
    try {
      const url = this.options.url();
      socket = this.options.createSocket
        ? this.options.createSocket(url)
        : (new WebSocket(url) as unknown as SocketLike);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.startPing();
      this.options.onStateChange("online", reconnected);
      this.options.onOpen(reconnected);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === "string")
        this.options.onMessage(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      if (this.stopped) return;
      this.options.onStateChange(this.everOpened ? "reconnecting" : "connecting", false);
      this.scheduleRetry();
    };
    socket.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const initial = this.options.initialDelayMs ?? 300;
    const max = this.options.maxDelayMs ?? 10_000;
    const base = Math.min(max, initial * 2 ** this.attempt);
    const random = this.options.random ?? Math.random;
    const delay = Math.max(0, base + base * 0.25 * (random() * 2 - 1));
    this.attempt++;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && !this.socket) this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private startPing(): void {
    this.stopPing();
    const message = this.options.pingMessage;
    if (!message) return;
    this.pingTimer = setInterval(() => this.send(message), this.options.pingIntervalMs ?? 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private listenToWindow(): void {
    if (typeof window === "undefined" || this.removeWindowListeners) return;
    const onOnline = () => this.retryNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") this.retryNow();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    this.removeWindowListeners = () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }
}
