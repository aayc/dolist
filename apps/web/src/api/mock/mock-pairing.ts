import {
  createId,
  normalizeDeviceName,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  type PairedDevice,
  type PairingCodeResponse,
  type PairRequest,
  type PairResponse,
} from "@ddl/core";
import { readJson, readString, STORAGE_KEYS, writeJson, writeString } from "../../lib/storage";
import { HttpError } from "../errors";
import type { PairBrowser } from "../pairing";

/** The daemon's limits: codes live 5 minutes, at most 3 wait at once, 5 attempts a minute. */
export const MOCK_PAIRING_LIMITS = {
  codeTtlMs: 5 * 60_000,
  maxOutstanding: 3,
  attemptsPerMinute: 5,
} as const;

interface Stored {
  codes: Array<{ code: string; expiresAt: number; name?: string }>;
  devices: PairedDevice[];
}

function failure(status: number, error: string, message: string): HttpError {
  return new HttpError(status, message, { error, message });
}

function randomCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join("");
}

const HOUR_MS = 60 * 60_000;

function seedDevices(now: number): PairedDevice[] {
  return [
    {
      id: "pdv_seed_ipad",
      name: "Safari on iPad",
      kind: "browser",
      createdAt: now - 72 * HOUR_MS,
      lastSeenAt: now - 2 * HOUR_MS,
    },
  ];
}

/**
 * The daemon's pairing codes and paired devices, in the browser. Kept in localStorage when
 * persisting, and read afresh on every call, so a code issued on one page pairs another page of
 * the same browser (the pairing screen's e2e test does exactly that).
 */
export class MockPairing {
  private readonly persist: boolean;
  private memory: Stored;
  private readonly attempts: number[] = [];

  constructor(options: { persist: boolean; now?: number }) {
    this.persist = options.persist;
    this.memory = { codes: [], devices: seedDevices(options.now ?? Date.now()) };
    if (this.persist && !readJson<Stored>(STORAGE_KEYS.mockPairing)) this.save(this.memory);
  }

  private load(): Stored {
    const stored = this.persist ? readJson<Stored>(STORAGE_KEYS.mockPairing) : null;
    const state = stored ?? this.memory;
    const now = Date.now();
    return { ...state, codes: state.codes.filter((c) => c.expiresAt > now) };
  }

  private save(state: Stored): void {
    this.memory = state;
    if (this.persist) writeJson(STORAGE_KEYS.mockPairing, state);
  }

  issue(name?: string): Omit<PairingCodeResponse, "url"> {
    const state = this.load();
    if (state.codes.length >= MOCK_PAIRING_LIMITS.maxOutstanding) {
      throw failure(
        429,
        "rate_limited",
        `${MOCK_PAIRING_LIMITS.maxOutstanding} pairing codes are already waiting: use one, or wait until they expire`,
      );
    }
    const code = randomCode();
    const expiresAt = Date.now() + MOCK_PAIRING_LIMITS.codeTtlMs;
    this.save({
      ...state,
      codes: [...state.codes, { code, expiresAt, ...(name ? { name } : {}) }],
    });
    return { code, expiresAt };
  }

  pair(request: PairRequest): PairResponse {
    const now = Date.now();
    while (this.attempts.length > 0 && now - this.attempts[0]! > 60_000) this.attempts.shift();
    if (this.attempts.length >= MOCK_PAIRING_LIMITS.attemptsPerMinute) {
      const message = "Too many pairing attempts: try again in a minute";
      const retryAfter = Math.max(1, Math.ceil((this.attempts[0]! + 60_000 - now) / 1000));
      throw new HttpError(429, message, { error: "rate_limited", message }, retryAfter);
    }
    this.attempts.push(now);
    const name = normalizeDeviceName(request.name);
    const code = normalizePairingCode(request.code);
    if (!name || !code) {
      const message = !name
        ? "name must be 1-64 characters"
        : "code must be the 8-character pairing code (XXXX-XXXX)";
      throw failure(400, "invalid_request", message);
    }
    const state = this.load();
    const issued = state.codes.find((c) => c.code === code);
    if (!issued) {
      throw failure(401, "pairing_rejected", "Wrong, expired or already used pairing code");
    }
    const device: PairedDevice = {
      id: createId("pdv"),
      name: issued.name ?? name,
      kind: request.kind,
      createdAt: now,
      lastSeenAt: now,
    };
    this.save({
      codes: state.codes.filter((c) => c !== issued),
      devices: [...state.devices, device],
    });
    return { device };
  }

  list(): PairedDevice[] {
    return this.load().devices;
  }

  has(id: string): boolean {
    return this.load().devices.some((device) => device.id === id);
  }

  revoke(id: string): boolean {
    const state = this.load();
    const devices = state.devices.filter((device) => device.id !== id);
    if (devices.length === state.devices.length) return false;
    this.save({ ...state, devices });
    return true;
  }
}

/** The paired device this browser is, standing in for the daemon's HttpOnly cookie. */
export function mockDeviceCookie(): string | null {
  return readString(STORAGE_KEYS.mockDeviceCookie);
}

/** The mock's `POST /api/pair` as a browser: it "sets the cookie" the next page load reads. */
export function mockBrowserPairing(pairing: MockPairing, latencyMs = 150): PairBrowser {
  return ({ code, name }) =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const response = pairing.pair({ code, name, kind: "browser" });
          writeString(STORAGE_KEYS.mockDeviceCookie, response.device.id);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      }, latencyMs);
    });
}
