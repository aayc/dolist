import { PERSISTED_PATHS } from "@ddl/contract";
import { silentLogger } from "@ddl/core";
import { MemoryStorageProvider, RemoteStorageProvider } from "@ddl/storage";
import { createSyncServer } from "@ddl/sync";
import { expect, it, vi } from "vitest";
import { AgentMutations } from "./agent-mutations";

it("prepares on the fenced authority before dispatch and never dispatches that preparation after handover", async () => {
  const server = await createSyncServer({ db: ":memory:", port: 0 });
  const created = server.store.createVault("Synthetic mutation handover");
  const vault = created.vault.id;
  const hold = (device: string) => {
    const lease = server.store.acquireLease(vault, "agent", {
      device,
      deviceName: device,
      session: device,
      ttlMs: 60_000,
    });
    if (!lease.ok) throw new Error("Lease unavailable");
    return lease.holder.epoch;
  };
  let epochA: number | null = hold("device_a");
  let epochB: number | null = null;
  const source = (deviceId: string, leaseEpoch: () => number | null) =>
    new RemoteStorageProvider({
      url: server.url,
      vault,
      token: created.token,
      deviceId,
      deviceName: deviceId,
      leaseEpoch,
    });
  const remoteA = source("device_a", () => epochA);
  const remoteB = source("device_b", () => epochB);
  const make = (remote: RemoteStorageProvider, epoch: () => number | null) =>
    new AgentMutations({
      local: new MemoryStorageProvider(),
      logger: silentLogger,
      authority: () => {
        const captured = epoch();
        return {
          storage: remote,
          epoch: captured,
          isCurrent: () => captured !== null && epoch() === captured,
        };
      },
    });
  try {
    await remoteA.write(
      PERSISTED_PATHS.workspace,
      JSON.stringify({ version: 1, workspaceId: "workspace_one" }),
    );
    const a = make(remoteA, () => epochA);
    const b = make(remoteB, () => epochB);
    let entered!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchA = vi.fn(async () => {
      const receipts = await remoteA.list({
        prefix: PERSISTED_PATHS.mutationJournals,
        includeHidden: true,
      });
      expect(receipts).toHaveLength(1);
      entered();
      await gate;
      return Response.json({ ok: true });
    });
    const first = a.perform(
      "workspace_one",
      "operation_one",
      "/api/threads/thread_one/retry",
      null,
      dispatchA,
    );
    const firstFailed = expect(first).rejects.toMatchObject({ code: "operation_indeterminate" });
    await dispatched;
    server.store.releaseLease(vault, "agent", "device_a", "device_a");
    epochA = null;
    epochB = hold("device_b");
    const dispatchB = vi.fn(async () => Response.json({ ok: true }));
    await expect(
      b.perform("workspace_one", "operation_one", "/api/threads/thread_one/retry", null, dispatchB),
    ).rejects.toMatchObject({ code: "operation_indeterminate" });
    expect((await b.lookup("workspace_one", "operation_one")).outcome).toBe("indeterminate");
    release();
    await firstFailed;
    expect(dispatchA).toHaveBeenCalledTimes(1);
    expect(dispatchB).not.toHaveBeenCalled();
    await expect(
      a.perform("workspace_one", "operation_two", "/api/threads/thread_one/retry", null, dispatchB),
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(
      (
        await b.perform(
          "workspace_one",
          "operation_two",
          "/api/threads/thread_one/retry",
          null,
          dispatchB,
        )
      ).status,
    ).toBe(200);
    expect(dispatchB).toHaveBeenCalledTimes(1);
    await remoteB.write(
      PERSISTED_PATHS.workspace,
      JSON.stringify({ version: 1, workspaceId: "workspace_other" }),
    );
    await expect(
      b.perform(
        "workspace_one",
        "operation_three",
        "/api/threads/thread_one/retry",
        null,
        dispatchB,
      ),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(dispatchB).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all([remoteA.dispose(), remoteB.dispose()]);
    await server.close();
  }
});
