import { PERSISTED_PATHS } from "@ddl/contract";
import { API_ROUTES, OPERATION_ID_HEADER, silentLogger, WORKSPACE_ID_HEADER } from "@ddl/core";
import { MemoryStorageProvider, type WriteOptions } from "@ddl/storage";
import { describe, expect, it, vi } from "vitest";
import { AgentMutations } from "./agent-mutations";
import { createTestApp, FakeAgentRuntime, makeApproval, makeThread } from "./test-helpers";

class FailingReceipts extends MemoryStorageProvider {
  interrupt: "preparation-response" | "completion" | null = null;
  override async write(path: string, content: string, options?: WriteOptions) {
    if (path.startsWith(PERSISTED_PATHS.mutationJournals)) {
      if (this.interrupt === "completion" && content.includes('"mutation.completed"')) {
        this.interrupt = null;
        throw new Error("Completion storage unavailable");
      }
      if (this.interrupt === "preparation-response") {
        this.interrupt = null;
        await super.write(path, content, options);
        throw new Error("Lost preparation response");
      }
    }
    return super.write(path, content, options);
  }
}

function ledger(storage = new FailingReceipts()) {
  return new AgentMutations({
    local: storage,
    authority: () => ({ storage, epoch: 0, isCurrent: () => true }),
    logger: silentLogger,
  });
}

describe("agent mutation receipts", () => {
  it("waits for preparation, coalesces in-flight retries and replays exact results after restart", async () => {
    const storage = new FailingReceipts();
    const one = ledger(storage);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(async () => {
      expect(
        (await storage.list({ prefix: PERSISTED_PATHS.mutationJournals, includeHidden: true }))
          .length,
      ).toBe(1);
      entered();
      await gate;
      return Response.json({ ok: true, pending: true }, { status: 202 });
    });
    const start = () =>
      one.perform(
        "workspace_one",
        "operation_one",
        "/api/threads/thread_one/messages",
        { text: "Hello" },
        dispatch,
      );
    const first = start();
    await ready;
    expect((await one.lookup("workspace_one", "operation_one")).outcome).toBe("pending");
    const second = start();
    release();
    expect(await (await first).text()).toBe(await (await second).text());
    const restarted = ledger(storage);
    const result = await restarted.perform(
      "workspace_one",
      "operation_one",
      "/api/threads/thread_one/messages",
      { text: "Hello" },
      dispatch,
    );
    expect(result.status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await restarted.lookup("workspace_one", "operation_one")).outcome).toBe("applied");
    await expect(
      restarted.perform(
        "workspace_one",
        "operation_one",
        "/api/threads/thread_one/messages",
        { text: "Changed" },
        dispatch,
      ),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it.each(["preparation-response", "completion"] as const)(
    "never redispatches after lost %s",
    async (point) => {
      const storage = new FailingReceipts();
      storage.interrupt = point;
      const dispatch = vi.fn(async () => Response.json({ ok: true }));
      await expect(
        ledger(storage).perform(
          "workspace_one",
          "operation_one",
          "/api/threads/thread_one/retry",
          null,
          dispatch,
        ),
      ).rejects.toBeDefined();
      const restarted = ledger(storage);
      expect((await restarted.lookup("workspace_one", "operation_one")).outcome).toBe(
        "indeterminate",
      );
      await expect(
        restarted.perform(
          "workspace_one",
          "operation_one",
          "/api/threads/thread_one/retry",
          null,
          dispatch,
        ),
      ).rejects.toMatchObject({ code: "operation_indeterminate" });
      expect(dispatch).toHaveBeenCalledTimes(point === "completion" ? 1 : 0);
    },
  );

  it("guards all action routes, preserves rejected decisions, and leaves legacy requests unchanged", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thread_one", makeThread("thread_one"));
    runtime.approvals = [makeApproval("approval_one")];
    const app = await createTestApp({ runtime });
    const health = await (await app.request(API_ROUTES.health)).json();
    const headers = {
      [WORKSPACE_ID_HEADER]: health.workspaceId,
      [OPERATION_ID_HEADER]: "operation_one",
    };
    const send = (path: string, json?: unknown, operationId = "operation_one") =>
      app.request(path, {
        method: "POST",
        headers: { ...headers, [OPERATION_ID_HEADER]: operationId },
        ...(json ? { json } : {}),
      });
    const messages = API_ROUTES.threadMessages("thread_one");
    expect((await send(messages, { text: "Hello" })).status).toBe(200);
    expect((await send(messages, { text: "Hello" })).status).toBe(200);
    expect((await send(messages, { text: "Other" })).status).toBe(409);
    expect((await send(API_ROUTES.threadCancel("thread_one"))).status).toBe(409);
    for (const [name, path] of [
      ["stop", API_ROUTES.threadCancel("thread_one")],
      ["retry", API_ROUTES.threadRetry("thread_one")],
    ]) {
      expect((await send(path!, undefined, name)).status).toBe(200);
      expect((await send(path!, undefined, name)).status).toBe(200);
    }
    const approval = API_ROUTES.approval("approval_one");
    const decision = { decision: "approve", scope: "once" };
    const decided = await (await send(approval, decision, "decision_one")).json();
    expect(await (await send(approval, decision, "decision_one")).json()).toEqual(decided);
    expect((await send(approval, { decision: "deny" }, "decision_two")).status).toBe(409);
    expect((await send(approval, { decision: "deny" }, "decision_two")).status).toBe(409);
    await app.request(messages, { method: "POST", json: { text: "Legacy" } });
    expect(runtime.calls.filter((call) => call.method === "postUserMessage")).toHaveLength(2);
    expect(runtime.calls.filter((call) => call.method === "cancelThread")).toHaveLength(1);
    expect(runtime.calls.filter((call) => call.method === "retryThread")).toHaveLength(1);
    expect(runtime.calls.filter((call) => call.method === "decideApproval")).toHaveLength(1);
    const receipt = await app.request(API_ROUTES.agentOperation("operation_one"), { headers });
    expect(receipt.status).toBe(400); // Operation headers only apply to mutations, never a lookup.
    const found = await app.request(API_ROUTES.agentOperation("operation_one"), {
      headers: { [WORKSPACE_ID_HEADER]: health.workspaceId },
    });
    expect((await found.json()).outcome).toBe("applied");
  });
});
