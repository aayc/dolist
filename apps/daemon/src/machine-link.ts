/**
 * The always-on machine, from this device's side: pairing with it (`POST /api/machine/pair`),
 * checking it (`POST /api/machine/check`, and in the background while a client keeps asking for
 * `GET /api/machine`), and forgetting it (`DELETE /api/machine/pairing`).
 *
 * The machine's name and address are synced settings (`remote.alwaysOnMachine`); this device's
 * credential for it stays in `$DDL_HOME/machine-token` (0600) as `{ url, deviceId, token }`, and
 * counts only while `url` is the vault's always-on machine, so the token is never sent anywhere
 * else. Outbound calls go to https only (plain http only to loopback, for tests), time out after
 * 5 s, don't follow redirects, and carry the token only in the Authorization header. Neither the
 * token nor the machine's answers are logged.
 */
import {
  AgentReadinessSchema,
  AgentRunsOnSchema,
  HealthResponseSchema,
  PairResponseSchema,
} from "@ddl/contract";
import {
  type AgentReadiness,
  type AgentRunsOn,
  type AlwaysOnMachine,
  API_ROUTES,
  type AppSettings,
  type DeepPartial,
  defaultMachineName,
  errorMessage,
  Listeners,
  type Logger,
  type MachinePairRequest,
  type MachineStatusResponse,
  normalizeMachineUrl,
  normalizePairingCode,
  type PairRequest,
  type Unsubscribe,
} from "@ddl/core";
import { z } from "zod";
import type { MachineCredential, MachineCredentialSource } from "./agent-location";
import { ApiError } from "./errors";
import type { SecretFile } from "./home-files";

/** This device's credential for the always-on machine, in `$DDL_HOME` (mode 0600). */
export const MACHINE_TOKEN_FILE = "machine-token";
const REQUEST_TIMEOUT_MS = 5_000;
/** A `GET /api/machine` checks the machine again in the background when the last check is older. */
const CHECK_AFTER_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const StoredCredentialSchema = z.object({
  url: z.string().refine((url) => normalizeMachineUrl(url) === url),
  deviceId: z.string().min(1).max(200),
  token: z.string().min(16).max(512),
});

type StoredCredential = z.output<typeof StoredCredentialSchema>;

export interface MachineLinkOptions {
  settings: {
    get(): AppSettings;
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
    onChange(listener: (settings: AppSettings) => void): Unsubscribe;
  };
  /** `$DDL_HOME/machine-token`. */
  credentialFile: SecretFile;
  /** What this device is called on the machine's list of paired devices. */
  deviceName: () => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  logger: Logger;
}

interface LastCheck {
  url: string;
  reachable: boolean;
  checkedAt: number;
  version?: string;
  agent?: { runsOn: AgentRunsOn | null; problem?: string };
  readiness?: AgentReadiness;
  error?: string;
}

class MachineUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineUnreachableError";
  }
}

export class MachineLink implements MachineCredentialSource {
  readonly #options: MachineLinkOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #listeners = new Listeners<MachineCredential | null>((error) =>
    this.#options.logger.error("Machine credential listener failed", {
      error: errorMessage(error),
    }),
  );
  readonly #unsubscribe: Unsubscribe;
  #stored: StoredCredential | null;
  #last: LastCheck | null = null;
  #checking: Promise<void> | undefined;
  #credentialKey: string;

  /** Loads the saved credential (an unreadable file counts as none). */
  static async load(options: MachineLinkOptions): Promise<MachineLink> {
    let stored: StoredCredential | null = null;
    const raw = await options.credentialFile.read();
    if (raw !== null) {
      try {
        stored = StoredCredentialSchema.parse(JSON.parse(raw));
      } catch {
        options.logger.warn("machine-token is unreadable; pair with the always-on machine again");
      }
    }
    return new MachineLink(options, stored);
  }

  constructor(options: MachineLinkOptions, stored: StoredCredential | null = null) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#stored = stored;
    this.#credentialKey = this.#key();
    this.#unsubscribe = options.settings.onChange(() => this.#credentialChanged());
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  current(): MachineCredential | null {
    const machine = this.#machine();
    const stored = this.#stored;
    return machine && stored && stored.url === machine.url
      ? { url: stored.url, token: stored.token }
      : null;
  }

  onChange(listener: (credential: MachineCredential | null) => void): Unsubscribe {
    return this.#listeners.add(listener);
  }

  /** The last known status; a stale one is refreshed in the background for the next read. */
  status(): MachineStatusResponse {
    const machine = this.#machine();
    if (
      machine &&
      (!this.#fresh(machine) || this.#now() - this.#last!.checkedAt >= CHECK_AFTER_MS)
    ) {
      void this.#checkOnce();
    }
    return this.#response();
  }

  /** Checks the machine now: reachability, version, where its agent runs, its readiness. */
  async check(): Promise<MachineStatusResponse> {
    await this.#checkOnce();
    return this.#response();
  }

  /**
   * Pairs with the machine at `request.url` using a code it issued, keeps the credential, and
   * makes the machine the vault's always-on machine.
   */
  async pair(request: MachinePairRequest): Promise<MachineStatusResponse> {
    const url = normalizeMachineUrl(request.url);
    const code = normalizePairingCode(request.code);
    if (!url || !code) throw new ApiError(400, "invalid_request", "Invalid machine URL or code");
    const name = request.name ?? defaultMachineName(url);
    const body: PairRequest = { code, name: this.#options.deviceName(), kind: "daemon" };
    let answer: { status: number; body: unknown };
    try {
      answer = await this.#call(url, "POST", API_ROUTES.pair, { body });
    } catch (error) {
      throw new ApiError(
        502,
        "machine_unreachable",
        `Couldn't reach ${name}: ${errorMessage(error)}`,
      );
    }
    if (answer.status !== 201) throw pairingError(answer, name);
    const paired = PairResponseSchema.safeParse(answer.body);
    if (!paired.success || !paired.data.token) {
      throw new ApiError(
        502,
        "machine_unreachable",
        `${name} answered the pairing in a way this daemon doesn't understand; update both daemons`,
      );
    }
    const stored: StoredCredential = {
      url,
      deviceId: paired.data.device.id,
      token: paired.data.token,
    };
    await this.#options.credentialFile.write(JSON.stringify(stored));
    this.#stored = stored;
    this.#last = null;
    this.#options.logger.info("Paired with the always-on machine", { host: new URL(url).host });
    await this.#options.settings.update({ remote: { alwaysOnMachine: { name, url } } });
    this.#credentialChanged();
    return this.check();
  }

  /** Drops this device's credential, after revoking it on the machine if it answers. */
  async unpair(): Promise<MachineStatusResponse> {
    const stored = this.#stored;
    if (stored) {
      try {
        const answer = await this.#call(
          stored.url,
          "DELETE",
          API_ROUTES.pairedDevice(stored.deviceId),
          { token: stored.token },
        );
        if (answer.status !== 204 && answer.status !== 404) {
          this.#options.logger.warn("The always-on machine didn't revoke this device", {
            status: answer.status,
          });
        }
      } catch (error) {
        this.#options.logger.warn("Couldn't reach the always-on machine to revoke this device", {
          error: errorMessage(error),
        });
      }
    }
    await this.#options.credentialFile.remove();
    this.#stored = null;
    this.#last = null;
    this.#credentialChanged();
    return this.#response();
  }

  #machine(): AlwaysOnMachine | null {
    return this.#options.settings.get().remote.alwaysOnMachine;
  }

  #fresh(machine: AlwaysOnMachine): boolean {
    return this.#last !== null && this.#last.url === machine.url;
  }

  #response(): MachineStatusResponse {
    const machine = this.#machine();
    const paired = this.current() !== null;
    const last = machine && this.#fresh(machine) ? this.#last : null;
    return {
      machine,
      paired,
      reachable: last?.reachable ?? null,
      checkedAt: last?.checkedAt ?? null,
      ...(last?.version ? { version: last.version } : {}),
      ...(last?.agent ? { agent: last.agent } : {}),
      ...(last?.readiness ? { readiness: last.readiness } : {}),
      ...(last?.error ? { error: last.error } : {}),
    };
  }

  #checkOnce(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  async #check(): Promise<void> {
    const machine = this.#machine();
    if (!machine) {
      this.#last = null;
      return;
    }
    const credential = this.current();
    const token = credential?.token;
    const last: LastCheck = { url: machine.url, reachable: false, checkedAt: this.#now() };
    try {
      const health = await this.#call(machine.url, "GET", API_ROUTES.health, { token });
      last.reachable = true;
      if (health.status === 200) {
        const parsed = HealthResponseSchema.safeParse(health.body);
        if (parsed.success && parsed.data.version.length <= 100) last.version = parsed.data.version;
        if (token) await this.#readAgent(machine.url, token, last);
      } else if (health.status === 401) {
        if (token)
          last.error = `${machine.name} no longer accepts this device's credential: pair again.`;
      } else if (health.status === 403) {
        last.error = `${machine.name} doesn't answer to ${new URL(machine.url).host}: add it to its remote hosts.`;
      } else {
        last.error = `${machine.name} answered ${health.status}.`;
      }
    } catch (error) {
      last.error = `Couldn't reach ${machine.name}: ${errorMessage(error)}`;
    }
    // The machine or the credential changed meanwhile: that check is about something else.
    if (this.#machine()?.url === machine.url) this.#last = last;
  }

  async #readAgent(url: string, token: string, last: LastCheck): Promise<void> {
    const answer = await this.#call(url, "GET", API_ROUTES.agentStatus, { token });
    if (answer.status !== 200 || typeof answer.body !== "object" || answer.body === null) return;
    const status = answer.body as { problem?: unknown; placement?: { runsOn?: unknown } };
    const runsOn = AgentRunsOnSchema.nullable().safeParse(status.placement?.runsOn ?? null);
    const problem = typeof status.problem === "string" ? status.problem.slice(0, 500) : undefined;
    last.agent = {
      runsOn: runsOn.success ? runsOn.data : null,
      ...(problem ? { problem } : {}),
    };
    const readiness = AgentReadinessSchema.safeParse(
      (answer.body as { readiness?: unknown }).readiness,
    );
    if (readiness.success) last.readiness = readiness.data;
  }

  /** One request to the machine. Throws MachineUnreachableError when it doesn't answer (in JSON). */
  async #call(
    url: string,
    method: string,
    path: string,
    init: { token?: string | undefined; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    if (normalizeMachineUrl(url) !== url) throw new MachineUnreachableError("invalid address");
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${url}${path}`, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      text = await response.text();
    } catch (error) {
      throw new MachineUnreachableError(describeFailure(error));
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new MachineUnreachableError("answer too large");
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new MachineUnreachableError(`answered ${response.status} without JSON`);
      }
    }
    return { status: response.status, body };
  }

  #key(): string {
    const credential = this.current();
    return credential ? `${credential.url}\u0000${credential.token}` : "";
  }

  #credentialChanged(): void {
    const key = this.#key();
    if (key === this.#credentialKey) return;
    this.#credentialKey = key;
    const credential = this.current();
    this.#listeners.emit(credential);
  }
}

function pairingError(answer: { status: number; body: unknown }, name: string): ApiError {
  const message =
    typeof answer.body === "object" && answer.body !== null && "message" in answer.body
      ? String((answer.body as { message: unknown }).message).slice(0, 300)
      : undefined;
  switch (answer.status) {
    case 401:
      return new ApiError(
        401,
        "pairing_rejected",
        `${name} rejected the pairing code: it may be wrong, expired or already used`,
      );
    case 429:
      return new ApiError(429, "rate_limited", `${name} refused more pairing attempts for now`);
    case 400:
      return new ApiError(
        400,
        "invalid_request",
        `${name} refused the request${message ? `: ${message}` : ""}`,
      );
    case 403:
      return new ApiError(
        502,
        "machine_unreachable",
        `${name} doesn't answer to this address: add it to its remote hosts`,
      );
    case 404:
      return new ApiError(
        502,
        "machine_unreachable",
        `${name} doesn't offer pairing: update its daemon`,
      );
    default:
      return new ApiError(502, "machine_unreachable", `${name} answered ${answer.status}`);
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timed out";
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}
