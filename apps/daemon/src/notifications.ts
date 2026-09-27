import { createHash } from "node:crypto";
import {
  decodePersistedWorkspace,
  PERSISTED_PATHS,
  type PersistedNotificationEvent,
  PersistedNotificationEventSchema,
} from "@ddl/contract";
import type { AgentNotificationsResponse, Logger, RoutineNotification } from "@ddl/core";
import { ConflictError, type StorageProvider } from "@ddl/storage";
import type { MutationAuthority } from "./agent-mutations";
import { ApiError } from "./errors";

const KEY = /^([0-9]{16})-([0-9]{16})-([a-f0-9]{64})$/;

/**
 * Immutable decision files avoid an ever-growing sync file. A lease epoch orders hosts and a
 * sequence orders decisions within one grant. Every write is awaited before the scheduler may
 * mark a run notified or emit a live notification; suppressed decisions advance cursors too.
 */
export class NotificationJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: {
    local: StorageProvider;
    authority(): MutationAuthority;
    logger: Logger;
  };

  constructor(options: { local: StorageProvider; authority(): MutationAuthority; logger: Logger }) {
    this.options = options;
  }

  record(
    workspaceId: string,
    runId: string,
    notification: RoutineNotification | null,
  ): Promise<RoutineNotification | null> {
    const next = this.queue.then(() => this.append(workspaceId, runId, notification));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async page(
    workspaceId: string,
    cursor?: string,
    limit = 100,
  ): Promise<AgentNotificationsResponse> {
    const authority = this.options.authority();
    await this.verifyWorkspace(authority, workspaceId);
    const keys = await this.keys(authority.storage, workspaceId);
    if (cursor === undefined)
      return {
        notifications: [],
        cursor: this.cursor(workspaceId, keys.at(-1) ?? ""),
        hasMore: false,
      };
    const after = this.readCursor(cursor, workspaceId);
    const remaining = keys.filter((key) => key > after);
    const selected = remaining.slice(0, limit);
    const notifications: RoutineNotification[] = [];
    for (const key of selected) {
      const event = await this.read(authority.storage, workspaceId, key);
      if (event.notification) notifications.push(event.notification);
    }
    return {
      notifications,
      cursor: this.cursor(workspaceId, selected.at(-1) ?? after),
      hasMore: remaining.length > selected.length,
    };
  }

  private async append(
    workspaceId: string,
    runId: string,
    notification: RoutineNotification | null,
  ): Promise<RoutineNotification | null> {
    const authority = this.options.authority();
    await this.verifyWorkspace(authority, workspaceId);
    const id = hash(runId);
    const keys = await this.keys(authority.storage, workspaceId);
    const existing = keys.find((key) => key.endsWith(`-${id}`));
    if (existing) {
      const event = await this.read(authority.storage, workspaceId, existing);
      if (event.runId !== runId) throw new Error("Notification ID collision");
      return null; // Already durable: catch-up owns missed delivery, not another live alert.
    }
    if (authority.epoch === null || !authority.isCurrent()) throw unavailable();
    const epoch = authority.epoch;
    const latest = keys.at(-1);
    const match = latest ? KEY.exec(latest) : null;
    if (match && Number(match[1]) > epoch) throw unavailable();
    const seq = match && Number(match[1]) === epoch ? Number(match[2]) + 1 : 1;
    if (!Number.isSafeInteger(seq)) throw new Error("Notification sequence exhausted");
    const key = `${String(epoch).padStart(16, "0")}-${String(seq).padStart(16, "0")}-${id}`;
    const event: PersistedNotificationEvent = {
      v: 1,
      type: "routine.notification.decided",
      id,
      epoch,
      seq,
      at: notification?.at ?? Date.now(),
      workspaceId,
      runId,
      notification: notification ? { ...notification, id } : null,
    };
    const text = `${JSON.stringify(PersistedNotificationEventSchema.parse(event))}\n`;
    const path = `${this.folder(workspaceId)}/${key}.jsonl`;
    await authority.storage.write(path, text, { ifMatch: null });
    if (authority.storage !== this.options.local) {
      try {
        await this.options.local.write(path, text, { ifMatch: null });
      } catch (error) {
        if (!(error instanceof ConflictError))
          this.options.logger.warn("Could not mirror the authoritative notification decision");
      }
    }
    return event.notification;
  }

  private async read(
    storage: StorageProvider,
    workspaceId: string,
    key: string,
  ): Promise<PersistedNotificationEvent> {
    const file = await storage.read(`${this.folder(workspaceId)}/${key}.jsonl`);
    if (!file) throw new Error("Notification decision disappeared");
    let value: unknown;
    try {
      value = JSON.parse(file.content);
    } catch {
      throw new Error("Invalid notification journal JSON");
    }
    const parsed = PersistedNotificationEventSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid or newer notification decision");
    const event = parsed.data;
    const expected = `${String(event.epoch).padStart(16, "0")}-${String(event.seq).padStart(16, "0")}-${event.id}`;
    if (
      event.workspaceId !== workspaceId ||
      key !== expected ||
      event.id !== hash(event.runId) ||
      (event.notification && event.notification.id !== event.id)
    ) {
      throw new Error("Notification decision identity mismatch");
    }
    return event;
  }

  private async keys(storage: StorageProvider, workspaceId: string): Promise<string[]> {
    const prefix = this.folder(workspaceId);
    const entries = await storage.list({ prefix, includeHidden: true });
    return entries
      .map(({ path }) => {
        const key = path.slice(prefix.length + 1, -".jsonl".length);
        if (!path.endsWith(".jsonl") || !KEY.test(key))
          throw new Error("Unrecognized notification journal file");
        return key;
      })
      .sort();
  }

  private async verifyWorkspace(authority: MutationAuthority, workspaceId: string): Promise<void> {
    if (authority.storage === this.options.local) return;
    const file = await authority.storage.read(PERSISTED_PATHS.workspace);
    const decoded = file ? decodePersistedWorkspace(file.content) : null;
    if (!decoded?.ok) throw unavailable();
    if (decoded.value.workspaceId !== workspaceId)
      throw new ApiError(
        412,
        "workspace_mismatch",
        "The notification authority belongs to another workspace",
      );
  }

  private folder(workspaceId: string): string {
    return `${PERSISTED_PATHS.notificationJournals}/${hash(workspaceId)}`;
  }
  private cursor(workspaceId: string, key: string): string {
    return Buffer.from(JSON.stringify({ v: 1, workspaceId, key })).toString("base64url");
  }
  private readCursor(cursor: string, workspaceId: string): string {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (value === null || typeof value !== "object") throw new Error();
      const data = value as Record<string, unknown>;
      if (
        data.v !== 1 ||
        data.workspaceId !== workspaceId ||
        typeof data.key !== "string" ||
        (data.key !== "" && !KEY.test(data.key))
      )
        throw new Error();
      return data.key;
    } catch {
      throw new ApiError(400, "invalid_request", "Invalid notification cursor for this workspace");
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unavailable(): ApiError {
  return new ApiError(503, "agent_unavailable", "The notification authority is unavailable");
}
