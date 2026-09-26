/**
 * Synthetic vaults for the import tests (temp folders only, invented content): an Obsidian vault
 * with its config, plugins, daily notes, attachments, a canvas, Dataview blocks and a drawing, and
 * a current Daily Do List vault with daily notes in another folder and format, a routine and an
 * agent sidecar (thread journals and older snapshots, records, approvals, routines and tracker
 * state).
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodePersistedApprovals,
  encodePersistedJournalEvent,
  encodePersistedRecords,
  encodePersistedRoutines,
  encodePersistedTaskState,
  encodePersistedThread,
  type PersistedJournalEvent,
  type PersistedJournalPayload,
  type PersistedTaskAgentRecord,
  type PersistedThread,
  type PersistedTrackedTask,
  persistedThreadJournalPath,
} from "@ddl/contract";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  hashString,
  mergeSettings,
  routineIdForPath,
} from "@ddl/core";
import { sha256 } from "./files";

/** Local noon on 2026-09-25: "today" for these vaults. */
export const TODAY = new Date(2026, 8, 25, 12, 0, 0);
export const T0 = new Date(2026, 8, 20, 9, 30, 0).getTime();

/** A 1×1 PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** Every byte value, twice. */
export const ALL_BYTES = Buffer.from([...Array(512).keys()].map((i) => i % 256));

export const OBSIDIAN_DAILY = {
  folder: "Journal/Daily",
  format: "YYYY/MM/YYYY-MM-DD",
  template: "Templates/Daily note",
};

export const OBSIDIAN_FILES: Readonly<Record<string, string | Buffer>> = {
  ".obsidian/daily-notes.json": JSON.stringify(OBSIDIAN_DAILY),
  ".obsidian/app.json": JSON.stringify({
    vimMode: true,
    livePreview: true,
    showLineNumber: true,
    spellcheck: false,
    promptDelete: false,
  }),
  ".obsidian/appearance.json": JSON.stringify({ theme: "obsidian", baseFontSize: 16 }),
  ".obsidian/core-plugins.json": JSON.stringify(["file-explorer", "daily-notes", "templates"]),
  ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
  ".obsidian/community-plugins.json": JSON.stringify([
    "dataview",
    "obsidian-excalidraw-plugin",
    "templater-obsidian",
    "obsidian-tasks-plugin",
    "homemade-widget",
  ]),
  ".obsidian/plugins/dataview/manifest.json": JSON.stringify({ id: "dataview", name: "Dataview" }),
  ".obsidian/plugins/dataview/main.js": "module.exports = class Dataview {};\n",
  ".obsidian/plugins/obsidian-excalidraw-plugin/manifest.json": JSON.stringify({
    id: "obsidian-excalidraw-plugin",
    name: "Excalidraw",
  }),
  ".obsidian/plugins/homemade-widget/manifest.json": "{ not json",
  ".obsidian/workspace.json": JSON.stringify({ main: { id: "a1" }, lastOpenFiles: ["Ideas.md"] }),
  ".obsidian.vimrc": "imap jk <Esc>\nnmap j gj\n",
  "Templates/Daily note.md": "## Tasks\n- [ ] \n",
  "Templates/Meeting.md": "## Attendees\n\n## Notes\n",
  "Journal/Daily/2026/09/2026-09-24.md":
    '# Thursday\n- [x] Water the plants\n- [ ] Answer the landlord\n\n```dataview\nTASK FROM "Projects"\n',
  "Journal/Daily/2026/09/2026-09-25.md": "- [ ] Call the plumber\n- [x] Stretch\n- [ ] \n",
  "Journal/Daily/2026/09/2026-09-26.md": "- [ ] Pick up the bike\n",
  "Ideas.md": "# Ideas\n- A garden bench\n",
  "Projects/Roadmap.md":
    '# Roadmap\n\n```dataview\nTABLE status FROM "Projects"\n```\n\n- [ ] Ship the prototype\n',
  "Projects/Café ☕/Idées d’été.md": "Pique-nique au parc 🌳\n",
  "Projects/Deep/er/and/deeper/note.md": "Down here.\n",
  "Attachments/photo.png": PNG_BYTES,
  "Attachments/scan.pdf": "%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n",
  "Attachments/voice memo.m4a": ALL_BYTES,
  "Attachments/archive.bin": ALL_BYTES,
  "Boards/Plan.canvas": JSON.stringify({
    nodes: [{ id: "n1", type: "text", text: "Plan", x: 0, y: 0, width: 200, height: 60 }],
    edges: [],
  }),
  "Excalidraw/Sketch.excalidraw.md": [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
    "",
    "# Excalidraw Data",
    "## Text Elements",
    "Kitchen ^t1",
    "%%",
    "## Drawing",
    "```json",
    JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }),
    "```",
    "%%",
    "",
  ].join("\n"),
  ".trash/Old idea.md": "Discarded.\n",
};

export interface VaultOptions {
  /** Extra files (or overrides) by vault path; null removes a default file. */
  files?: Record<string, string | Buffer | null>;
}

/** Writes the Obsidian vault; every file's mtime is `T0` so copies can be checked. */
export async function buildObsidianVault(root: string, options: VaultOptions = {}): Promise<void> {
  await writeVault(root, { ...OBSIDIAN_FILES, ...options.files });
}

export const CURRENT_DAILY = { folder: "Daily", format: "YYYY-MM-DD", template: "" };

export const TRACKED_2409: PersistedTrackedTask[] = [
  trackedTask("tsk_dentist", "Book the dentist", 1),
  trackedTask("tsk_report", "Draft the quarterly report", 2),
];

/** The current vault's `settings.json` (with a key from a newer app). */
export const CURRENT_SETTINGS_FILE = {
  version: 1,
  theme: "light",
  editor: { vimMode: false, fontSize: 18 },
  dailyNotes: CURRENT_DAILY,
  agent: { model: "mock-model", actOnExistingTasks: false, watch: { pastDays: 0, futureDays: 7 } },
  futureFeature: { enabled: true },
};

export function currentSettings(overrides: Partial<AppSettings["agent"]> = {}): AppSettings {
  return mergeSettings(DEFAULT_SETTINGS, {
    theme: "light",
    editor: { vimMode: false, fontSize: 18 },
    dailyNotes: CURRENT_DAILY,
    agent: {
      model: "mock-model",
      actOnExistingTasks: false,
      watch: { pastDays: 0, futureDays: 7 },
      ...overrides,
    },
  });
}

export const ROUTINE_PATH = "Routines/Morning briefing.md";

export function currentFiles(): Record<string, string | Buffer> {
  const routineId = routineIdForPath(ROUTINE_PATH);
  const dentist = thread("thr_dentist", "tsk_dentist", "Daily/2026-09-24.md");
  const gone = thread("thr_gone", "tsk_gone", "Daily/2026-09-24.md");
  const routine: PersistedThread = { ...thread("thr_routine", "run_1", null), routineId };
  const records: PersistedTaskAgentRecord[] = [
    record("tsk_dentist", "Daily/2026-09-24.md", "Book the dentist", 1, "thr_dentist"),
    record("tsk_report", "Daily/2026-09-24.md", "Draft the quarterly report", 2, null),
    record("tsk_gone", "Daily/2026-09-24.md", "Buy concert tickets", 4, "thr_gone"),
    record("tsk_passport", "Daily/2026-09-23.md", "Renew the passport", 0, "thr_passport"),
  ];
  return {
    "Daily/2026-09-24.md": "# Thu\n- [ ] Book the dentist\n- [ ] Draft the quarterly report\n",
    "Daily/2026-09-23.md": "- [ ] Renew the passport\n",
    "Daily/2026-09-22.md": "- [ ] \n",
    [ROUTINE_PATH]: "---\nschedule: every weekday at 7:30\n---\nBrief me for the day.\n",
    "Excalidraw/Flow.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n",
    "ideas.md": "- Learn the cello\n",
    "Notes/Groceries.md": "- [ ] Oat milk\n",
    "Attachments/receipt.png": PNG_BYTES,
    ".trash/Deleted note.md": "Gone but kept.\n",
    ".obsidian/app.json": "{}",
    ".daily-do-list/settings.json": `${JSON.stringify(CURRENT_SETTINGS_FILE, null, 2)}\n`,
    // Snapshots an older app wrote: next to a journal, alone, or none (thr_gone).
    ".daily-do-list/threads/thr_dentist.json": encodePersistedThread(dentist),
    ".daily-do-list/threads/thr_passport.json": encodePersistedThread(
      thread("thr_passport", "tsk_passport", "Daily/2026-09-23.md"),
    ),
    ".daily-do-list/threads/thr_ideas.json": encodePersistedThread(
      thread("thr_ideas", null, "ideas.md"),
    ),
    ".daily-do-list/threads/thr_routine.json": encodePersistedThread(routine),
    ".daily-do-list/artifacts/thr_dentist/art_1.png.b64": PNG_BYTES.toString("base64"),
    ".daily-do-list/state/records.json": encodePersistedRecords({ records, specs: {} }),
    ".daily-do-list/state/approvals.json": encodePersistedApprovals({
      grants: [{ toolName: "web_fetch", scope: "task", taskId: "tsk_dentist", createdAt: T0 }],
      approvals: [
        {
          id: "apr_1",
          threadId: "thr_dentist",
          taskId: "tsk_dentist",
          toolName: "browser_click",
          input: { ref: "e12" },
          summary: "Book the 9:00 slot",
          risk: "high",
          categories: ["booking"],
          reason: "Books an appointment",
          status: "approved",
          createdAt: T0,
          decidedAt: T0 + 1000,
        },
      ],
    }),
    ".daily-do-list/state/routines.json": encodePersistedRoutines({
      routines: {
        [routineId]: {
          path: ROUTINE_PATH,
          scheduleKey: "every weekday at 7:30",
          nextRunAt: T0 + 86_400_000,
          runs: ["thr_routine"],
          updatedAt: T0,
        },
      },
    }),
    [`.daily-do-list/state/tasks/${hashString("Daily/2026-09-24.md")}.json`]:
      encodePersistedTaskState({
        notePath: "Daily/2026-09-24.md",
        contentVersion: "v-old",
        tasks: TRACKED_2409,
        settled: Object.fromEntries(
          TRACKED_2409.map((task) => [task.id, { task, announced: true }]),
        ),
      }),
    [`.daily-do-list/state/tasks/${hashString("Daily/2026-09-23.md")}.json`]:
      encodePersistedTaskState({
        notePath: "Daily/2026-09-23.md",
        contentVersion: "v-old",
        tasks: [trackedTask("tsk_passport", "Renew the passport", 0)],
        settled: {},
      }),
    [`.daily-do-list/state/tasks/${hashString("Daily/2026-08-01.md")}.json`]:
      encodePersistedTaskState({
        notePath: "Daily/2026-08-01.md",
        contentVersion: null,
        tasks: [],
        settled: {},
      }),
    ".daily-do-list/sync/local.json": '{"format":1,"entries":{}}\n',
    [persistedThreadJournalPath("thr_dentist")]: startedJournal(dentist),
    [persistedThreadJournalPath("thr_gone")]: startedJournal(gone),
    [persistedThreadJournalPath("thr_routine")]: journal("thr_routine", [
      { type: "thread.imported", thread: routine },
    ]),
  };
}

/** The journal of a thread the store started: its snapshot is the fold of these events. */
function startedJournal(thread: PersistedThread): string {
  const { id, taskId, notePath, title, status, createdAt, messages } = thread;
  return journal(id, [
    { type: "thread.created", thread: { id, taskId, notePath, title, status, createdAt } },
    ...messages.map((message) => ({ type: "message" as const, message })),
    { type: "run.prompted", session: "ses_1", text: "Book the dentist" },
  ]);
}

function journal(threadId: string, payloads: PersistedJournalPayload[]): string {
  return payloads
    .map((payload, i) => {
      const envelope = {
        v: 1 as const,
        id: `evt_${threadId}_${i + 1}`,
        epoch: 0,
        seq: i + 1,
        at: T0,
      };
      return encodePersistedJournalEvent({ ...envelope, ...payload } as PersistedJournalEvent);
    })
    .join("");
}

export async function buildCurrentVault(root: string, options: VaultOptions = {}): Promise<void> {
  await writeVault(root, { ...currentFiles(), ...options.files });
}

export interface Testbed {
  /** Real path of the temp folder holding the others. */
  dir: string;
  /** The Obsidian vault. */
  source: string;
  /** The current Daily Do List vault. */
  vault: string;
  /** `$DDL_HOME`. */
  home: string;
  cleanup(): Promise<void>;
}

/** Side by side in a fresh temp folder: `Obsidian Notebook/`, `DailyDoList/` and `home/`. */
export async function makeTestbed(
  options: { obsidian?: VaultOptions; current?: VaultOptions } = {},
): Promise<Testbed> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ddl-import-")));
  const testbed: Testbed = {
    dir,
    source: join(dir, "Obsidian Notebook"),
    vault: join(dir, "DailyDoList"),
    home: join(dir, "home"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  await buildObsidianVault(testbed.source, options.obsidian);
  await buildCurrentVault(testbed.vault, options.current);
  await mkdir(testbed.home, { recursive: true });
  return testbed;
}

/** Every file and link under `root` with its bytes' hash and mtime: equal snapshots, untouched tree. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (entry.isDirectory()) {
        out[`${path}/`] = String(info.mtimeMs);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        out[path] = `link:${await readlink(absolute)}`;
      } else {
        out[path] = `${sha256(await readFile(absolute))}@${info.mtimeMs}`;
      }
    }
  };
  await visit("");
  return out;
}

/** A symlink inside `root` (for the no-escape tests). */
export async function link(root: string, path: string, target: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await symlink(target, join(root, path));
}

async function writeVault(
  root: string,
  files: Record<string, string | Buffer | null>,
): Promise<void> {
  const time = new Date(T0);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    await utimes(absolute, time, time);
  }
}

function trackedTask(id: string, text: string, line: number): PersistedTrackedTask {
  return {
    id,
    text,
    status: "open",
    line,
    depth: 0,
    parentId: null,
    notes: [],
    firstSeenAt: T0,
    updatedAt: T0,
  };
}

function record(
  taskId: string,
  notePath: string,
  text: string,
  line: number,
  threadId: string | null,
): PersistedTaskAgentRecord {
  return {
    taskId,
    notePath,
    date: notePath.slice(-13, -3),
    text,
    line,
    status: threadId ? "done" : "idle",
    threadId,
    updatedAt: T0,
    unread: 0,
  };
}

function thread(id: string, taskId: string | null, notePath: string | null): PersistedThread {
  return {
    id,
    taskId,
    notePath,
    title: `Thread ${id}`,
    status: "done",
    createdAt: T0,
    updatedAt: T0,
    messages: [
      {
        id: `msg_${id}`,
        kind: "text",
        role: "agent",
        author: "orchestrator",
        text: "On it.",
        createdAt: T0,
      },
    ],
    artifacts: [],
    surfaces: [],
  };
}
