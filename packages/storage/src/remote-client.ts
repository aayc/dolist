import {
  SYNC_DEVICE_HEADER,
  SYNC_ROUTES,
  type SyncErrorCode,
  type SyncLeaseConflictBody,
  type SyncLeaseHolder,
  type SyncLeaseName,
  type SyncLeaseRequest,
  type SyncLeaseResponse,
  type SyncLeaseStatusResponse,
  sleep,
} from "@ddl/core";
import { StorageError } from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 10_000;

export interface SyncServiceClientOptions {
  /** Base URL of the sync server, e.g. `https://sync.example.com` (a path prefix is kept). */
  url: string;
  vault: string;
  /** The vault's bearer token. Never logged, never part of an error message. */
  token: string;
  deviceId: string;
  /** Per request, including reading the response. Default 60 s. */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** The sync server refused a request (`status` ≥ 400) or couldn't be reached (`status` 0). */
export class SyncRequestError extends StorageError {
  readonly status: number;
  readonly code: SyncErrorCode | undefined;
  readonly body: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    code?: SyncErrorCode,
    body?: Record<string, unknown>,
    path?: string,
  ) {
    super(message, path);
    this.name = "SyncRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface SyncRequest {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Sends `X-DDL-Device` (every mutating request). */
  mutating?: boolean;
  signal?: AbortSignal;
  /** Statuses answered normally instead of thrown (e.g. 404 for a missing file). */
  accept?: readonly number[];
}

export interface SyncResponse<T> {
  status: number;
  body: T | undefined;
}

export type LeaseAttempt =
  | { granted: true; lease: SyncLeaseHolder }
  | { granted: false; holder: SyncLeaseHolder };

/**
 * HTTP client of one vault on a sync server (`@ddl/core` `sync-service.ts`): authentication,
 * the device header, timeouts, `Retry-After` on 429, and typed errors. Used by
 * `RemoteStorageProvider` and by the daemon for the agent lease.
 */
export class SyncServiceClient {
  readonly baseUrl: string;
  /** `host[:port]` of the server, for status and logs. */
  readonly host: string;
  readonly vault: string;
  readonly deviceId: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SyncServiceClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new StorageError(`Sync server URL must use http or https (got ${url.protocol})`);
    }
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.host = url.host;
    this.vault = options.vault;
    this.deviceId = options.deviceId;
    this.#token = options.token;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** `wss://…/v1/vaults/<vault>/stream` (or `ws://` for plain http). */
  streamUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}${SYNC_ROUTES.stream(this.vault)}`;
  }

  /** Headers of the stream's WebSocket upgrade. */
  streamHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, [SYNC_DEVICE_HEADER]: this.deviceId };
  }

  async request<T>(
    method: string,
    route: string,
    init: SyncRequest = {},
  ): Promise<SyncResponse<T>> {
    const url = new URL(`${this.baseUrl}${route}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    if (init.mutating) headers[SYNC_DEVICE_HEADER] = this.deviceId;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    for (let attempt = 0; ; attempt++) {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(this.#timeoutMs)])
        : AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(url, { method, headers, signal, ...(body ? { body } : {}) });
        text = await response.text();
      } catch (error) {
        throw new SyncRequestError(
          `Could not reach the sync server at ${this.host}: ${describeFailure(error)}`,
          0,
        );
      }
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryAfterMs(response.headers.get("retry-after")), init.signal);
        continue;
      }
      const parsed = parseJson(text);
      if (response.ok || init.accept?.includes(response.status)) {
        if (text && parsed === undefined) {
          throw new SyncRequestError(
            `The sync server at ${this.host} sent a response that isn't JSON`,
            response.status,
          );
        }
        return { status: response.status, body: parsed as T | undefined };
      }
      throw requestError(this.host, response.status, parsed);
    }
  }

  async acquireLease(name: SyncLeaseName, request: Omit<SyncLeaseRequest, "device">) {
    const { status, body } = await this.request<SyncLeaseResponse | SyncLeaseConflictBody>(
      "POST",
      SYNC_ROUTES.lease(this.vault, name),
      { body: { ...request, device: this.deviceId }, mutating: true, accept: [409] },
    );
    return leaseAttempt(status, body);
  }

  /** True when released (or already free); otherwise who holds it. */
  async releaseLease(
    name: SyncLeaseName,
    session: string,
  ): Promise<{ released: true } | { released: false; holder: SyncLeaseHolder }> {
    const { status, body } = await this.request<SyncLeaseConflictBody>(
      "DELETE",
      SYNC_ROUTES.lease(this.vault, name),
      { query: { device: this.deviceId, session }, mutating: true, accept: [409] },
    );
    if (status === 409 && body?.holder) return { released: false, holder: body.holder };
    return { released: true };
  }

  async leaseHolder(name: SyncLeaseName): Promise<SyncLeaseHolder | null> {
    const { body } = await this.request<SyncLeaseStatusResponse>(
      "GET",
      SYNC_ROUTES.lease(this.vault, name),
    );
    return body?.holder ?? null;
  }
}

function leaseAttempt(
  status: number,
  body: SyncLeaseResponse | SyncLeaseConflictBody | undefined,
): LeaseAttempt {
  if (status === 409 && body && "holder" in body) return { granted: false, holder: body.holder };
  if (body && "lease" in body) return { granted: true, lease: body.lease };
  throw new SyncRequestError("The sync server sent an unexpected lease response", status);
}

function requestError(host: string, status: number, body: unknown): SyncRequestError {
  const record = isRecord(body) ? body : undefined;
  const code = typeof record?.error === "string" ? (record.error as SyncErrorCode) : undefined;
  const detail = typeof record?.message === "string" ? `: ${record.message}` : "";
  const message =
    status === 401
      ? `The sync server at ${host} rejected the token for this vault`
      : `The sync server at ${host} answered ${status}${detail}`;
  return new SyncRequestError(message, status, code, record);
}

function retryAfterMs(header: string | null): number {
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : 1_000;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timed out";
    if (error.name === "AbortError") return "cancelled";
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
