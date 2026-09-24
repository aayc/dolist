import {
  decodePersistedTaskState,
  PersistedTaskStateFileSchema,
  persistedQuarantinePath,
} from "@ddl/contract";
import type { AppSettings, DeepPartial, TrackedTask } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskWatcher, taskStatePath } from "../../src/orchestrator/task-watcher";
import type { TaskEvent } from "../../src/orchestrator/types";
import { testSettings } from "../helpers/fakes";
import { readFixture, recordingLogger, sidecar, vault } from "./helpers";

const TODAY = "Daily/2026-09-23.md";
const NOTE =
  "- [ ] Book a dentist appointment for next week 🦷\n  - mornings preferred\n- [x] Pay rent\n";
const STATE = taskStatePath(TODAY);
const SETTLE = 1_000;
const START = new Date(2026, 8, 23, 10, 0, 0);

const FIXTURE_TASKS: TrackedTask[] = [
  {
    id: "tsk_7fq2m9x0ab",
    text: "Book a dentist appointment for next week 🦷",
    status: "open",
    line: 0,
    depth: 0,
    parentId: null,
    notes: ["mornings preferred"],
    firstSeenAt: 1790154000000,
    updatedAt: 1790154000000,
  },
  {
    id: "tsk_rent000001",
    text: "Pay rent",
    status: "done",
    line: 2,
    depth: 0,
    parentId: null,
    notes: [],
    firstSeenAt: 1790154000000,
    updatedAt: 1790154000000,
  },
];

let watchers: TaskWatcher[] = [];

function watch(storage: ReturnType<typeof vault>, settings: DeepPartial<AppSettings> = {}) {
  const logger = recordingLogger();
  const watcher = new TaskWatcher({
    storage,
    settings: testSettings({ agent: { settleMs: SETTLE }, ...settings }),
    logger,
  });
  watchers.push(watcher);
  const events: TaskEvent[] = [];
  watcher.on("task", (event) => events.push(event));
  return { watcher, events, logger };
}

const kinds = (events: TaskEvent[]) => events.map((e) => `${e.kind}:${e.task.text}`);
const quarantined = () => persistedQuarantinePath(STATE, START);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(async () => {
  for (const watcher of watchers) await watcher.stop();
  watchers = [];
  vi.useRealTimers();
});

describe("golden tracker-state fixtures through the real TaskWatcher", () => {
  it.each(["v1.json", "legacy-unversioned.json"])(
    "%s resumes with its task ids and settled snapshots: no events for known tasks",
    async (name) => {
      const storage = vault({ [TODAY]: NOTE, [STATE]: readFixture("task-state", name) });
      const { watcher, events } = watch(storage);
      await watcher.start();
      await vi.advanceTimersByTimeAsync(SETTLE * 2);
      expect(events).toEqual([]);
      expect(watcher.getTasks(TODAY)).toEqual(FIXTURE_TASKS);
      await watcher.stop();
      expect((await storage.read(STATE))!.content).toBe(readFixture("task-state", name));

      storage.simulateExternalChange(TODAY, NOTE.replace("- [ ] Book", "- [x] Book"));
      const second = watch(storage);
      await second.watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(kinds(second.events)).toEqual([
        "completed:Book a dentist appointment for next week 🦷",
      ]);
      expect(second.events[0]!.task.id).toBe("tsk_7fq2m9x0ab");
    },
  );

  it("v1-invalid-entries.json keeps the valid tasks, then repairs the file and keeps a copy", async () => {
    const original = readFixture("task-state", "v1-invalid-entries.json");
    const storage = vault({ [TODAY]: NOTE, [STATE]: original });
    const { watcher, events } = watch(storage);
    await watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(events).toEqual([]);
    expect(watcher.getTasks(TODAY).map((t) => t.id)).toEqual(["tsk_7fq2m9x0ab"]);
    await watcher.stop();
    const copies = Object.entries(await sidecar(storage)).filter(([path]) =>
      path.includes("/corrupt/"),
    );
    expect(copies).toEqual([
      [expect.stringMatching(/^\.daily-do-list\/corrupt\/state\/tasks\//), original],
    ]);
    const repaired = decodePersistedTaskState((await storage.read(STATE))!.content, TODAY);
    expect(repaired).toMatchObject({ ok: true, issues: [], value: { tasks: [FIXTURE_TASKS[0]] } });
  });

  it.each(["corrupt-truncated.json", "corrupt-other-note.json"])(
    "%s is moved aside and the note's existing tasks are taken as known, not acted on again",
    async (name) => {
      const content = readFixture("task-state", name);
      const storage = vault({ [TODAY]: NOTE, [STATE]: content });
      const { watcher, events } = watch(storage);
      await watcher.start();
      await vi.advanceTimersByTimeAsync(SETTLE * 2);
      expect(events).toEqual([]);
      expect(watcher.getTasks(TODAY).map((t) => t.text)).toEqual([
        "Book a dentist appointment for next week 🦷",
        "Pay rent",
      ]);
      await watcher.stop();
      expect((await storage.read(quarantined()))!.content).toBe(content);
      const fresh = decodePersistedTaskState((await storage.read(STATE))!.content, TODAY);
      expect(fresh.ok && fresh.value.tasks.map((t) => t.id)).toEqual(
        watcher.getTasks(TODAY).map((t) => t.id),
      );

      storage.simulateExternalChange(TODAY, NOTE.replace("- [ ] Book", "- [x] Book"));
      const second = watch(storage);
      await second.watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(kinds(second.events)).toEqual([
        "completed:Book a dentist appointment for next week 🦷",
      ]);
    },
  );

  it("(contrast) a note seen for the first time acts on its existing tasks", async () => {
    const { watcher, events } = watch(vault({ [TODAY]: NOTE }));
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(events)).toEqual(["added:Book a dentist appointment for next week 🦷"]);
  });

  it("future-version.json is never overwritten; tasks are baselined and edits still detected", async () => {
    const future = readFixture("task-state", "future-version.json");
    const storage = vault({ [TODAY]: NOTE, [STATE]: future });
    const { watcher, events } = watch(storage);
    await watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(events).toEqual([]);
    await storage.write(TODAY, `${NOTE}- [ ] Renew passport\n`);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual(["added:Renew passport"]);
    await watcher.stop();
    expect(await sidecar(storage)).toEqual({ [STATE]: future });
  });
});

describe("tracker state edge cases", () => {
  it("renamed daily-note folder: moved notes start fresh tracking, old state is left untouched", async () => {
    const v1 = readFixture("task-state", "v1.json");
    const moved = "Journal/2026-09-23.md";
    const storage = vault({ [TODAY]: NOTE, [moved]: NOTE, [STATE]: v1 });
    const { watcher, events } = watch(storage, { agent: { actOnExistingTasks: false } });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE);
    watcher.updateSettings(
      testSettings({
        agent: { settleMs: SETTLE, actOnExistingTasks: false },
        dailyNotes: { folder: "Journal" },
      }),
    );
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(watcher.watchedNotes()).toEqual([moved]);
    expect(events).toEqual([]);
    expect(watcher.getTasks(moved).map((t) => t.id)).not.toContain("tsk_7fq2m9x0ab");
    await watcher.stop();
    expect((await storage.read(STATE))!.content).toBe(v1);
    expect(
      decodePersistedTaskState((await storage.read(taskStatePath(moved)))!.content, moved),
    ).toMatchObject({
      ok: true,
    });
  });

  it("never overwrites tracker state that a newer app wrote while the watcher runs", async () => {
    const storage = vault({ [TODAY]: NOTE });
    const { watcher } = watch(storage);
    await watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    const newer = '{"version":9,"notePath":"Daily/2026-09-23.md"}';
    storage.simulateExternalChange(STATE, newer);
    await storage.write(TODAY, `${NOTE}- [ ] Another task\n`);
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    await watcher.stop();
    expect((await storage.read(STATE))!.content).toBe(newer);
  });
});

describe("tracker state writer", () => {
  const line = fc
    .tuple(
      fc.constantFrom("- [ ] ", "- [x] ", "  - [ ] ", "- [/] ", "- [-] ", "* [ ] "),
      fc.stringMatching(/^[A-Za-z0-9 ,.!?éüß🦷-]{1,24}$/u),
    )
    .map(([marker, body]) => `${marker}${body.trim() || "x"}`);

  test.prop([fc.array(line, { minLength: 1, maxLength: 8 })], { numRuns: 25 })(
    "always writes schema-valid state that restores the same task identities",
    async (lines) => {
      const storage = vault({ [TODAY]: `${lines.join("\n")}\n` });
      const first = watch(storage);
      await first.watcher.start();
      await vi.advanceTimersByTimeAsync(SETTLE * 3);
      const tracked = first.watcher.getTasks(TODAY).map((t) => ({ id: t.id, text: t.text }));
      await first.watcher.stop();
      const raw = JSON.parse((await storage.read(STATE))!.content);
      expect(PersistedTaskStateFileSchema.safeParse(raw).success).toBe(true);
      const second = watch(storage);
      await second.watcher.start();
      await vi.advanceTimersByTimeAsync(SETTLE * 3);
      expect(second.events).toEqual([]);
      expect(second.watcher.getTasks(TODAY).map((t) => ({ id: t.id, text: t.text }))).toEqual(
        tracked,
      );
      await second.watcher.stop();
      await storage.dispose();
    },
  );
});
