import { encodePersistedRoutines, PERSISTED_ROUTINE_RUNS_KEPT } from "@ddl/contract";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTINES_STATE_PATH, type RoutineState, RoutineStateStore } from "./state";
import { sept } from "./test-helpers";

const PATH = "Routines/Kettle.md";
const ID = "rtn_kettle";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function store(storage: MemoryStorageProvider, clock = { now: sept(23, 10) }, readOnly = false) {
  return new RoutineStateStore({ storage, now: () => clock.now, readOnly });
}

async function saved(storage: MemoryStorageProvider): Promise<Record<string, RoutineState>> {
  const file = await storage.read(ROUTINES_STATE_PATH);
  return file
    ? (JSON.parse(file.content) as { routines: Record<string, RoutineState> }).routines
    : {};
}

describe("RoutineStateStore", () => {
  it("saves shortly after a change and loads it back", async () => {
    const storage = new MemoryStorageProvider();
    const first = store(storage);
    first.update(ID, PATH, () => ({ scheduleKey: "every hour", nextRunAt: sept(23, 11) }));
    expect(await storage.read(ROUTINES_STATE_PATH)).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect((await saved(storage))[ID]).toMatchObject({ nextRunAt: sept(23, 11) });

    const second = store(storage);
    await second.load();
    expect(second.get(ID)).toEqual({
      path: PATH,
      scheduleKey: "every hour",
      nextRunAt: sept(23, 11),
      runs: [],
      updatedAt: sept(23, 10),
    });
  });

  it("keeps only the most recent runs", async () => {
    const storage = new MemoryStorageProvider();
    const states = store(storage);
    const runs = Array.from({ length: PERSISTED_ROUTINE_RUNS_KEPT + 5 }, (_, i) => `thr_${i}`);
    states.update(ID, PATH, () => ({ runs }));
    expect(states.get(ID)?.runs).toEqual(runs.slice(0, PERSISTED_ROUTINE_RUNS_KEPT));
    await states.flush();
    expect((await saved(storage))[ID]?.runs).toHaveLength(PERSISTED_ROUTINE_RUNS_KEPT);
  });

  it.each([
    ["truncated JSON", '{"version":1,"routines":{"rtn_kettle":{"path":'],
    ["the wrong shape", '{"version":1,"routines":["Routines/Kettle.md"]}'],
    ["nothing at all", ""],
  ])("moves a file holding %s aside and starts over", async (_what, content) => {
    const storage = new MemoryStorageProvider();
    await storage.write(ROUTINES_STATE_PATH, content);
    const states = store(storage);
    await expect(states.load()).resolves.toBeUndefined();
    expect(states.get(ID)).toBeUndefined();
    const aside = await storage.list({ prefix: ".daily-do-list/corrupt", includeHidden: true });
    expect(aside).toHaveLength(1);
    expect((await storage.read(aside[0]!.path))?.content).toBe(content);

    states.update(ID, PATH, () => ({ nextRunAt: sept(23, 11) }));
    await states.flush();
    expect((await saved(storage))[ID]).toMatchObject({ nextRunAt: sept(23, 11) });
  });

  it("never writes over a newer app's file", async () => {
    const storage = new MemoryStorageProvider();
    const newer = '{"version":99,"routines":{}}';
    await storage.write(ROUTINES_STATE_PATH, newer);
    const states = store(storage);
    await states.load();
    states.update(ID, PATH, () => ({ nextRunAt: sept(23, 11) }));
    await states.flush();
    expect((await storage.read(ROUTINES_STATE_PATH))?.content).toBe(newer);
  });

  it("keeps each routine's most recent state when another device saved meanwhile", async () => {
    const storage = new MemoryStorageProvider();
    const clock = { now: sept(23, 10) };
    const states = store(storage, clock);
    states.update(ID, PATH, () => ({ nextRunAt: sept(23, 11) }));
    states.update("rtn_other", "Routines/Other.md", () => ({ nextRunAt: sept(23, 12) }));
    await states.flush();

    // Another device (after a lease handover) saved a newer state for one routine and a new one.
    storage.simulateExternalChange(
      ROUTINES_STATE_PATH,
      encodePersistedRoutines({
        routines: {
          [ID]: {
            path: PATH,
            scheduleKey: "every hour",
            nextRunAt: sept(23, 13),
            runs: ["thr_there"],
            updatedAt: sept(23, 10, 30),
          },
          rtn_new: {
            path: "Routines/New.md",
            scheduleKey: null,
            nextRunAt: null,
            runs: [],
            updatedAt: sept(23, 10, 30),
          },
        },
      }),
    );
    clock.now = sept(23, 10, 5);
    states.update("rtn_other", "Routines/Other.md", () => ({ nextRunAt: sept(23, 14) }));
    await states.flush();
    const merged = await saved(storage);
    expect(merged[ID]).toMatchObject({ nextRunAt: sept(23, 13), runs: ["thr_there"] });
    expect(merged.rtn_other).toMatchObject({ nextRunAt: sept(23, 14) });
    expect(merged.rtn_new).toBeDefined();
    expect(states.get(ID)?.nextRunAt).toBe(sept(23, 13));
  });

  it("read-only never writes", async () => {
    const storage = new MemoryStorageProvider();
    const states = store(storage, undefined, true);
    states.update(ID, PATH, () => ({ nextRunAt: sept(23, 11) }));
    await vi.advanceTimersByTimeAsync(10_000);
    await states.flush();
    expect(await storage.read(ROUTINES_STATE_PATH)).toBeNull();
  });

  it("retries a failed save later", async () => {
    const storage = new MemoryStorageProvider();
    const write = storage.write.bind(storage);
    let failures = 1;
    storage.write = async (...args) => {
      if (args[0] === ROUTINES_STATE_PATH && failures-- > 0) throw new Error("disk full");
      return write(...args);
    };
    const states = store(storage);
    states.update(ID, PATH, () => ({ nextRunAt: sept(23, 11) }));
    await states.flush();
    expect(await storage.read(ROUTINES_STATE_PATH)).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await saved(storage))[ID]).toMatchObject({ nextRunAt: sept(23, 11) });
  });
});
