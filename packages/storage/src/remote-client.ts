import {
  isRecord,
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
import { FileTooLargeError, StorageError } from "./types";

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
  /** Raw attachment bytes, mutually exclusive with JSON body. */
  bytes?: Uint8Array;
  /** Read a successful response as bytes with this strict allocation cap. */
  responseBytes?: number;
  /** Sends `X-DDL-Device` (every mutating request). */
  mutating?: boolean;
  /** Extra request headers (e.g. the lease epoch). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Statuses answered normally instead of thrown (e.g. 404 for a missing file). */
  accept?: readonly number[];
}

export interface SyncResponse<T> {
  status: number;
  body: T | undefined;
  bytes?: Uint8Array;
  headers?: Headers;
}

export type LeaseAttempt =
  | { granted: true; lease: SyncLeaseHolder }
  /** `takeoverPending`: this request outranks the holder, which was asked to yield. */
  | { granted: false; holder: SyncLeaseHolder; takeoverPending?: boolean };

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
    const headers: Record<string, string> = {
      ...init.headers,
      authorization: `Bearer ${this.#token}`,
    };
    if (init.mutating) headers[SYNC_DEVICE_HEADER] = this.deviceId;
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    if (init.bytes !== undefined) {
      if (init.body !== undefined) throw new StorageError("Binary and JSON bodies are exclusive");
      headers["content-type"] = "application/octet-stream";
      body = new Uint8Array(init.bytes);
    }
    for (let attempt = 0; ; attempt++) {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(this.#timeoutMs)])
        : AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(url, { method, headers, signal, ...(body ? { body } : {}) });
        if (response.ok && init.responseBytes !== undefined) {
          const bytes = await readBoundedResponse(response, init.responseBytes);
          return { status: response.status, body: undefined, bytes, headers: response.headers };
        }
        text = await response.text();
      } catch (error) {
        if (error instanceof StorageError) throw error;
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

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel();
    throw new FileTooLargeError("attachment", limit);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new FileTooLargeError("attachment", limit);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function leaseAttempt(
  status: number,
  body: SyncLeaseResponse | SyncLeaseConflictBody | undefined,
): LeaseAttempt {
  if (status === 409 && body && "holder" in body) {
    return body.takeoverPending === true
      ? { granted: false, holder: body.holder, takeoverPending: true }
      : { granted: false, holder: body.holder };
  }
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
