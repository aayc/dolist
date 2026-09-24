import { isSidecarPath, type VaultChangeOrigin } from "@ddl/core";
import type { StorageEvent } from "@ddl/storage";

export type WriteSource =
  | { origin: "client"; clientId?: string }
  | { origin: "agent" }
  | { origin: "sync" };

export interface ChangeAttribution {
  origin: VaultChangeOrigin;
  clientId?: string;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 2_000;

/**
 * Remembers which writer produced a given (path, version) through the daemon. Storage events only
 * say `self: true`, so this is how a `vault.changed` event is attributed to the client that saved
 * it (which then ignores its own echo), the agent runtime, or the sync engine. Versions are
 * content hashes, so a later identical write attributes to the same writer, which is harmless.
 */
export class WriteTracker {
  private readonly entries = new Map<string, { source: WriteSource; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** `version` is undefined for deletions. */
  record(path: string, version: string | undefined, source: WriteSource): void {
    const key = entryKey(path, version);
    this.entries.delete(key);
    this.entries.set(key, { source, expiresAt: this.now() + this.ttlMs });
    this.prune();
  }

  attribute(event: Pick<StorageEvent, "path" | "version" | "self">): ChangeAttribution {
    const entry = this.entries.get(entryKey(event.path, event.version));
    if (entry && entry.expiresAt > this.now()) {
      const { source } = entry;
      if (source.origin === "client" && source.clientId) {
        return { origin: "client", clientId: source.clientId };
      }
      return { origin: source.origin };
    }
    // Untracked in-process writes come from the agent runtime; everything else is another app.
    if (isSidecarPath(event.path) || event.self) return { origin: "agent" };
    return { origin: "external" };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && entry.expiresAt > now) break;
      this.entries.delete(key);
    }
  }
}

function entryKey(path: string, version: string | undefined): string {
  return `${path}\u0000${version ?? ""}`;
}
