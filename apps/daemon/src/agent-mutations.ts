import { createHash, randomUUID } from "node:crypto";
import {
  decodePersistedMutationJournal,
  decodePersistedWorkspace,
  PERSISTED_PATHS,
  type PersistedMutationEvent,
} from "@ddl/contract";
import type { AgentOperationResponse, Logger } from "@ddl/core";
import { ConflictError, mergeJournals, type StorageProvider } from "@ddl/storage";
import { ApiError } from "./errors";

type Prepared = Extract<PersistedMutationEvent, { type: "mutation.prepared" }>;
type Completed = Extract<PersistedMutationEvent, { type: "mutation.completed" }>;

/** Captured authority for one exchange. Remote storage writes already enforce its lease epoch. */
export interface MutationAuthority {
  storage: StorageProvider;
  /** Null: reading receipts is permitted, dispatching a new command is not. */
  epoch: number | null;
  isCurrent(): boolean;
}

export interface AgentMutationOptions {
  local: StorageProvider;
  authority(): MutationAuthority;
  logger: Logger;
  now?: () => number;
}

/**
 * A write-ahead dispatch ledger, not an execution queue. A preparation is authoritative before
 * dispatch. Only the live promise that wrote it may complete it; another process never replays
 * one, even when the original process disappeared before it actually called the runtime.
 */
export class AgentMutations {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, { hash: string; result: Promise<Response> }>();
  private readonly options: AgentMutationOptions;

  constructor(options: AgentMutationOptions) {
    this.options = options;
  }

  async perform(
    workspaceId: string,
    operationId: string,
    path: string,
    body: unknown,
    dispatch: () => Promise<Response>,
  ): Promise<Response> {
    const key = this.path(workspaceId, operationId);
    const hash = digest(canonical({ method: "POST", path, body }));
    const running = this.active.get(key);
    if (running) {
      if (running.hash !== hash) throw conflict();
      return (await running.result).clone();
    }
    const result = this.run(key, workspaceId, operationId, path, hash, dispatch);
    this.active.set(key, { hash, result });
    try {
      return (await result).clone();
    } finally {
      this.active.delete(key);
    }
  }

  async lookup(workspaceId: string, operationId: string): Promise<AgentOperationResponse> {
    const path = this.path(workspaceId, operationId);
    const authority = this.options.authority();
    await this.verifyWorkspace(authority, workspaceId);
    const read = await authority.storage.read(path);
    if (!read) throw new ApiError(404, "not_found", "No receipt for this operation");
    const [prepared, completed] = this.decode(read.content);
    if (prepared.workspaceId !== workspaceId || prepared.operationId !== operationId) {
      throw new Error("Mutation journal belongs to another operation");
    }
    const base = { workspaceId, operationId };
    if (completed) {
      return {
        ...base,
        outcome: "applied",
        response: { status: completed.status, body: JSON.parse(completed.body) },
      };
    }
    return {
      ...base,
      outcome: prepared.owner === this.owner && this.active.has(path) ? "pending" : "indeterminate",
    };
  }

  private async run(
    key: string,
    workspaceId: string,
    operationId: string,
    path: string,
    requestHash: string,
    dispatch: () => Promise<Response>,
  ): Promise<Response> {
    const authority = this.options.authority();
    await this.verifyWorkspace(authority, workspaceId);
    const read = await authority.storage.read(key);
    if (read) return this.replay(read.content, workspaceId, operationId, path, requestHash);
    if (authority.epoch === null || !authority.isCurrent()) throw unavailable();
    const prepared: Prepared = {
      v: 1,
      id: randomUUID(),
      epoch: authority.epoch,
      seq: 1,
      at: this.now(),
      type: "mutation.prepared",
      operationId,
      workspaceId,
      path,
      method: "POST",
      requestHash,
      owner: this.owner,
    };
    const content = `${JSON.stringify(prepared)}\n`;
    let version: string;
    try {
      version = (await authority.storage.write(key, content, { ifMatch: null })).version;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const winner = await authority.storage.read(key);
      if (!winner) throw error;
      return this.replay(winner.content, workspaceId, operationId, path, requestHash);
    }
    // A lost response to this write never reaches dispatch. Its preparation still prevents a
    // later host from treating the request as new. An async sync push is not this barrier.
    await this.mirror(authority.storage, key, content);
    if (!authority.isCurrent()) throw indeterminate();
    let response: Response;
    let completed: Completed;
    try {
      response = await dispatch();
      completed = {
        v: 1,
        id: randomUUID(),
        epoch: prepared.epoch,
        seq: 2,
        at: this.now(),
        type: "mutation.completed",
        preparedId: prepared.id,
        status: response.status,
        body: await response.clone().text(),
      };
      // Only JSON exchanges are in this ledger. Validate our own bytes before acknowledging.
      this.decode(`${content}${JSON.stringify(completed)}\n`);
      if (!authority.isCurrent()) throw indeterminate();
      await authority.storage.write(key, `${content}${JSON.stringify(completed)}\n`, {
        ifMatch: version,
      });
    } catch {
      // The runtime may already have acted. Never claim a failed dispatch or attempt it again.
      throw indeterminate();
    }
    await this.mirror(authority.storage, key, `${content}${JSON.stringify(completed)}\n`);
    return this.response(completed);
  }

  private replay(
    content: string,
    workspaceId: string,
    operationId: string,
    path: string,
    hash: string,
  ): Response {
    const [prepared, completed] = this.decode(content);
    if (
      prepared.workspaceId !== workspaceId ||
      prepared.operationId !== operationId ||
      prepared.path !== path ||
      prepared.requestHash !== hash
    )
      throw conflict();
    if (!completed) throw indeterminate();
    return this.response(completed);
  }

  private decode(content: string): [Prepared, Completed | undefined] {
    const [prepared, completed] = decodePersistedMutationJournal(content);
    return [prepared as Prepared, completed as Completed | undefined];
  }

  private response(completed: Completed): Response {
    return new Response(completed.body, {
      status: completed.status,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  }

  private async verifyWorkspace(authority: MutationAuthority, workspaceId: string): Promise<void> {
    if (authority.storage === this.options.local) return;
    const file = await authority.storage.read(PERSISTED_PATHS.workspace);
    const decoded = file ? decodePersistedWorkspace(file.content) : null;
    if (!decoded?.ok) throw unavailable();
    if (decoded.value.workspaceId !== workspaceId) {
      throw new ApiError(
        412,
        "workspace_mismatch",
        "The authoritative receipt store belongs to a different workspace",
      );
    }
  }

  /** The sync target is authoritative; its local replica is only for sync/read-only views. */
  private async mirror(authority: StorageProvider, path: string, content: string): Promise<void> {
    if (authority === this.options.local) return;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const local = await this.options.local.read(path);
        const merged = local ? mergeJournals(local.content, content) : content;
        if (local?.content === merged) return;
        try {
          await this.options.local.write(path, merged, { ifMatch: local?.version ?? null });
          return;
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
      }
    } catch {
      this.options.logger.warn("The authoritative mutation receipt could not be mirrored locally");
    }
  }

  private path(workspaceId: string, operationId: string): string {
    return `${PERSISTED_PATHS.mutationJournals}/${digest(`${workspaceId}\n${operationId}`)}.jsonl`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function conflict(): ApiError {
  return new ApiError(409, "operation_conflict", "The operation ID belongs to a different command");
}
function indeterminate(): ApiError {
  return new ApiError(
    409,
    "operation_indeterminate",
    "This command may have been dispatched. Inspect its receipt and current state; it will not be dispatched again automatically.",
  );
}
function unavailable(): ApiError {
  return new ApiError(
    503,
    "agent_unavailable",
    "Only the current agent authority may dispatch a new operation",
  );
}
