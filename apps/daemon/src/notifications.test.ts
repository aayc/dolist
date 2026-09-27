import { PERSISTED_PATHS } from "@ddl/contract";
import { type RoutineNotification, silentLogger } from "@ddl/core";
import { MemoryStorageProvider, type WriteOptions } from "@ddl/storage";
import { expect, it } from "vitest";
import { NotificationJournal } from "./notifications";

class InterruptedStorage extends MemoryStorageProvider {
  loseResponse = false;
  override async write(path: string, content: string, options?: WriteOptions) {
    const result = await super.write(path, content, options);
    if (this.loseResponse && path.startsWith(PERSISTED_PATHS.notificationJournals)) {
      this.loseResponse = false;
      throw new Error("Lost notification write response");
    }
    return result;
  }
}

const notification = (at: number): RoutineNotification => ({
  routineId: "routine_one",
  threadId: "thread_one",
  title: "Synthetic check",
  body: "A change",
  status: "done",
  at,
});

it("baselines history, pages exact decisions across clock changes/restarts and never recreates suppressed or saved decisions", async () => {
  const storage = new InterruptedStorage();
  let epoch = 2;
  const make = () =>
    new NotificationJournal({
      local: storage,
      authority: () => ({ storage, epoch, isCurrent: () => true }),
      logger: silentLogger,
    });
  const first = make();
  await first.record("workspace_one", "run_old", notification(1000));
  const baseline = await first.page("workspace_one");
  expect(baseline.notifications).toEqual([]);
  await first.record("workspace_one", "run_suppressed", null);
  const live = await first.record("workspace_one", "run_announced", notification(900));
  expect(live?.id).toBeDefined();
  const pageOne = await first.page("workspace_one", baseline.cursor, 1);
  expect(pageOne.notifications).toEqual([]);
  expect(pageOne.hasMore).toBe(true);
  const pageTwo = await first.page("workspace_one", pageOne.cursor, 1);
  expect(pageTwo.notifications).toEqual([live]);
  expect(pageTwo.hasMore).toBe(false);
  epoch = 3;
  const restarted = make();
  expect(await restarted.record("workspace_one", "run_suppressed", notification(2000))).toBeNull();
  expect(await restarted.record("workspace_one", "run_announced", notification(2000))).toBeNull();
  storage.loseResponse = true;
  await expect(
    restarted.record("workspace_one", "run_uncertain", notification(100)),
  ).rejects.toThrow();
  expect(await make().record("workspace_one", "run_uncertain", notification(3000))).toBeNull();
  const catchup = await make().page("workspace_one", pageTwo.cursor);
  expect(catchup.notifications).toHaveLength(1);
  expect(catchup.notifications[0]?.at).toBe(100);
  expect((await make().page("workspace_one", catchup.cursor)).notifications).toEqual([]);
  await expect(make().page("workspace_other", baseline.cursor)).rejects.toMatchObject({
    code: "invalid_request",
  });
});
