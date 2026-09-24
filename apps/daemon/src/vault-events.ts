import { isHiddenPath, type ServerEventOf, type VaultChange } from "@ddl/core";
import type { StorageEvent } from "@ddl/storage";
import type { WriteTracker } from "./write-tracker";

export type VaultChangedEvent = ServerEventOf<"vault.changed">;

interface PendingChange {
  /** Kind of the first event in the window: whether the path existed before it. */
  first: StorageEvent["kind"];
  last: StorageEvent;
}

/**
 * Coalesces storage events into `vault.changed` messages: one per (origin, clientId) per window,
 * one change per path. Hidden paths (sidecar, `.obsidian`, …) are never sent to clients.
 * Attribution runs at flush time, after the write that caused the event has been recorded.
 */
export class VaultChangeBatcher {
  private readonly pending = new Map<string, PendingChange>();
  private readonly writes: WriteTracker;
  private readonly delayMs: number;
  private readonly emit: (event: VaultChangedEvent) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    writes: WriteTracker;
    delayMs: number;
    emit: (event: VaultChangedEvent) => void;
  }) {
    this.writes = options.writes;
    this.delayMs = options.delayMs;
    this.emit = options.emit;
  }

  push(event: StorageEvent): void {
    if (isHiddenPath(event.path)) return;
    const first = this.pending.get(event.path)?.first ?? event.kind;
    this.pending.set(event.path, { first, last: event });
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const groups = new Map<string, VaultChangedEvent>();
    for (const change of this.pending.values()) {
      const event = netEvent(change);
      const { origin, clientId } = this.writes.attribute(event);
      const key = `${origin}\u0000${clientId ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { type: "vault.changed", changes: [], origin, ...(clientId ? { clientId } : {}) };
        groups.set(key, group);
      }
      group.changes.push(toChange(event));
    }
    this.pending.clear();
    for (const group of groups.values()) this.emit(group);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}

/** Net effect of a window of events on one path: created only if it did not exist before. */
function netEvent({ first, last }: PendingChange): StorageEvent {
  if (last.kind === "deleted") return last;
  return { ...last, kind: first === "created" ? "created" : "modified" };
}

function toChange(event: StorageEvent): VaultChange {
  return event.version === undefined
    ? { path: event.path, kind: event.kind }
    : { path: event.path, kind: event.kind, version: event.version };
}
