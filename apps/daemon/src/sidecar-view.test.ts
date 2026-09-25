import {
  encodePersistedApprovals,
  encodePersistedRecords,
  encodePersistedThread,
  PERSISTED_PATHS,
} from "@ddl/contract";
import { silentLogger, type TaskAgentRecord, type Thread } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NullAgentRuntime } from "./null-runtime";
import { SidecarView, type SidecarViewEvent } from "./sidecar-view";
import { makeApproval, makeThread } from "./test-helpers";

const NOTE = "Daily/2026-09-23.md";

function record(taskId: string, overrides: Partial<TaskAgentRecord> = {}): TaskAgentRecord {
  return {
    taskId,
    notePath: NOTE,
    date: "2026-09-23",
    text: "Find a dentist",
    line: 0,
    status: "working",
    threadId: "thr_1",
    updatedAt: 2,
    unread: 0,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return makeThread(id, {
    messages: [
      {
        id: "msg_1",
        kind: "text",
        role: "agent",
        author: "orchestrator",
        text: "On it",
        createdAt: 1,
      },
    ],
    ...overrides,
  });
}

const threadPath = (name: string) => `${PERSISTED_PATHS.threads}/${name}.json`;

async function vault(): Promise<MemoryStorageProvider> {
  const storage = new MemoryStorageProvider();
  await storage.write(threadPath("thr_1"), encodePersistedThread(thread("thr_1")));
  await storage.write(
    threadPath("thr_2"),
    encodePersistedThread(
      thread("thr_2", { notePath: "Other.md", updatedAt: 5, routineId: "rtn_1" }),
    ),
  );
  await storage.write(
    PERSISTED_PATHS.approvals,
    encodePersistedApprovals({
      grants: [],
      approvals: [
        makeApproval("apr_1"),
        makeApproval("apr_2", { status: "approved", createdAt: 0 }),
      ],
    }),
  );
  await storage.write(
    PERSISTED_PATHS.records,
    encodePersistedRecords({ records: [record("task_thr_1")], specs: {} }),
  );
  await storage.write(
    ".daily-do-list/artifacts/thr_1/art_1.png.b64",
    Buffer.from([1, 2, 3]).toString("base64"),
  );
  return storage;
}

const views: SidecarView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.stop();
});

async function startView(storage: MemoryStorageProvider) {
  const view = new SidecarView({ storage, logger: silentLogger, settleMs: 5 });
  views.push(view);
  const events: SidecarViewEvent[] = [];
  view.on((event) => events.push(event));
  await view.start();
  return { view, events };
}

describe("the synced sidecar, read-only", () => {
  it("shows threads, approvals, task records and artifacts as the agent left them", async () => {
    const storage = await vault();
    const { view } = await startView(storage);

    expect(view.listThreads().map((t) => t.id)).toEqual(["thr_2", "thr_1"]);
    expect(view.listThreads({ notePath: NOTE }).map((t) => t.id)).toEqual(["thr_1"]);
    expect(view.listThreads({ routineId: "rtn_1" }).map((t) => t.id)).toEqual(["thr_2"]);
    expect(view.listThreads({ notePath: NOTE })[0]).toMatchObject({ pendingApprovals: 1 });
    const detail = view.getThread("thr_1");
    expect(detail?.thread.messages).toHaveLength(1);
    expect(detail?.approvals.map((a) => a.id)).toEqual(["apr_2", "apr_1"]);
    expect(view.listApprovals({ status: "pending" }).map((a) => a.id)).toEqual(["apr_1"]);
    expect(view.pendingApprovals()).toBe(1);
    expect(view.getTaskRecords(NOTE)).toEqual([record("task_thr_1")]);
    expect(view.getTaskRecords("Other.md")).toEqual([]);
    expect(view.getThread("thr_missing")).toBeUndefined();
  });

  it("reads artifact bodies, binary ones included, only inside the artifacts folder", async () => {
    const storage = await vault();
    const artifact = {
      id: "art_1",
      threadId: "thr_1",
      title: "Screenshot",
      kind: "image" as const,
      mimeType: "image/png",
      path: ".daily-do-list/artifacts/thr_1/art_1.png.b64",
      size: 3,
      createdAt: 1,
    };
    await storage.write(
      threadPath("thr_1"),
      encodePersistedThread(thread("thr_1", { artifacts: [artifact] })),
    );
    const { view } = await startView(storage);
    const read = await view.readArtifact("thr_1", "art_1");
    expect(read?.meta).toEqual(artifact);
    expect([...(read?.body ?? [])]).toEqual([1, 2, 3]);
    expect(await view.readArtifact("thr_1", "art_missing")).toBeNull();
  });

  it("merges conflict copies, skips unreadable and newer files, and never writes", async () => {
    const storage = await vault();
    const copy = thread("thr_1", {
      updatedAt: 9,
      messages: [
        {
          id: "msg_2",
          kind: "text",
          role: "agent",
          author: "orchestrator",
          text: "Done",
          createdAt: 2,
        },
      ],
    });
    await storage.write(
      threadPath("thr_1 (conflict 2026-09-23 1830)"),
      encodePersistedThread(copy),
    );
    await storage.write(threadPath("thr_bad"), "{ not json");
    await storage.write(
      threadPath("thr_new"),
      JSON.stringify({ ...thread("thr_new"), version: 99 }),
    );
    const write = vi.spyOn(storage, "write");
    const remove = vi.spyOn(storage, "delete");
    const rename = vi.spyOn(storage, "rename");
    const { view } = await startView(storage);

    expect(
      view
        .listThreads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["thr_1", "thr_2"]);
    expect(view.getThread("thr_1")?.thread.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(view.getThread("thr_1")?.thread.updatedAt).toBe(9);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(await storage.read(threadPath("thr_bad"))).not.toBeNull();
  });

  it("follows what sync brings in", async () => {
    const storage = await vault();
    const { view, events } = await startView(storage);

    await storage.write(
      threadPath("thr_1"),
      encodePersistedThread(thread("thr_1", { status: "done", updatedAt: 7 })),
    );
    await storage.write(
      threadPath("thr_3"),
      encodePersistedThread(thread("thr_3", { updatedAt: 8 })),
    );
    await vi.waitFor(() => expect(view.listThreads()[0]?.id).toBe("thr_3"));
    expect(view.getThread("thr_1")?.thread.status).toBe("done");

    await storage.write(
      PERSISTED_PATHS.approvals,
      encodePersistedApprovals({
        grants: [],
        approvals: [
          makeApproval("apr_1", { status: "denied" }),
          makeApproval("apr_2", { status: "approved", createdAt: 0 }),
        ],
      }),
    );
    await storage.write(
      PERSISTED_PATHS.records,
      encodePersistedRecords({ records: [record("task_thr_1", { status: "done" })], specs: {} }),
    );
    await vi.waitFor(() => expect(view.pendingApprovals()).toBe(0));
    await vi.waitFor(() => expect(view.getTaskRecords(NOTE)[0]?.status).toBe("done"));

    await storage.delete(threadPath("thr_3"));
    await vi.waitFor(() => expect(view.getThread("thr_3")).toBeUndefined());

    const kinds = events.map((event) =>
      event.type === "thread.upsert"
        ? `thread ${event.thread.id}`
        : event.type === "approval.upsert"
          ? `approval ${event.approval.id} ${event.approval.status}`
          : `records ${event.notePath}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "thread thr_1",
        "thread thr_3",
        "approval apr_1 denied",
        `records ${NOTE}`,
      ]),
    );
    expect(kinds).not.toContain("approval apr_2 approved");
  });

  it("forgets everything when stopped and reads it again when started", async () => {
    const storage = await vault();
    const { view } = await startView(storage);
    view.stop();
    expect(view.listThreads()).toEqual([]);
    expect(view.listApprovals()).toEqual([]);
    await storage.write(threadPath("thr_3"), encodePersistedThread(thread("thr_3")));
    await view.start();
    expect(view.listThreads()).toHaveLength(3);
  });
});

describe("a device that doesn't run the agent", () => {
  it("shows the agent's work read-only and says why it can't act", async () => {
    const storage = await vault();
    const runtime = new NullAgentRuntime({
      mode: "mock",
      storage,
      problem: "The agent is running on Desktop.",
    });
    await runtime.start();
    try {
      expect(runtime.listThreads().map((t) => t.id)).toEqual(["thr_2", "thr_1"]);
      expect(runtime.getThread("thr_1")?.approvals).toHaveLength(2);
      expect(runtime.listApprovals({ status: "pending" })).toHaveLength(1);
      expect(runtime.getTaskRecords(NOTE)).toHaveLength(1);
      expect(runtime.status()).toMatchObject({
        pendingApprovals: 1,
        problem: "The agent is running on Desktop.",
      });
      await expect(runtime.postUserMessage()).rejects.toThrow("The agent is running on Desktop.");
      await expect(runtime.decideApproval()).rejects.toThrow("The agent is running on Desktop.");

      const upserts: string[] = [];
      runtime.on("thread.upsert", (summary) => upserts.push(summary.id));
      await storage.write(threadPath("thr_3"), encodePersistedThread(thread("thr_3")));
      await vi.waitFor(() => expect(upserts).toEqual(["thr_3"]));

      await runtime.followSidecar(false);
      expect(runtime.listThreads()).toEqual([]);
      await runtime.followSidecar(true);
      expect(runtime.listThreads()).toHaveLength(3);
    } finally {
      await runtime.stop();
    }
  });
});
