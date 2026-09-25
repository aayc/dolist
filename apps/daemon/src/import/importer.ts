/**
 * Importing an Obsidian vault into a new Daily Do List vault (docs/specs/obsidian-migration.md):
 * the preview report, the import itself and "Update from Obsidian". The Obsidian vault is only
 * ever read, and the current vault is left untouched: it's the backup.
 */
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AppSettings,
  createId,
  type Logger,
  type ObsidianImportJob,
  type ObsidianImportPreview,
  type ObsidianImportRequest,
  type ObsidianImportResult,
  SIDECAR_DIR,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import { ApiError, errorMessage } from "../errors";
import {
  type CarryOver,
  countWatchedOpenTasks,
  planCarryOver,
  writeCarriedFiles,
} from "./carry-over";
import { copySource, createStaging, publish, removeStaging } from "./copy";
import { copyFileAtomic, readRegularFile, writeFileAtomic } from "./files";
import { type JobListener, type JobRun, JobRunner } from "./jobs";
import { MANIFEST_PATH, readManifest, writeManifest } from "./manifest";
import { type ObsidianConfig, readObsidianConfig } from "./obsidian-config";
import { defaultDestination, type ImportPlaces, resolveDestination, resolveSource } from "./places";
import { pathList, skippedList } from "./report-lists";
import { type MergedSettings, mergeSettingsFile, SETTINGS_PATH } from "./settings-merge";
import { carrySidecar } from "./sidecar";
import { type SourceScan, scanSource } from "./source-scan";
import { updateFromSource } from "./update";

export interface ObsidianImporterOptions {
  places: ImportPlaces;
  /** The current vault's effective settings. */
  settings: () => AppSettings;
  /** This device syncs its vault (switching would mix the vaults). */
  syncing?: () => boolean;
  logger?: Logger;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
}

/** Notes are read as text for merges and task counts; bigger ones are refused as notes. */
const MAX_NOTE_BYTES = 16 * 1024 * 1024;

interface Analysis {
  source: string;
  /** The current vault's real path. */
  vault: string | null;
  obsidian: ObsidianConfig;
  scan: SourceScan;
  carry: CarryOver;
  settings: MergedSettings;
  warnings: string[];
}

export class ObsidianImporter {
  readonly #options: ObsidianImporterOptions;
  readonly #logger: Logger;
  readonly #jobs: JobRunner;

  constructor(options: ObsidianImporterOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#jobs = new JobRunner({
      now: () => this.#now().getTime(),
      newId: () => this.#newId("imp"),
      describe: (error) => describeFailure(error),
    });
  }

  get places(): ImportPlaces {
    return this.#options.places;
  }

  /** An import or update is running. */
  get busy(): boolean {
    return this.#jobs.busy;
  }

  /** The running job, or the last one since the daemon started. */
  status(): ObsidianImportJob | null {
    return this.#jobs.current();
  }

  onProgress(listener: JobListener): Unsubscribe {
    return this.#jobs.onProgress(listener);
  }

  /** Stops the running import or update; answers once its partial work is removed. */
  cancel(): Promise<ObsidianImportJob> {
    return this.#jobs.cancel();
  }

  /** Waits for the running job to finish (tests). */
  settled(): Promise<void> {
    return this.#jobs.settled();
  }

  /** Cancels whatever runs (daemon shutdown). */
  close(): Promise<void> {
    return this.#jobs.close();
  }

  /**
   * Starts importing into a new vault at `destination` and answers at once with the job; its
   * progress and outcome arrive through `onProgress`.
   */
  async startImport(request: ObsidianImportRequest): Promise<ObsidianImportJob> {
    this.#jobs.assertIdle();
    const source = await resolveSource(request.source, this.#options.places);
    const destination = await resolveDestination(request.destination, source, this.#options.places);
    return this.#jobs.start("import", { source, destination }, async (run) => ({
      result: await this.#runImport(run, source, destination),
    }));
  }

  /**
   * Starts copying what changed in the Obsidian vault since the import into the current vault
   * (see `update.ts`); answers at once with the job.
   */
  async startUpdate(): Promise<ObsidianImportJob> {
    this.#jobs.assertIdle();
    const vault = await this.#vault();
    if (!vault) throw new ApiError(404, "not_found", "This daemon has no vault to update");
    const read = await readManifest(vault);
    if (read.status === "missing") {
      throw new ApiError(404, "not_found", "This vault wasn't imported from Obsidian");
    }
    if (read.status === "unusable") {
      throw new ApiError(404, "not_found", `The import's manifest can't be used: ${read.reason}`);
    }
    const { manifest } = read;
    if (!(await stat(manifest.source).catch(() => null))?.isDirectory()) {
      throw new ApiError(
        404,
        "not_found",
        `The Obsidian vault isn't at ${manifest.source} any more`,
      );
    }
    const source = await resolveSource(manifest.source, this.#options.places);
    return this.#jobs.start("update", { source, destination: vault }, async (run) => ({
      update: await updateFromSource({ vault, manifest, source, run, now: this.#now().getTime() }),
    }));
  }

  async #runImport(
    run: JobRun,
    source: string,
    destination: string,
  ): Promise<ObsidianImportResult> {
    const analysis = await this.#analyze(source, run.signal);
    const { scan, carry } = analysis;
    run.totals(scan.files + carry.moves.length, scan.bytes + carry.bytes);
    const staging = await createStaging(destination, run.job.id);
    try {
      run.phase("copying");
      const copy = await copySource(source, staging, run);
      run.phase("carrying_over");
      const originals = await writeCarriedFiles(carry, staging, run);
      const sidecar = join(staging, SIDECAR_DIR);
      carry.plan.agent = await carrySidecar(
        {
          vault: analysis.vault,
          carry,
          readObsidian: async (path) => originals.get(path) ?? this.#readNote(source, path),
          actOnExistingTasks: this.#options.settings().agent.actOnExistingTasks,
          now: this.#now().getTime(),
          signal: run.signal,
          ...(this.#options.idFactory ? { idFactory: this.#options.idFactory } : {}),
        },
        {
          write: (path, text) => writeFileAtomic(join(sidecar, path), text),
          copy: async (path, absolute) => {
            await copyFileAtomic(absolute, join(sidecar, path), { signal: run.signal });
          },
        },
      );
      const settingsFile = join(staging, SETTINGS_PATH);
      if (analysis.settings.kind === "merged") {
        await writeFileAtomic(settingsFile, analysis.settings.text);
      } else {
        await copyFileAtomic(analysis.settings.absolute, settingsFile, { signal: run.signal });
      }
      run.phase("finishing");
      await writeManifest(staging, {
        source,
        importedAt: run.job.startedAt,
        files: copy.files,
      });
      run.signal.throwIfAborted();
      await publish(staging, destination);
      this.#logger.info("Imported an Obsidian vault", { files: copy.copied.files });
      return {
        copied: copy.copied,
        skipped: skippedList(copy.skipped),
        carryOver: carry.plan,
        manifest: MANIFEST_PATH,
      };
    } catch (error) {
      await removeStaging(staging);
      throw error;
    }
  }

  /** The report, without writing anything. */
  async preview(sourceInput: string): Promise<ObsidianImportPreview> {
    const source = await resolveSource(sourceInput, this.#options.places);
    const analysis = await this.#analyze(source);
    const { obsidian, scan, carry } = analysis;
    return {
      source,
      defaultDestination: await defaultDestination(source, this.#options.places),
      isObsidianVault: obsidian.isObsidianVault,
      files: scan.files,
      bytes: scan.bytes,
      notes: scan.notes,
      folders: scan.folders,
      attachments: scan.attachments,
      settings: obsidian.settings,
      templates: { folder: obsidian.templatesFolder, count: scan.templates },
      plugins: obsidian.plugins,
      canvases: pathList(scan.canvases),
      drawings: pathList(scan.drawings),
      skipped: skippedList(scan.skipped),
      carryOver: carry.plan,
      warnings: analysis.warnings,
    };
  }

  async #analyze(source: string, signal?: AbortSignal): Promise<Analysis> {
    const settings = this.#options.settings();
    const obsidian = await readObsidianConfig(source, this.#logger);
    const scan = await scanSource(source, {
      templatesFolder: obsidian.templatesFolder,
      ...(signal ? { signal } : {}),
    });
    const vault = await this.#vault();
    const carry = await planCarryOver({
      vault,
      settings,
      obsidian,
      source: scan,
      ...(signal ? { signal } : {}),
    });
    carry.plan.agent = await carrySidecar(
      {
        vault,
        carry,
        readObsidian: (path) => this.#readNote(source, path),
        actOnExistingTasks: settings.agent.actOnExistingTasks,
        now: this.#now().getTime(),
        ...(signal ? { signal } : {}),
        ...(this.#options.idFactory ? { idFactory: this.#options.idFactory } : {}),
      },
      null,
    );
    carry.plan.watchedOpenTasks = await countWatchedOpenTasks(
      source,
      scan,
      carry.plan.dailyNotes,
      settings,
      this.#now(),
    );
    const merged = await mergeSettingsFile(vault, carry.plan.dailyNotes, obsidian.patch);
    const warnings = this.#warnings(obsidian, scan, carry);
    if (merged.kind === "newer") {
      warnings.push(
        "This vault's settings were saved by a newer version of Daily Do List, so they're copied unchanged: check the daily-note settings after switching.",
      );
    }
    return { source, vault, obsidian, scan, carry, settings: merged, warnings };
  }

  #warnings(obsidian: ObsidianConfig, scan: SourceScan, carry: CarryOver): string[] {
    const warnings: string[] = [];
    const { plan } = carry;
    if (!obsidian.isObsidianVault) {
      warnings.push("This folder has no .obsidian folder: it's copied as a plain folder of notes.");
    }
    warnings.push(...carry.warnings);
    if (this.#options.syncing?.()) {
      warnings.push(
        "This device syncs its vault: turn sync off before switching to the new vault, or the old notes sync back into it.",
      );
    }
    const collisions = plan.collisions.count;
    if (collisions > 0) {
      warnings.push(
        collisions === 1
          ? '1 file has the same name as one in the Obsidian vault and gets "(Daily Do List)" added; links to it lead to the Obsidian one.'
          : `${collisions} files have the same names as ones in the Obsidian vault and get "(Daily Do List)" added; links to them lead to the Obsidian ones.`,
      );
    }
    if (plan.watchedOpenTasks > 0 && plan.actOnExistingTasks) {
      warnings.push(
        `After the switch the agent looks at ${plural(plan.watchedOpenTasks, "open task")} in Obsidian's daily notes for the days it watches, because "Act on existing tasks" is on.`,
      );
    }
    const journal = plan.agent.journal;
    if (journal > 0) {
      warnings.push(
        journal === 1
          ? "1 agent journal file is copied unchanged: the note paths inside aren't updated yet."
          : `${journal} agent journal files are copied unchanged: the note paths inside aren't updated yet.`,
      );
    }
    const outside = scan.skipped.items.filter((item) => item.reason === "symlink_outside").length;
    if (outside > 0) {
      warnings.push(
        outside === 1
          ? "1 link leads outside the vault and isn't copied."
          : `${outside} links lead outside the vault and aren't copied.`,
      );
    }
    return warnings;
  }

  async #vault(): Promise<string | null> {
    const { vault } = this.#options.places;
    return vault === null ? null : realpath(vault).catch(() => null);
  }

  async #readNote(root: string, path: string): Promise<string | null> {
    const bytes = await readRegularFile(join(root, path), MAX_NOTE_BYTES);
    return bytes ? bytes.toString("utf8") : null;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #newId(prefix: string): string {
    return this.#options.idFactory?.(prefix) ?? createId(prefix);
  }
}

function describeFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "ENOSPC") return "The disk is full";
  if (code === "EACCES" || code === "EPERM") return `Permission denied: ${errorMessage(error)}`;
  return errorMessage(error) || "The import stopped with an unexpected error";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
