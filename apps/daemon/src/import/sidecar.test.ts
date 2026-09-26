import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createThreadStore, type TaskEvent, TaskWatcher } from "@ddl/agent";
import { foldJournal } from "@ddl/agent/journal";
import {
  decodePersistedRecords,
  decodePersistedRoutines,
  decodePersistedTaskState,
  decodePersistedThreadJournal,
  type PersistedThread,
} from "@ddl/contract";
import {
  type AppSettings,
  hashString,
  mergeSettings,
  routineIdForPath,
  SIDECAR_DIR,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObsidianImporter } from "./importer";
import { DETACHED_NOTE, remapJournalFile } from "./sidecar";
import {
  currentFiles,
  currentSettings,
  makeTestbed,
  OBSIDIAN_DAILY,
  ROUTINE_PATH,
  type Testbed,
  TODAY,
  type VaultOptions,
} from "./test-vaults";

const MERGED = "Journal/Daily/2026/09/2026-09-24.md";
const MOVED = "Journal/Daily/2026/09/2026-09-23.md";

let bed: Testbed;
let destination: string;

async function importWith(
  settings: AppSettings = currentSettings(),
  options: { obsidian?: VaultOptions; current?: VaultOptions } = {},
): Promise<void> {
  bed = await makeTestbed(options);
  let n = 0;
  const importer = new ObsidianImporter({
    places: { home: bed.home, vault: bed.vault, homedir: bed.dir },
    settings: () => settings,
    now: () => TODAY,
    idFactory: (prefix) => `${prefix}_new${++n}`,
  });
  await importer.startImport({ source: bed.source });
  await importer.settled();
  const job = importer.status()!;
  expect(job.state, job.error).toBe("done");
  destination = job.destination;
}

async function sidecarText(path: string): Promise<string> {
  return readFile(join(destination, SIDECAR_DIR, path), "utf8");
}

async function thread(id: string): Promise<PersistedThread> {
  const read = decodePersistedThreadJournal(
    await sidecarText(`state/journal/threads/${id}.jsonl`),
    id,
  );
  const folded = foldJournal(read.events, id).thread;
  if (!folded || read.issues.length > 0) throw new Error(`thread ${id} unreadable`);
  return folded;
}

function tracker(path: string) {
  return sidecarText(`state/tasks/${hashString(path)}.json`).then((text) => {
    const decoded = decodePersistedTaskState(text, path);
    if (!decoded.ok) throw new Error(`tracker state of ${path} unreadable`);
    return decoded.value;
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await bed?.cleanup();
});

describe("carrying over the agent's history", () => {
  it("carries threads as journals at their notes' new paths, older snapshots migrated in", async () => {
    await importWith();
    expect((await thread("thr_dentist")).notePath).toBe(MERGED);
    expect((await thread("thr_passport")).notePath).toBe(MOVED);
    expect((await thread("thr_ideas")).notePath).toBe("ideas (Daily Do List).md");
    expect(await sidecarText("state/journal/threads/thr_routine.jsonl")).toBe(
      currentFiles()[".daily-do-list/state/journal/threads/thr_routine.jsonl"],
    );
    expect(await readdir(join(destination, SIDECAR_DIR))).not.toContain("threads");
  });

  it("keeps a thread whose task isn't in its note any more, marked detached in its journal", async () => {
    await importWith();
    const gone = await thread("thr_gone");
    expect(gone).toMatchObject({ taskId: "tsk_gone", notePath: MERGED });
    expect(gone.messages.at(-1)).toEqual({
      id: expect.stringMatching(/^msg_new\d+$/),
      kind: "text",
      role: "system",
      author: "system",
      text: DETACHED_NOTE,
      createdAt: TODAY.getTime(),
    });
    expect((await thread("thr_dentist")).messages).toHaveLength(1);
  });

  it("moves task records to the new note path and line", async () => {
    await importWith();
    const decoded = decodePersistedRecords(await sidecarText("state/records.json"));
    if (!decoded.ok) throw new Error("records unreadable");
    expect(
      decoded.value.records.map(({ taskId, notePath, line }) => ({ taskId, notePath, line })),
    ).toEqual([
      { taskId: "tsk_dentist", notePath: MERGED, line: 11 },
      { taskId: "tsk_report", notePath: MERGED, line: 12 },
      { taskId: "tsk_gone", notePath: MERGED, line: 14 },
      { taskId: "tsk_passport", notePath: MOVED, line: 0 },
    ]);
  });

  it("rebuilds task identities at the new paths, Obsidian's tasks settled as existing", async () => {
    await importWith();
    const merged = await tracker(MERGED);
    expect(merged.contentVersion).toBeNull();
    const fresh = expect.stringMatching(/^tsk_new\d+$/);
    expect(merged.tasks.map(({ id, text, line }) => ({ id, text, line }))).toEqual([
      { id: fresh, text: "Water the plants", line: 1 },
      { id: fresh, text: "Answer the landlord", line: 2 },
      { id: "tsk_dentist", text: "Book the dentist", line: 11 },
      { id: "tsk_report", text: "Draft the quarterly report", line: 12 },
    ]);
    expect(Object.keys(merged.settled).sort()).toEqual(merged.tasks.map((task) => task.id).sort());
    expect(merged.settled.tsk_dentist).toMatchObject({ announced: true, task: { line: 11 } });
    expect((await tracker(MOVED)).tasks).toMatchObject([{ id: "tsk_passport", line: 0 }]);
    const states = await readdir(join(destination, SIDECAR_DIR, "state/tasks"));
    expect(states.sort()).toEqual(
      [`${hashString(MERGED)}.json`, `${hashString(MOVED)}.json`].sort(),
    );
  });

  it("leaves Obsidian's tasks unsettled when the agent acts on existing tasks", async () => {
    await importWith(currentSettings({ actOnExistingTasks: true }));
    expect(Object.keys((await tracker(MERGED)).settled).sort()).toEqual([
      "tsk_dentist",
      "tsk_report",
    ]);
  });

  it("copies approvals, artifacts and routines state byte for byte", async () => {
    await importWith();
    const files = currentFiles();
    for (const path of [
      "state/approvals.json",
      "state/routines.json",
      "artifacts/thr_dentist/art_1.png.b64",
    ]) {
      expect(await sidecarText(path), path).toBe(files[`${SIDECAR_DIR}/${path}`]);
    }
  });

  it("leaves the old vault's sync snapshots behind", async () => {
    await importWith();
    expect(await readdir(join(destination, SIDECAR_DIR))).not.toContain("sync");
  });

  it("follows a routine renamed on a collision", async () => {
    await importWith(currentSettings(), {
      obsidian: { files: { [ROUTINE_PATH]: "Obsidian's own note about mornings.\n" } },
    });
    const renamed = "Routines/Morning briefing (Daily Do List).md";
    const decoded = decodePersistedRoutines(await sidecarText("state/routines.json"));
    if (!decoded.ok) throw new Error("routines unreadable");
    expect(decoded.value.routines).toEqual({
      [routineIdForPath(renamed)]: expect.objectContaining({ path: renamed }),
    });
    expect((await thread("thr_routine")).routineId).toBe(routineIdForPath(renamed));
  });

  it("points thread journals at the notes' new paths, their other events byte for byte", async () => {
    await importWith();
    const path = "state/journal/threads/thr_dentist.jsonl";
    const before = String(currentFiles()[`${SIDECAR_DIR}/${path}`]).split("\n");
    const after = (await sidecarText(path)).split("\n");
    expect(after[0]).toBe(
      before[0]!.replace('"notePath":"Daily/2026-09-24.md"', `"notePath":"${MERGED}"`),
    );
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

describe("remapJournalFile", () => {
  const remap = {
    notePath: (path: string) => (path === "Daily/old.md" ? "Journal/new.md" : path),
    routineId: (id: string) => (id === "rtn_old" ? "rtn_new" : id),
  };
  const path = "state/journal/threads/thr_a.jsonl";
  const created =
    '{"v":1,"id":"evt_1","epoch":0,"seq":1,"at":1,"type":"thread.created","thread":{"id":"thr_a","taskId":null,"notePath":"Daily/old.md","title":"t","status":"idle","createdAt":1,"routineId":"rtn_old"}}';
  const remapped = created
    .replace('"notePath":"Daily/old.md"', '"notePath":"Journal/new.md"')
    .replace('"routineId":"rtn_old"', '"routineId":"rtn_new"');
  const title =
    '{"v":1,"id":"evt_2","epoch":0,"seq":2,"at":2,"type":"title","title":"Daily/old.md"}';

  it("remaps thread events and keeps every other line, unreadable ones and line ends included", () => {
    const text = `\uFEFF${created}\r\n{ not json\r\n${title}\r\n`;
    expect(remapJournalFile(path, text, remap)).toBe(
      `\uFEFF${remapped}\r\n{ not json\r\n${title}\r\n`,
    );
  });

  it("leaves alone a journal that needs no change, one a newer app wrote, and other journals", () => {
    expect(remapJournalFile(path, `${title}\n`, remap)).toBeNull();
    const newer = '{"v":2,"id":"evt_3","epoch":0,"seq":3,"at":3,"type":"future"}';
    expect(remapJournalFile(path, `${created}\n${newer}\n`, remap)).toBeNull();
    expect(remapJournalFile("state/journal/approvals.jsonl", `${created}\n`, remap)).toBeNull();
  });
});

describe("the agent in the imported vault", () => {
  /** The new vault's files matching `pattern` (text only), in memory. */
  async function newVaultInMemory(pattern: RegExp): Promise<MemoryStorageProvider> {
    const storage = new MemoryStorageProvider();
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(join(destination, folder), { withFileTypes: true })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path);
        else if (pattern.test(path)) {
          await storage.write(path, await readFile(join(destination, path), "utf8"));
        }
      }
    };
    await visit("");
    return storage;
  }

  /** The watcher on 2026-09-24, with the new vault's settings and files (text only). */
  async function watchNewVault(settings: AppSettings): Promise<TaskEvent[]> {
    const storage = await newVaultInMemory(/\.(md|json)$/);
    vi.useFakeTimers({ now: new Date(2026, 8, 24, 12, 0, 0) });
    const watcher = new TaskWatcher({
      storage,
      settings: mergeSettings(settings, { dailyNotes: OBSIDIAN_DAILY, agent: { settleMs: 1000 } }),
    });
    const events: TaskEvent[] = [];
    watcher.on("task", (event) => events.push(event));
    await watcher.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await watcher.stop();
    return events;
  }

  it("loads journaled threads at their notes' new paths and routines' new ids", async () => {
    await importWith(currentSettings(), {
      obsidian: { files: { [ROUTINE_PATH]: "Obsidian's own note about mornings.\n" } },
    });
    const threads = createThreadStore({
      storage: await newVaultInMemory(/\.jsonl?$/),
      now: () => TODAY.getTime(),
    });
    await threads.load();
    expect(threads.get("thr_dentist")).toMatchObject({ taskId: "tsk_dentist", notePath: MERGED });
    expect(threads.get("thr_passport")).toMatchObject({ notePath: MOVED });
    const gone = threads.get("thr_gone");
    expect(gone).toMatchObject({ taskId: "tsk_gone", notePath: MERGED });
    expect(gone?.messages.at(-1)).toMatchObject({ role: "system", text: DETACHED_NOTE });
    expect(threads.get("thr_routine")?.routineId).toBe(
      routineIdForPath("Routines/Morning briefing (Daily Do List).md"),
    );
    await threads.flush();
  });

  it("sees no new work: carried tasks keep their identity", async () => {
    await importWith();
    expect(await watchNewVault(currentSettings())).toEqual([]);
  });

  it("acts only on Obsidian's open tasks when it acts on existing tasks", async () => {
    const settings = currentSettings({ actOnExistingTasks: true });
    await importWith(settings);
    const events = await watchNewVault(settings);
    expect(events.map((event) => `${event.kind}:${event.task.text}`).sort()).toEqual([
      "added:Answer the landlord",
      "added:Call the plumber",
      "added:Pick up the bike",
    ]);
  });
});
