/**
 * Devices paired with this daemon and their credentials (`$DDL_HOME/devices.json`, mode 0600).
 * Tokens are 256-bit random values handed out once; only their SHA-256 hashes are kept, and a
 * candidate is compared with every stored hash in constant time. `lastSeenAt` has one-minute
 * resolution so the file is written at most once a minute per device.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createId,
  type Logger,
  normalizeDeviceName,
  type PairedDevice,
  type PairedDeviceKind,
} from "@ddl/core";
import { z } from "zod";

export const MAX_PAIRED_DEVICES = 50;
export const LAST_SEEN_RESOLUTION_MS = 60_000;
const MAX_CANDIDATE_LENGTH = 512;

/** Only browsers present their token as the cookie; apps and daemons send it as a bearer token. */
export const BEARER_DEVICE_KINDS: readonly PairedDeviceKind[] = ["app", "daemon"];
export const COOKIE_DEVICE_KINDS: readonly PairedDeviceKind[] = ["browser"];

interface StoredDevice {
  id: string;
  name: string;
  kind: PairedDeviceKind;
  tokenHash: Buffer;
  createdAt: number;
  lastSeenAt: number | null;
}

const FileSchema = z.object({
  version: z.literal(1),
  devices: z
    .array(
      z.object({
        id: z.string().regex(/^pd_[A-Za-z0-9]{8,64}$/),
        name: z.string().refine((name) => normalizeDeviceName(name) === name),
        kind: z.enum(["browser", "app", "daemon"]),
        tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
        createdAt: z.number().int().nonnegative(),
        lastSeenAt: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(MAX_PAIRED_DEVICES),
});

export class TooManyPairedDevicesError extends Error {
  constructor() {
    super(`At most ${MAX_PAIRED_DEVICES} devices can be paired: revoke one first`);
    this.name = "TooManyPairedDevicesError";
  }
}

export interface PairedDeviceStoreOptions {
  /** `$DDL_HOME/devices.json`; null keeps devices in memory only (tests). */
  path: string | null;
  logger: Logger;
  now?: () => number;
}

export class PairedDeviceStore {
  readonly #path: string | null;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #devices = new Map<string, StoredDevice>();
  readonly #revokeListeners = new Set<(id: string) => void>();
  #writes: Promise<void> = Promise.resolve();

  constructor(options: PairedDeviceStoreOptions) {
    this.#path = options.path;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** The store over `path`, loaded (a file others can read is tightened to 0600 first). */
  static async open(options: PairedDeviceStoreOptions): Promise<PairedDeviceStore> {
    const store = new PairedDeviceStore(options);
    await store.#load();
    return store;
  }

  get size(): number {
    return this.#devices.size;
  }

  get isFull(): boolean {
    return this.#devices.size >= MAX_PAIRED_DEVICES;
  }

  /** In pairing order. */
  list(): PairedDevice[] {
    return [...this.#devices.values()].map(publicDevice);
  }

  get(id: string): PairedDevice | undefined {
    const device = this.#devices.get(id);
    return device ? publicDevice(device) : undefined;
  }

  /** Pairs a new device; its token is returned here only. */
  async add(
    name: string,
    kind: PairedDeviceKind,
  ): Promise<{ device: PairedDevice; token: string }> {
    const normalized = normalizeDeviceName(name);
    if (normalized === null) throw new RangeError("Invalid device name");
    if (this.isFull) throw new TooManyPairedDevicesError();
    const token = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: createId("pd", 16),
      name: normalized,
      kind,
      tokenHash: digest(token),
      createdAt: this.#now(),
      lastSeenAt: null,
    };
    this.#devices.set(device.id, device);
    try {
      await this.#save();
    } catch (error) {
      this.#devices.delete(device.id);
      throw error;
    }
    return { device: publicDevice(device), token };
  }

  /**
   * The device a token belongs to, among `kinds`, compared in constant time with every stored hash.
   * A match counts as use (`lastSeenAt`).
   */
  authenticate(
    candidate: string | null | undefined,
    kinds: readonly PairedDeviceKind[],
  ): PairedDevice | null {
    if (typeof candidate !== "string" || candidate.length === 0) return null;
    if (candidate.length > MAX_CANDIDATE_LENGTH) return null;
    const hash = digest(candidate);
    let match: StoredDevice | undefined;
    for (const device of this.#devices.values()) {
      if (timingSafeEqual(hash, device.tokenHash)) match = device;
    }
    if (!match || !kinds.includes(match.kind)) return null;
    this.#touch(match);
    return publicDevice(match);
  }

  /** Revokes a device: its token stops working now, and listeners close its connections. */
  async revoke(id: string): Promise<boolean> {
    if (!this.#devices.delete(id)) return false;
    for (const listener of [...this.#revokeListeners]) {
      try {
        listener(id);
      } catch (error) {
        this.#logger.warn("A revocation listener failed", { error: errorMessage(error) });
      }
    }
    await this.#save();
    return true;
  }

  onRevoke(listener: (id: string) => void): () => void {
    this.#revokeListeners.add(listener);
    return () => {
      this.#revokeListeners.delete(listener);
    };
  }

  /** Resolves once every write started so far has finished. */
  async flush(): Promise<void> {
    await this.#writes.catch(() => {});
  }

  #touch(device: StoredDevice): void {
    const now = this.#now();
    if (device.lastSeenAt !== null && now - device.lastSeenAt < LAST_SEEN_RESOLUTION_MS) return;
    device.lastSeenAt = now;
    this.#save().catch((error: unknown) => {
      this.#logger.warn("Could not record when a paired device was last seen", {
        error: errorMessage(error),
      });
    });
  }

  /** Writes the current devices after any write in progress (atomically: temp file, then rename). */
  #save(): Promise<void> {
    const path = this.#path;
    if (path === null) return Promise.resolve();
    const write = this.#writes
      .catch(() => {})
      .then(async () => {
        const temp = join(
          dirname(path),
          `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
        );
        await writeFile(temp, this.#serialize(), { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      });
    this.#writes = write;
    return write;
  }

  #serialize(): string {
    const devices = [...this.#devices.values()].map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      tokenSha256: device.tokenHash.toString("hex"),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    }));
    return `${JSON.stringify({ version: 1, devices }, null, 2)}\n`;
  }

  async #load(): Promise<void> {
    const path = this.#path;
    if (path === null) return;
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return;
      throw error;
    }
    if (process.platform !== "win32" && ((await stat(path)).mode & 0o077) !== 0) {
      await chmod(path, 0o600);
      this.#logger.warn("devices.json was readable by other users; restricted it to 0600");
    }
    let parsed: z.output<typeof FileSchema> | undefined;
    try {
      parsed = FileSchema.parse(JSON.parse(source));
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      // Fail closed: every device pairs again rather than trusting a file we can't read.
      await rename(path, `${path}.invalid`);
      this.#logger.warn("devices.json is unreadable; moved it aside, so devices must pair again");
      return;
    }
    for (const entry of parsed.devices) {
      this.#devices.set(entry.id, {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        tokenHash: Buffer.from(entry.tokenSha256, "hex"),
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
      });
    }
  }
}

function publicDevice(device: StoredDevice): PairedDevice {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
