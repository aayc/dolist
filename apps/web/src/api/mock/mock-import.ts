import {
  type AppSettings,
  addDays,
  type CarryOverDailyNote,
  type CarryOverPlan,
  createId,
  type DailyNoteSettings,
  type DeviceVaultResponse,
  dailyNotePath,
  isHiddenPath,
  type ObsidianImportJob,
  type ObsidianImportOrigin,
  type ObsidianImportPreview,
  type ObsidianImportRequest,
  type ObsidianImportStatusResponse,
  type ObsidianPlugin,
  type ObsidianUpdateReport,
  parseDailyNotePath,
  type ServerEvent,
  today,
  toISODate,
} from "@ddl/core";
import { readJson, STORAGE_KEYS, writeJson } from "../../lib/storage";
import { HttpError } from "../errors";

/** The simulated Mac's home folder: every path the mock shows is under it (all synthetic). */
export const MOCK_HOME = "/Users/me";
const DDL_HOME = `${MOCK_HOME}/.daily-do-list`;
export const MOCK_DEFAULT_VAULT = `${MOCK_HOME}/Demo Vault`;
/** An Obsidian vault the mock can import. */
export const MOCK_OBSIDIAN_VAULT = `${MOCK_HOME}/Obsidian Notebook`;
/** A folder of notes without `.obsidian/`. */
export const MOCK_PLAIN_FOLDER = `${MOCK_HOME}/Plain notes`;

const OBSIDIAN_DAILY: DailyNoteSettings = {
  folder: "Journal/Daily",
  format: "YYYY/MM/YYYY-MM-DD",
  template: "Templates/Daily.md",
};

const OBSIDIAN_PLUGINS: ObsidianPlugin[] = [
  { id: "dataview", name: "Dataview", support: "partial", note: "Queries show as text." },
  {
    id: "obsidian-excalidraw-plugin",
    name: "Excalidraw",
    support: "supported",
    note: "Drawings open and edit here.",
  },
  {
    id: "obsidian-kanban",
    name: "Kanban",
    support: "unsupported",
    note: "Boards show as their markdown lists.",
  },
  {
    id: "obsidian-tasks-plugin",
    name: "Tasks",
    support: "partial",
    note: "Task lines work; query blocks show as text.",
  },
  {
    id: "word-sprint",
    name: "Word Sprint",
    support: "unknown",
    note: "Doesn't run here; its files are kept and it still works in Obsidian.",
  },
];

/** Obsidian notes the carried-over vault collides with. */
const OBSIDIAN_NOTES = new Set(["Ideas.md", "Projects/Garden.md"]);

/** Copying steps of a simulated job, and what an import copies. */
const COPY_STEPS = 6;
const OBSIDIAN_TOTALS = { files: 64, bytes: 3_482_112 };
const PLAIN_TOTALS = { files: 12, bytes: 48_640 };

interface PersistedMockVault {
  vault: string;
  /** Folders made by imports (the destinations), so they exist after a reload. */
  folders: string[];
  /** Where each imported vault came from. */
  origins: Record<string, ObsidianImportOrigin>;
}

export interface MockImportsHost {
  emit(event: ServerEvent): void;
  settings(): AppSettings;
  /** Every note path of the current (mock) vault. */
  notePaths(): string[];
  /** The agent's history the carry-over plan counts. */
  agentCounts(): { threads: number; records: number; approvals: number; routines: number };
  /** Writes a note the way a file copied in by the daemon arrives (an external change). */
  writeExternal(path: string, content: string): void;
  /** The daemon exits and a supervisor starts it again. */
  restart(): void;
  /** The vault syncs with the sync service (this device's sync setup). */
  syncing(): boolean;
}

export interface MockImportsOptions {
  /** Delay between a simulated job's progress steps. */
  stepMs?: number;
  persist?: boolean;
}

function invalid(message: string): HttpError {
  return new HttpError(400, message, { error: "invalid_request", message });
}

function notFound(message: string): HttpError {
  return new HttpError(404, message, { error: "not_found", message });
}

function conflict(message: string, code: "conflict" | "locked_by_env" = "conflict"): HttpError {
  return new HttpError(409, message, { error: code, message });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** `~/…` or absolute; trailing slashes dropped. */
function expand(input: string, what: string): string {
  const trimmed = input.trim();
  let path: string;
  if (trimmed === "~") path = MOCK_HOME;
  else if (trimmed.startsWith("~/")) path = `${MOCK_HOME}/${trimmed.slice(2)}`;
  else if (trimmed.startsWith("/")) path = trimmed;
  else throw invalid(`The ${what} must be an absolute path (or start with ~/)`);
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function withLabel(name: string, n: number): string {
  return `${name} (Daily Do List${n > 1 ? ` ${n}` : ""})`;
}

function list<T>(items: T[]): { count: number; items: T[] } {
  return { count: items.length, items: items.slice(0, 200) };
}

/**
 * Importing from Obsidian and switching vaults, in the in-browser mock: two synthetic source
 * folders (an Obsidian vault and a plain folder), jobs that progress on a timer, and a switch that
 * "restarts" the mock daemon. Only the vault's name follows a switch: the notes stay the demo's.
 */
export class MockImports {
  private readonly host: MockImportsHost;
  private readonly stepMs: number;
  private readonly persist: boolean;
  private state: PersistedMockVault;
  private job: ObsidianImportJob | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private restarting = false;
  /** Test hooks: this browser is a paired device, `DDL_VAULT` fixes the vault. */
  pairedDevice = false;
  lockedByEnv = false;

  constructor(host: MockImportsHost, options: MockImportsOptions = {}) {
    this.host = host;
    this.stepMs = options.stepMs ?? 350;
    this.persist = options.persist ?? true;
    const stored = this.persist ? readJson<PersistedMockVault>(STORAGE_KEYS.mockVault) : null;
    this.state = stored ?? { vault: MOCK_DEFAULT_VAULT, folders: [], origins: {} };
  }

  get vaultPath(): string {
    return this.state.vault;
  }

  get vaultName(): string {
    return basename(this.state.vault);
  }

  /** The daemon came back after a switch. */
  restarted(): void {
    this.restarting = false;
  }

  vault(): DeviceVaultResponse {
    this.thisMachineOnly();
    return { path: this.state.vault, lockedByEnv: this.lockedByEnv };
  }

  switchVault(input: string): DeviceVaultResponse {
    this.thisMachineOnly();
    if (this.lockedByEnv) {
      throw conflict(
        "DDL_VAULT sets the vault this daemon opens; change it there",
        "locked_by_env",
      );
    }
    if (this.restarting) {
      throw conflict("The daemon is already restarting to open another vault");
    }
    const path = expand(input, "vault");
    if (!this.folderExists(path)) throw invalid(`There's no folder at ${input.trim()}`);
    if (overlaps(path, DDL_HOME))
      throw invalid("A vault can't be in or hold Daily Do List's own folder");
    if (path === this.state.vault) return this.vault();
    if (this.job?.state === "running") {
      throw conflict("An import from Obsidian is running; wait for it or cancel it");
    }
    if (this.host.syncing()) {
      throw conflict(
        "This device syncs its vault: turn sync off before switching vaults, or the old notes sync into the new one",
      );
    }
    this.state = { ...this.state, vault: path };
    this.save();
    this.restarting = true;
    this.job = null;
    this.host.restart();
    return { path, lockedByEnv: false, restart: "supervisor" };
  }

  preview(input: string): ObsidianImportPreview {
    this.thisMachineOnly();
    const source = this.resolveSource(input);
    const obsidian = source === MOCK_OBSIDIAN_VAULT;
    const carryOver = this.carryOver(obsidian);
    const warnings: string[] = [];
    if (!obsidian) {
      warnings.push("This folder has no .obsidian folder: it's copied as a plain folder of notes.");
    }
    if (this.host.syncing()) {
      warnings.push(
        "This device syncs its vault: turn sync off before switching to the new vault, or the old notes sync back into it.",
      );
    }
    const collisions = carryOver.collisions.count;
    if (collisions > 0) {
      warnings.push(
        collisions === 1
          ? '1 file has the same name as one in the Obsidian vault and gets "(Daily Do List)" added; links to it lead to the Obsidian one.'
          : `${collisions} files have the same names as ones in the Obsidian vault and get "(Daily Do List)" added; links to them lead to the Obsidian ones.`,
      );
    }
    if (carryOver.watchedOpenTasks > 0 && carryOver.actOnExistingTasks) {
      warnings.push(
        `After the switch the agent looks at ${carryOver.watchedOpenTasks} open tasks in Obsidian's daily notes for the days it watches, because "Act on existing tasks" is on.`,
      );
    }
    const totals = obsidian ? OBSIDIAN_TOTALS : PLAIN_TOTALS;
    return {
      source,
      defaultDestination: this.defaultDestination(source),
      isObsidianVault: obsidian,
      files: totals.files,
      bytes: totals.bytes,
      notes: obsidian ? 41 : 11,
      folders: obsidian ? 9 : 2,
      attachments: obsidian
        ? {
            count: 14,
            bytes: 3_180_000,
            byType: [
              { type: "image", count: 11, bytes: 2_900_000 },
              { type: "pdf", count: 2, bytes: 260_000 },
              { type: "other", count: 1, bytes: 20_000 },
            ],
          }
        : { count: 1, bytes: 12_000, byType: [{ type: "image", count: 1, bytes: 12_000 }] },
      settings: obsidian
        ? {
            files: [
              ".obsidian.vimrc",
              ".obsidian/app.json",
              ".obsidian/appearance.json",
              ".obsidian/daily-notes.json",
            ],
            dailyNotes: OBSIDIAN_DAILY,
            editor: { vimMode: true, readableLineLength: true, showLineNumbers: false },
            vimrc: true,
            theme: "dark",
          }
        : { files: [], dailyNotes: null, editor: {}, vimrc: false },
      templates: obsidian ? { folder: "Templates", count: 3 } : { folder: null, count: 0 },
      plugins: obsidian ? OBSIDIAN_PLUGINS : [],
      canvases: obsidian
        ? { count: 2, paths: ["Projects/Garden plan.canvas", "Projects/Trip.canvas"] }
        : { count: 0, paths: [] },
      drawings: obsidian
        ? { count: 1, paths: ["Drawings/Kitchen layout.excalidraw.md"] }
        : { count: 0, paths: [] },
      skipped: obsidian
        ? list([{ path: "Attachments/Holiday video.mov", reason: "symlink_outside" as const }])
        : list([]),
      carryOver,
      warnings,
    };
  }

  status(): ObsidianImportStatusResponse {
    this.thisMachineOnly();
    const imported = this.state.origins[this.state.vault];
    return { job: this.job, ...(imported ? { imported } : {}) };
  }

  startImport(request: ObsidianImportRequest): ObsidianImportJob {
    this.thisMachineOnly();
    this.assertIdle();
    const source = this.resolveSource(request.source);
    const destination =
      request.destination === undefined
        ? this.defaultDestination(source)
        : this.resolveDestination(request.destination, source);
    const obsidian = source === MOCK_OBSIDIAN_VAULT;
    const totals = obsidian ? OBSIDIAN_TOTALS : PLAIN_TOTALS;
    const carryOver = this.carryOver(obsidian);
    const moves = carryOver.notes.count + carryOver.daily.count;
    const job: ObsidianImportJob = {
      id: createId("imp"),
      kind: "import",
      state: "running",
      phase: "checking",
      source,
      destination,
      startedAt: Date.now(),
      progress: { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 },
    };
    this.job = job;
    const steps: Array<() => void> = [
      () => {
        job.phase = "copying";
        job.progress.totalFiles = totals.files + moves;
        job.progress.totalBytes = totals.bytes + moves * 400;
      },
      ...Array.from({ length: COPY_STEPS }, (_, i) => () => {
        job.progress.files = Math.round((totals.files * (i + 1)) / COPY_STEPS);
        job.progress.bytes = Math.round((totals.bytes * (i + 1)) / COPY_STEPS);
      }),
      () => {
        job.phase = "carrying_over";
        job.progress.files += moves;
        job.progress.bytes += moves * 400;
      },
      () => {
        job.phase = "finishing";
      },
      () => {
        job.state = "done";
        job.finishedAt = Date.now();
        job.result = {
          copied: totals,
          skipped: obsidian
            ? list([{ path: "Attachments/Holiday video.mov", reason: "symlink_outside" as const }])
            : list([]),
          carryOver,
          manifest: ".daily-do-list/import/obsidian.json",
        };
        this.state = {
          ...this.state,
          folders: [...this.state.folders, destination],
          origins: {
            ...this.state.origins,
            [destination]: { source, importedAt: job.startedAt, previousVault: this.state.vault },
          },
        };
        this.save();
      },
    ];
    this.run(job, steps);
    return job;
  }

  startUpdate(): ObsidianImportJob {
    this.thisMachineOnly();
    this.assertIdle();
    const origin = this.state.origins[this.state.vault];
    if (!origin) throw notFound("This vault wasn't imported from Obsidian");
    if (!this.folderExists(origin.source)) {
      throw notFound(`The Obsidian vault isn't at ${origin.source} any more`);
    }
    const job: ObsidianImportJob = {
      id: createId("imp"),
      kind: "update",
      state: "running",
      phase: "checking",
      source: origin.source,
      destination: this.state.vault,
      startedAt: Date.now(),
      progress: { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 },
    };
    this.job = job;
    const phoneNote = "Journal/Phone notes.md";
    const update: ObsidianUpdateReport = {
      added: { count: 1, paths: [phoneNote] },
      updated: { count: 1, paths: ["Projects/Garden.md"] },
      restored: { count: 0, paths: [] },
      conflicts: list([{ from: "Ideas.md", to: "Ideas (Obsidian).md" }]),
      deletedInSource: { count: 0, paths: [] },
      unchanged: OBSIDIAN_TOTALS.files - 2,
      skipped: list([]),
    };
    this.run(job, [
      () => {
        job.phase = "copying";
        job.progress.totalFiles = 3;
        job.progress.totalBytes = 1_200;
      },
      () => {
        job.progress.files = 3;
        job.progress.bytes = 1_200;
        this.host.writeExternal(phoneNote, "Written on my phone: ideas for the garden.\n");
      },
      () => {
        job.state = "done";
        job.phase = "finishing";
        job.finishedAt = Date.now();
        job.update = update;
        this.state = {
          ...this.state,
          origins: {
            ...this.state.origins,
            [this.state.vault]: { ...origin, updatedAt: Date.now() },
          },
        };
        this.save();
      },
    ]);
    return job;
  }

  cancel(): ObsidianImportJob {
    this.thisMachineOnly();
    const job = this.job;
    if (job?.state !== "running") throw notFound("No import or update is running");
    clearTimeout(this.timer);
    job.state = "cancelled";
    job.finishedAt = Date.now();
    this.publish(job);
    return job;
  }

  private run(job: ObsidianImportJob, steps: Array<() => void>): void {
    this.publish(job);
    const next = (i: number) => {
      this.timer = setTimeout(() => {
        if (job.state !== "running") return;
        steps[i]!();
        this.publish(job);
        if (i + 1 < steps.length) next(i + 1);
      }, this.stepMs);
    };
    next(0);
  }

  private publish(job: ObsidianImportJob): void {
    this.host.emit({ type: "import.progress", job });
  }

  private assertIdle(): void {
    if (this.job?.state === "running") throw conflict("An import or update is already running");
  }

  private thisMachineOnly(): void {
    if (!this.pairedDevice) return;
    const message = "Only this machine can import vaults or switch them, not a paired device";
    throw new HttpError(403, message, { error: "forbidden_device", message });
  }

  private folderExists(path: string): boolean {
    return (
      path === MOCK_HOME ||
      path === DDL_HOME ||
      path === MOCK_DEFAULT_VAULT ||
      path === MOCK_OBSIDIAN_VAULT ||
      path === MOCK_PLAIN_FOLDER ||
      path === this.state.vault ||
      this.state.folders.includes(path)
    );
  }

  private resolveSource(input: string): string {
    const source = expand(input, "Obsidian vault");
    if (!this.folderExists(source)) throw invalid(`There's no folder at ${input.trim()}`);
    if (overlaps(source, DDL_HOME)) {
      throw invalid("The Obsidian vault can't be in or hold Daily Do List's own folder");
    }
    if (overlaps(source, this.state.vault)) {
      throw invalid("The Obsidian vault can't be in or hold the current Daily Do List vault");
    }
    return source;
  }

  private destinationProblem(path: string, source: string): string | null {
    if (!this.folderExists(dirname(path))) {
      return `The folder that would hold ${path} doesn't exist`;
    }
    if (isInside(path, source)) return "The new vault can't be inside the Obsidian vault";
    if (isInside(path, DDL_HOME)) return "The new vault can't be inside Daily Do List's own folder";
    if (isInside(path, this.state.vault)) return "The new vault can't be inside the current vault";
    if (this.folderExists(path)) return `${path} isn't empty`;
    return null;
  }

  private resolveDestination(input: string, source: string): string {
    const path = expand(input, "destination");
    const problem = this.destinationProblem(path, source);
    if (problem) throw invalid(problem);
    return path;
  }

  private defaultDestination(source: string): string {
    const parent = dirname(this.state.vault);
    const name = basename(source);
    for (let n = 0; n <= 100; n++) {
      const candidate = `${parent}/${n === 0 ? name : withLabel(name, n)}`;
      if (!this.destinationProblem(candidate, source)) return candidate;
    }
    throw invalid("Choose a destination folder for the new vault");
  }

  private carryOver(obsidian: boolean): CarryOverPlan {
    const settings = this.host.settings();
    const current = settings.dailyNotes;
    const target = obsidian ? OBSIDIAN_DAILY : current;
    const daily: CarryOverDailyNote[] = [];
    const notes: Array<{ from: string; to: string }> = [];
    const collisions: Array<{ from: string; to: string }> = [];
    const yesterday = toISODate(addDays(today(), -1));
    for (const path of this.host.notePaths().sort()) {
      if (isHiddenPath(path)) continue;
      const date = parseDailyNotePath(path, current);
      if (date) {
        const iso = toISODate(date);
        const merged = obsidian && iso === yesterday;
        daily.push({ date: iso, from: path, to: dailyNotePath(date, target), merged });
        continue;
      }
      const to =
        obsidian && OBSIDIAN_NOTES.has(path) ? path.replace(/\.md$/, " (Daily Do List).md") : path;
      notes.push({ from: path, to });
      if (to !== path) collisions.push({ from: path, to });
    }
    const agent = this.host.agentCounts();
    return {
      vault: this.state.vault,
      dailyNotes: target,
      dailyNotesFrom: obsidian ? "obsidian" : "daily_do_list",
      notes: list(notes),
      daily: {
        count: daily.length,
        merged: daily.filter((d) => d.merged).length,
        items: daily.slice(0, 200),
      },
      collisions: list(collisions),
      routines: notes.filter((n) => n.from.startsWith("Routines/")).length,
      drawings: notes.filter((n) => n.from.endsWith(".excalidraw.md")).length,
      agent: {
        threads: agent.threads,
        detached: agent.threads > 0 ? 1 : 0,
        records: agent.records,
        approvals: agent.approvals,
        routines: agent.routines,
        trackedNotes: daily.length,
        journal: 0,
      },
      watchedOpenTasks: obsidian ? 3 : 0,
      actOnExistingTasks: settings.agent.actOnExistingTasks,
      leftBehind: { count: 0, paths: [] },
    };
  }

  private save(): void {
    if (this.persist) writeJson(STORAGE_KEYS.mockVault, this.state);
  }
}
