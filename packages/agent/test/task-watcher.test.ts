import type { AppSettings, DeepPartial } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskWatcher } from "../src/orchestrator/task-watcher";
import type { NoteEvent, TaskEvent } from "../src/orchestrator/types";
import { testSettings } from "./helpers/fakes";

const TODAY = "Daily/2026-09-23.md";
const SETTLE = 1_000;

let watchers: TaskWatcher[] = [];

function setup(
  options: {
    storage?: MemoryStorageProvider;
    settings?: DeepPartial<AppSettings>;
    now?: () => number;
  } = {},
) {
  const storage = options.storage ?? new MemoryStorageProvider();
  const settings = testSettings({ agent: { settleMs: SETTLE }, ...options.settings });
  const watcher = new TaskWatcher({
    storage,
    settings,
    ...(options.now ? { now: options.now } : {}),
  });
  watchers.push(watcher);
  const events: TaskEvent[] = [];
  watcher.on("task", (event) => events.push(event));
  return { storage, watcher, events };
}

const kinds = (events: TaskEvent[]) => events.map((e) => `${e.kind}:${e.task.text}`);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 23, 10, 0, 0) });
});

afterEach(async () => {
  for (const watcher of watchers) await watcher.stop();
  watchers = [];
  vi.useRealTimers();
});

describe("TaskWatcher settling", () => {
  it("emits `added` once a task has been quiet for settleMs, restarting on edits", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Book den");
    await vi.advanceTimersByTimeAsync(600);
    await storage.write(TODAY, "- [ ] Book dentist appointment");
    await vi.advanceTimersByTimeAsync(SETTLE - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(kinds(events)).toEqual(["added:Book dentist appointment"]);
    expect(events[0]).toMatchObject({ notePath: TODAY, date: "2026-09-23" });
  });

  it("settles tasks written together at once, in note order, whatever order their timers fire in", async () => {
    // A clock that ticks on every read gives each later task a shorter delay, so the timers fire
    // bottom to top; handed over one by one, a slow machine split them across orchestrator turns.
    let reads = 0;
    const { storage, watcher, events } = setup({ now: () => Date.now() + reads++ });
    await watcher.start();
    await storage.write(TODAY, "- [ ] Option A\n- [ ] Option B\n- [ ] Option C\n- [ ] Option D");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual([
      "added:Option A",
      "added:Option B",
      "added:Option C",
      "added:Option D",
    ]);
  });

  it("waits while the editor reports typing on the task's line", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Email landlord about the faucet");
    await vi.advanceTimersByTimeAsync(900);
    watcher.noteEditorActivity(TODAY, 0);
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(900);
    expect(kinds(events)).toEqual(["added:Email landlord about the faucet"]);
  });

  it("settles quickly once the cursor moved to another line", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Research standing desks\n- [ ] ");
    watcher.noteEditorActivity(TODAY, 1);
    await vi.advanceTimersByTimeAsync(700);
    expect(kinds(events)).toEqual(["added:Research standing desks"]);
  });

  it("ignores the blank template task until it gets text", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] ");
    await vi.advanceTimersByTimeAsync(SETTLE * 3);
    expect(events).toEqual([]);
    await storage.write(TODAY, "- [ ] R");
    await storage.write(TODAY, "- [ ] Renew passport");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual(["added:Renew passport"]);
  });

  it("keeps identity across edits and reports text and note changes", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Book dentist");
    await vi.advanceTimersByTimeAsync(SETTLE);
    await storage.write(TODAY, "- [ ] Book dentist for Tuesday");
    await vi.advanceTimersByTimeAsync(SETTLE);
    await storage.write(TODAY, "- [ ] Book dentist for Tuesday\n  - prefer mornings");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual([
      "added:Book dentist",
      "updated:Book dentist for Tuesday",
      "updated:Book dentist for Tuesday",
    ]);
    const [added, textEdit, notesEdit] = events;
    expect(textEdit!.task.id).toBe(added!.task.id);
    expect(notesEdit!.task.id).toBe(added!.task.id);
    expect(textEdit).toMatchObject({ changes: ["text"], previous: { text: "Book dentist" } });
    expect(notesEdit).toMatchObject({ changes: ["notes"], task: { notes: ["prefer mornings"] } });
  });

  it("emits completed, reopened and removed", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Pay rent\n- [ ] Plan anniversary trip");
    await vi.advanceTimersByTimeAsync(SETTLE);
    await storage.write(TODAY, "- [x] Pay rent\n- [ ] Plan anniversary trip");
    await vi.advanceTimersByTimeAsync(SETTLE);
    await storage.write(TODAY, "- [ ] Pay rent\n- [ ] Plan anniversary trip");
    await vi.advanceTimersByTimeAsync(SETTLE);
    await storage.write(TODAY, "- [ ] Pay rent\n");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual([
      "added:Pay rent",
      "added:Plan anniversary trip",
      "completed:Pay rent",
      "reopened:Pay rent",
      "removed:Plan anniversary trip",
    ]);
  });

  it("keeps identity when a task is cut and pasted elsewhere", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Alpha task one\n- [ ] Beta task two");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const ids = new Map(events.map((e) => [e.task.text, e.task.id]));
    events.length = 0;
    await storage.write(TODAY, "- [ ] Beta task two");
    await vi.advanceTimersByTimeAsync(300);
    await storage.write(TODAY, "- [ ] Beta task two\n- [ ] Alpha task one");
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(events).toEqual([]);
    expect(watcher.getTasks(TODAY).map((t) => t.id)).toEqual([
      ids.get("Beta task two"),
      ids.get("Alpha task one"),
    ]);
  });
});

describe("TaskWatcher scope", () => {
  it("only watches daily notes inside the window", async () => {
    const { storage, watcher, events } = setup({
      settings: { agent: { watch: { pastDays: 0, futureDays: 1 } } },
    });
    await watcher.start();
    await storage.write("Daily/2026-09-22.md", "- [ ] Yesterday task");
    await storage.write("Daily/2026-09-25.md", "- [ ] Far future task");
    await storage.write("Notes/todo.md", "- [ ] Not a daily note");
    await storage.write("Daily/2026-09-24.md", "- [ ] Tomorrow task");
    await storage.write(TODAY, "- [ ] Today task");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events).sort()).toEqual(["added:Today task", "added:Tomorrow task"]);
  });

  it("dedupes storage events for an already processed version", async () => {
    const { storage, watcher } = setup();
    await watcher.start();
    const reads = vi.spyOn(storage, "read");
    await storage.write(TODAY, "- [ ] Same content");
    await vi.advanceTimersByTimeAsync(0);
    await storage.write(TODAY, "- [ ] Same content");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.mock.calls.filter(([path]) => path === TODAY)).toHaveLength(1);
  });

  it("rescans at midnight so the new day's note is watched", async () => {
    vi.setSystemTime(new Date(2026, 8, 23, 23, 59, 0));
    const storage = new MemoryStorageProvider({
      initialFiles: { "Daily/2026-09-24.md": "- [ ] Water the plants" },
    });
    const { watcher, events } = setup({
      storage,
      settings: { agent: { watch: { pastDays: 0, futureDays: 0 } } },
    });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(kinds(events)).toEqual(["added:Water the plants"]);
    expect(watcher.watchedNotes()).toEqual(["Daily/2026-09-24.md"]);
  });
});

describe("TaskWatcher startup", () => {
  it("acts on open, non-blank existing tasks with actOnExistingTasks", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { [TODAY]: "- [ ] Research desks\n- [x] Paid rent\n- [ ] \n\nSome notes" },
    });
    const { watcher, events } = setup({ storage });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(events)).toEqual(["added:Research desks"]);
  });

  it("baselines existing tasks without actOnExistingTasks; later edits are updates", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { [TODAY]: "- [ ] Research desks" },
    });
    const { watcher, events } = setup({
      storage,
      settings: { agent: { actOnExistingTasks: false } },
    });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(events).toEqual([]);
    await storage.write(TODAY, "- [ ] Research desks under $500");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual(["updated:Research desks under $500"]);
  });

  it("resumes from persisted tracker state and emits edits made while stopped", async () => {
    const storage = new MemoryStorageProvider();
    const first = setup({ storage });
    await first.watcher.start();
    await storage.write(TODAY, "- [ ] Renew passport");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(first.events)).toEqual(["added:Renew passport"]);
    const id = first.events[0]!.task.id;
    await first.watcher.stop();

    const second = setup({ storage });
    await second.watcher.start();
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(second.events).toEqual([]);
    expect(second.watcher.findTask(id)?.task.text).toBe("Renew passport");
    await second.watcher.stop();

    storage.simulateExternalChange(TODAY, "- [x] Renew passport");
    const third = setup({ storage });
    await third.watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(third.events)).toEqual(["completed:Renew passport"]);
    expect(third.events[0]!.task.id).toBe(id);
  });

  it("emits unsettled changes when resumed after a pause", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Draft the newsletter");
    await vi.advanceTimersByTimeAsync(100);
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(events).toEqual([]);
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(events)).toEqual(["added:Draft the newsletter"]);
  });
});

describe("TaskWatcher: the rest of the note", () => {
  function withNotes(options: Parameters<typeof setup>[0] = {}) {
    const context = setup(options);
    const notes: NoteEvent[] = [];
    context.watcher.on("note", (event) => notes.push(event));
    return { ...context, notes };
  }

  it("settles a question written as prose into one `note` event, once the user pauses", async () => {
    const { storage, watcher, notes } = withNotes();
    await watcher.start();
    await storage.write(TODAY, "# Thursday\nSlept badly.");
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(notes).toEqual([]);
    await storage.write(TODAY, "# Thursday\nSlept badly.\nWhat's the capital of Aus");
    watcher.noteEditorActivity(TODAY, 2);
    await storage.write(TODAY, "# Thursday\nSlept badly.\nWhat's the capital of Australia?");
    await vi.advanceTimersByTimeAsync(SETTLE - 1);
    expect(notes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notes.map((n) => n.lines)).toEqual([
      [{ line: 2, text: "What's the capital of Australia?" }],
    ]);
    expect(watcher.getContent(TODAY)).toContain("What's the capital of Australia?");
  });

  it("stays quiet for journaling, the agent's own lines, and a cut-and-paste", async () => {
    const { storage, watcher, notes } = withNotes();
    await watcher.start();
    // A note created while watching is new writing: its question is news once.
    await storage.write(TODAY, "Find a plumber for Saturday?");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(notes.map((n) => n.lines.map((l) => l.text))).toEqual([
      ["Find a plumber for Saturday?"],
    ]);
    notes.length = 0;
    await storage.write(TODAY, "Find a plumber for Saturday?\nLunch with Sam was great.");
    await storage.write(
      TODAY,
      "Find a plumber for Saturday?\nLunch with Sam was great.\nWhat time is it in Tokyo? %%agent:thr_1%%",
    );
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    await storage.write(TODAY, "Lunch with Sam was great.");
    await storage.write(TODAY, "Lunch with Sam was great.\nFind a plumber for Saturday?");
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(notes).toEqual([]);
  });

  it("never announces the agent's own tasks, until the user deletes the marker", async () => {
    const { storage, watcher, events } = setup();
    await watcher.start();
    await storage.write(TODAY, "- [ ] Call the restaurant to confirm %%agent:thr_1%%");
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(events).toEqual([]);
    await storage.write(TODAY, "- [ ] Call the restaurant to confirm");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(kinds(events)).toEqual(["added:Call the restaurant to confirm"]);
  });

  it("lets the agent's edits wait for a pause in the user's typing", async () => {
    const { watcher } = setup();
    await watcher.start();
    let paused = false;
    watcher.noteEditorActivity(TODAY, 0);
    void watcher.waitForPause(TODAY).then(() => {
      paused = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    watcher.noteEditorActivity(TODAY, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(paused).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(paused).toBe(true);
    await expect(watcher.waitForPause("Daily/2026-09-24.md")).resolves.toBeUndefined();
  });
});
