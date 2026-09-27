import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { decodePersistedWorkspace, PERSISTED_PATHS } from "@ddl/contract";
import { API_PATHS, WORKSPACE_ID_HEADER } from "@ddl/core";
import { ConflictError, type StorageProvider } from "@ddl/storage";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors";
import type { VaultSwitch } from "./vault-switch";

export const MOBILE_CAPABILITIES = ["workspace-identity-v1", "daily-append-v1"] as const;

/** Serializes verified exchanges with sync-target adoption; no old context can cross adoption. */
export class WorkspaceIdentity {
  readonly hostId: string;
  readonly #storage: StorageProvider;
  #adoption: Promise<void> = Promise.resolve();
  #active = new Set<Promise<void>>();
  #exchange = new AsyncLocalStorage<{ active: boolean }>();
  #seen = false;
  #invalidated = false;

  invalidate(): void {
    this.#invalidated = true;
  }

  constructor(storage: StorageProvider, hostId: string) {
    this.#storage = storage;
    this.hostId = hostId;
  }

  async current(): Promise<string> {
    const file = await this.#storage.read(PERSISTED_PATHS.workspace);
    if (file) {
      this.#seen = true;
      const parsed = decodePersistedWorkspace(file.content);
      if (!parsed.ok)
        throw new Error(`Workspace identity is ${parsed.kind}; refusing to replace it`);
      return parsed.value.workspaceId;
    }
    if (this.#seen) throw new Error("Workspace identity was removed; refusing to recreate it");
    const content = JSON.stringify({ version: 1, workspaceId: randomUUID() });
    try {
      await this.#storage.write(PERSISTED_PATHS.workspace, content, { ifMatch: null });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
    return this.current();
  }

  /** The target wins first-join races; identity never goes through ordinary text merging. */
  async adoptFrom(target: StorageProvider): Promise<void> {
    await this.adopting(async () => {
      const own = await this.current();
      let remote = await target.read(PERSISTED_PATHS.workspace);
      if (!remote) {
        try {
          await target.write(
            PERSISTED_PATHS.workspace,
            JSON.stringify({ version: 1, workspaceId: own }),
            { ifMatch: null },
          );
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
        remote = await target.read(PERSISTED_PATHS.workspace);
      }
      if (!remote) throw new Error("Sync target has no workspace identity");
      const decoded = decodePersistedWorkspace(remote.content);
      if (!decoded.ok) throw new Error(`Sync target workspace identity is ${decoded.kind}`);
      const identity = decoded.value;
      if (identity.workspaceId === own) return;
      const current = await this.#storage.read(PERSISTED_PATHS.workspace);
      if (!current) throw new Error("Workspace identity disappeared during adoption");
      await this.#storage.write(PERSISTED_PATHS.workspace, JSON.stringify(identity), {
        ifMatch: current.version,
      });
    });
  }

  private async adopting(action: () => Promise<void>): Promise<void> {
    // A guarded agent-placement request can ask sync to run. Defer adoption to the next
    // background pass rather than waiting for that request to wait for itself.
    if (this.#exchange.getStore()?.active)
      throw new Error("Workspace adoption awaits the current request; sync will retry");
    const previous = this.#adoption;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#adoption = previous.then(() => barrier);
    await previous;
    await Promise.all(this.#active);
    try {
      await action();
    } finally {
      release();
    }
  }

  private async verified(action: () => Promise<void>): Promise<void> {
    // Admit reads/writes concurrently; adoption alone waits for the active exchanges to drain.
    for (;;) {
      const barrier = this.#adoption;
      await barrier;
      if (barrier !== this.#adoption) continue;
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.#active.add(done);
      const exchange = { active: true };
      try {
        await this.#exchange.run(exchange, action);
      } finally {
        exchange.active = false;
        this.#active.delete(done);
        release();
      }
      return;
    }
  }

  async verifyAndRun(expected: string, action: () => Promise<void>): Promise<void> {
    await this.verified(async () => {
      if (this.#invalidated || expected !== (await this.current()))
        throw new ApiError(
          412,
          "workspace_mismatch",
          "The workspace changed. Reconnect before continuing.",
        );
      await action();
    });
  }

  guard(vault: VaultSwitch): MiddlewareHandler {
    return async (c, next) => {
      const expected = c.req.header(WORKSPACE_ID_HEADER);
      if (expected === undefined) return next(); // Additive: existing web/Mac clients still work.
      const run = async () => {
        if (vault.restarting || expected !== (await this.current())) {
          throw new ApiError(
            412,
            "workspace_mismatch",
            "The workspace changed. Reconnect before continuing.",
          );
        }
        await next();
      };
      // Sync setup adopts a target itself. It checks the old context, then owns that transition.
      // Every other verified request is held until that transition finishes.
      if (c.req.path === API_PATHS.deviceSync) await run();
      else await this.verified(run);
    };
  }
}
