import { PERSISTED_PATHS } from "@ddl/contract";
import { API_ROUTES, silentLogger, WORKSPACE_ID_HEADER } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./test-helpers";
import { createSync } from "./wiring";
import { WorkspaceIdentity } from "./workspace-identity";

describe("workspace identity", () => {
  it("persists per vault, survives restart, and converges before syncing independently initialized replicas", async () => {
    const a = new MemoryStorageProvider();
    const b = new MemoryStorageProvider();
    const target = new MemoryStorageProvider();
    const first = new WorkspaceIdentity(a, "host_a");
    const second = new WorkspaceIdentity(b, "host_b");
    const [idA, idB] = await Promise.all([first.current(), second.current()]);
    expect(idA).not.toBe(idB);
    await Promise.all([first.adoptFrom(target), second.adoptFrom(target)]);
    expect(await first.current()).toBe(await second.current());
    expect(await new WorkspaceIdentity(a, "host_a").current()).toBe(await first.current());
    const freshImport = new WorkspaceIdentity(new MemoryStorageProvider(), "host_a");
    expect(await freshImport.current()).not.toBe(await first.current());
  });

  it("drains active exchanges before adoption, blocks old context after it, and defers reentrant sync without deadlocking", async () => {
    const storage = new MemoryStorageProvider();
    const identity = new WorkspaceIdentity(storage, "host_a");
    const old = await identity.current();
    const target = new MemoryStorageProvider();
    await new WorkspaceIdentity(target, "host_b").current();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = identity.verifyAndRun(old, async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await storage.write("Draft.md", "old workspace write finished");
    });
    await started;
    const adopting = identity.adoptFrom(target);
    const later = identity.verifyAndRun(old, async () => {
      await storage.write("Unsafe.md", "must not run");
    });
    finish();
    await writing;
    await adopting;
    await expect(later).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(await storage.read("Unsafe.md")).toBeNull();
    await identity.verifyAndRun(await identity.current(), async () => {
      await expect(identity.adoptFrom(target)).rejects.toThrow("current request");
    });
  });

  it("fails closed for corrupt/newer identity or removal after first use", async () => {
    const storage = new MemoryStorageProvider();
    const identity = new WorkspaceIdentity(storage, "host_a");
    await identity.current();
    for (const content of ["broken", '{"version":2,"workspaceId":"future"}']) {
      await storage.write(PERSISTED_PATHS.workspace, content);
      await expect(identity.current()).rejects.toThrow();
      expect((await storage.read(PERSISTED_PATHS.workspace))?.content).toBe(content);
    }
    await storage.delete(PERSISTED_PATHS.workspace);
    await expect(identity.current()).rejects.toThrow("removed");
  });

  it("rejects an old live client's reads, writes and create-GET after identity adoption, while legacy clients remain compatible", async () => {
    const t = await createTestApp();
    const health = await (await t.request(API_ROUTES.health)).json();
    const headers = { [WORKSPACE_ID_HEADER]: health.workspaceId };
    await t.storage.write(
      PERSISTED_PATHS.workspace,
      JSON.stringify({ version: 1, workspaceId: "another_workspace" }),
    );
    for (const [path, init] of [
      [API_ROUTES.tree, {}],
      [
        API_ROUTES.note("Draft.md"),
        { method: "PUT", json: { content: "never replay here", baseVersion: null } },
      ],
      [API_ROUTES.daily("2026-09-27", true), {}],
    ] as const) {
      const response = await t.request(path, { ...init, headers });
      expect(response.status).toBe(412);
      expect((await response.json()).error).toBe("workspace_mismatch");
    }
    expect(await t.storage.read("Draft.md")).toBeNull();
    expect((await t.storage.list()).length).toBe(0);
    expect((await t.request(API_ROUTES.tree)).status).toBe(200);
  });

  it("keeps endpoint receipts and identity out of the ordinary sync merger", async () => {
    // createSync owns this policy for both folder and service targets.
    const primary = new MemoryStorageProvider();
    const prepare = new WorkspaceIdentity(primary, "host_a");
    const id = await prepare.current();
    await primary.write(`${PERSISTED_PATHS.captures}/host_a/receipt.json`, "private to endpoint");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "ddl-identity-"));
    let reachable = false;
    await primary.write("Draft.md", "offline draft");
    try {
      const sync = await createSync({
        primary,
        target: { kind: "local", root },
        logger: silentLogger,
        prepareTarget: async (target) => {
          if (!reachable) throw new Error("synthetic target offline");
          await prepare.adoptFrom(target);
        },
      });
      expect(sync).not.toBeNull();
      await expect(sync!.engine.syncOnce()).rejects.toThrow("synthetic target offline");
      expect(await sync!.target.read("Draft.md")).toBeNull();
      await primary.write("Draft.md", "still editable offline");
      reachable = true;
      await sync!.engine.syncOnce();
      expect((await sync!.target.read("Draft.md"))?.content).toBe("still editable offline");
      expect(
        JSON.parse((await sync!.target.read(PERSISTED_PATHS.workspace))!.content).workspaceId,
      ).toBe(id);
      expect(await sync!.target.read(`${PERSISTED_PATHS.captures}/host_a/receipt.json`)).toBeNull();
      await sync!.engine.stop();
      await sync!.target.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
