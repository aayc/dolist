/**
 * The relay's HTTP calls to the always-on machine. A request carries only what the relay puts in
 * it: the machine token, the allowlisted target and a validated body. Nothing from the client's
 * request (its Authorization, cookies, Host, Origin or other headers) is passed on.
 */
import type { MachineCredential } from "../agent-location";

export const RELAY_LIMITS = {
  /** Every call to the machine, answer included. */
  timeoutMs: 5_000,
  /** The largest answer accepted from the machine (artifacts included). */
  responseBytes: 32 * 1024 * 1024,
} as const;

/** The machine didn't give a usable answer. Never carries the token. */
export class MachineUnavailableError extends Error {
  /** `rejected`: it refused this device's credential (401). */
  readonly reason: "unreachable" | "rejected";

  constructor(reason: "unreachable" | "rejected", message: string) {
    super(message);
    this.name = "MachineUnavailableError";
    this.reason = reason;
  }
}

export interface MachineRequest {
  method: "GET" | "POST";
  /** Path and query, starting with `/api/`. */
  target: string;
  /** A JSON body. */
  body?: Uint8Array<ArrayBuffer>;
  /** Any content type is accepted on success (artifact bytes); errors are still JSON. */
  binary?: boolean;
}

export interface MachineAnswer {
  status: number;
  contentType: string | null;
  disposition: string | null;
  body: Uint8Array;
}

export interface MachineCallOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Calls `credential.url` + `request.target`. Throws `MachineUnavailableError` when the machine
 * can't be reached, times out, redirects, refuses the credential or the Host (401/403), answers
 * with something that isn't the daemon's JSON (a proxy's error page), or answers too much.
 * Every other status is the machine's own answer and is returned as is.
 */
export async function callMachine(
  credential: MachineCredential,
  request: MachineRequest,
  options: MachineCallOptions = {},
): Promise<MachineAnswer> {
  const url = new URL(request.target, credential.url);
  if (url.origin !== credential.url || !url.pathname.startsWith("/api/")) {
    throw new Error("Refusing to relay outside the always-on machine's API");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.token}`,
    accept: request.binary ? "*/*" : "application/json",
  };
  if (request.body) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      ...(request.body ? { body: request.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? RELAY_LIMITS.timeoutMs),
    });
  } catch (error) {
    throw new MachineUnavailableError("unreachable", describeFailure(error));
  }
  const { status } = response;
  if (status === 401) {
    await discard(response);
    throw new MachineUnavailableError("rejected", "The machine refused this device's credential");
  }
  if (status === 403 || (status >= 300 && status < 400)) {
    await discard(response);
    throw new MachineUnavailableError("unreachable", `The machine answered ${status}`);
  }
  const contentType = response.headers.get("content-type");
  const json = contentType?.toLowerCase().startsWith("application/json") === true;
  if (!json && !(request.binary && status === 200)) {
    await discard(response);
    throw new MachineUnavailableError("unreachable", `Not the daemon's answer (${status})`);
  }
  const body = await readBounded(response, options.maxBytes ?? RELAY_LIMITS.responseBytes);
  return { status, contentType, disposition: response.headers.get("content-disposition"), body };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await discard(response);
    throw new MachineUnavailableError("unreachable", "The machine's answer is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MachineUnavailableError("unreachable", "The machine's answer is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MachineUnavailableError) throw error;
    throw new MachineUnavailableError("unreachable", describeFailure(error));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** A short reason for logs: the error's name and code, never a URL or header. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : error.name;
}
