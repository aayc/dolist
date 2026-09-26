/**
 * Persisted state as the whole runtime sees it at startup (mock mode, real stores).
 */
import {
  encodePersistedJournalEvent,
  encodePersistedRecords,
  persistedThreadImportEvent,
} from "@ddl/contract";
import { ORCHESTRATOR_THREAD_ID, type TextMessage, type Thread } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { RECORDS_PATH } from "../../src/orchestrator/records";
import { threadJournalPath } from "../../src/threads/store";
import { createTestRuntime, TODAY } from "../helpers/runtime";
import { paths, readFixture, vault } from "./helpers";

const orphan: Thread = {
  id: "thr_orphan",
  taskId: "tsk_deleted",
  notePath: "Daily/2026-01-01.md",
  title: "A task that was deleted from its note",
  status: "done",
  createdAt: 1,
  updatedAt: 2,
  messages: [],
  artifacts: [],
  surfaces: [],
};

describe("runtime startup with persisted state", () => {
  it("keeps threads whose task no longer exists and explains why it cannot act on them", async () => {
    const storage = vault({
      [threadJournalPath("thr_orphan")]: encodePersistedJournalEvent(
        persistedThreadImportEvent(orphan),
      ),
    });
    const t = await createTestRuntime({ storage });
    try {
      expect(t.runtime.listThreads().map((s) => s.id)).toEqual([
        ORCHESTRATOR_THREAD_ID,
        "thr_orphan",
      ]);
      await t.runtime.postUserMessage("thr_orphan", "Are you still on it?");
      const texts = t.runtime
        .getThread("thr_orphan")!
        .thread.messages.filter((m): m is TextMessage => m.kind === "text")
        .map((m) => m.text);
      expect(texts).toEqual([
        "Are you still on it?",
        "This task is no longer in your notes, so there's nothing to act on.",
      ]);
    } finally {
      await t.runtime.stop();
    }
  });

  it("keeps records of notes that no longer exist", async () => {
    const record = {
      taskId: "tsk_gone",
      notePath: "Daily/2026-09-01.md",
      date: "2026-09-01",
      text: "Old task",
      line: 0,
      status: "done" as const,
      threadId: null,
      updatedAt: Date.now(),
      unread: 0,
    };
    const storage = vault({
      [RECORDS_PATH]: encodePersistedRecords({ records: [record], specs: {} }),
    });
    const t = await createTestRuntime({ storage });
    try {
      expect(t.runtime.getTaskRecords("Daily/2026-09-01.md")).toEqual([record]);
    } finally {
      await t.runtime.stop();
    }
  });

  it("starts healthy on corrupt state: unreadable files are set aside, the rest loads", async () => {
    const storage = vault({
      [RECORDS_PATH]: readFixture("records", "corrupt-truncated.json"),
      ".daily-do-list/threads/thr_minimal0001.json": readFixture("threads", "v1-minimal.json"),
      ".daily-do-list/threads/corrupt-truncated.json": readFixture(
        "threads",
        "corrupt-truncated.json",
      ),
    });
    const t = await createTestRuntime({ storage });
    try {
      expect(t.runtime.status().problem).toBeUndefined();
      expect(t.runtime.listThreads().map((s) => s.id)).toEqual([
        ORCHESTRATOR_THREAD_ID,
        "thr_minimal0001",
      ]);
      const moved = (await paths(storage, ".daily-do-list/corrupt")).map((p) =>
        p.replace(/\.\d{8}T\d{9}Z/, ""),
      );
      expect(moved).toEqual([".daily-do-list/corrupt/state/records.json"]);
      // An unreadable thread snapshot stays where it is (it's never migrated).
      expect(await paths(storage, ".daily-do-list/threads")).toEqual([
        ".daily-do-list/threads/corrupt-truncated.json",
      ]);
    } finally {
      await t.runtime.stop();
    }
  });

  it("never overwrites records.json written by a newer app, even after running and stopping", async () => {
    const future = readFixture("records", "future-version.json");
    const storage = vault({ [RECORDS_PATH]: future });
    const t = await createTestRuntime({ storage });
    await t.storage.write(TODAY, "- [ ] Research ergonomic chairs\n");
    await t.waitForStatus("Research ergonomic chairs", "done");
    await t.runtime.stop();
    expect((await storage.read(RECORDS_PATH))!.content).toBe(future);
  });
});
