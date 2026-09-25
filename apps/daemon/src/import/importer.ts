/**
 * Importing an Obsidian vault into a new Daily Do List vault (docs/specs/obsidian-migration.md):
 * the preview report, the import itself and "Update from Obsidian". The Obsidian vault is only
 * ever read, and the current vault is left untouched: it's the backup.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, Logger, ObsidianImportPreview } from "@ddl/core";
import { silentLogger } from "@ddl/core";
import { type CarryOver, countWatchedOpenTasks, planCarryOver } from "./carry-over";
import { readRegularFile } from "./files";
import { type ObsidianConfig, readObsidianConfig } from "./obsidian-config";
import { defaultDestination, type ImportPlaces, resolveSource } from "./places";
import { pathList, skippedList } from "./report-lists";
import { carrySidecar } from "./sidecar";
import { type SourceScan, scanSource } from "./source-scan";

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
  obsidian: ObsidianConfig;
  scan: SourceScan;
  carry: CarryOver;
  warnings: string[];
}

export class ObsidianImporter {
  readonly #options: ObsidianImporterOptions;
  readonly #logger: Logger;

  constructor(options: ObsidianImporterOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  get places(): ImportPlaces {
    return this.#options.places;
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
    return { source, obsidian, scan, carry, warnings: this.#warnings(obsidian, scan, carry) };
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
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
