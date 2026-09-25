/**
 * Importing an Obsidian vault (preview, import, update from Obsidian, progress) and switching the
 * vault this daemon opens. See docs/specs/obsidian-migration.md.
 */
import { IMPORT_REPORT_LIMIT } from "@ddl/core";
import { z } from "zod";
import {
  CountSchema,
  EpochMsSchema,
  IsoDateSchema,
  RuntimeIdSchema,
  WIRE_LIMITS,
} from "./primitives";
import { named } from "./registry";
import { DailyNoteSettingsSchema, ThemePreferenceSchema } from "./settings";

/** A folder on the daemon's machine (absolute). */
const FolderSchema = z.string().min(1).max(WIRE_LIMITS.responsePathLength);
/** A folder as a client sends it: absolute, or starting with `~/`. */
const FolderInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(WIRE_LIMITS.requestPathLength)
  .describe("An absolute path, or one starting with `~/` (the daemon user's home).");
/** A path inside a vault as a report lists it (any file name the folder holds). */
const ReportPathSchema = z
  .string()
  .min(1)
  .max(WIRE_LIMITS.responsePathLength)
  .describe("Vault-relative, `/`-separated.");
const reportItems = <T extends z.ZodType>(item: T) => z.array(item).max(IMPORT_REPORT_LIMIT);

// ── Switching vaults ─────────────────────────────────────────────────────

export const DaemonRestartSchema = named(
  "DaemonRestart",
  "How a daemon that exits to apply a change comes back: `supervisor` (the Mac app starts it again) or `manual` (the user does).",
  z.enum(["supervisor", "manual"]),
);

export const DeviceVaultRequestSchema = named(
  "DeviceVaultRequest",
  "Body of `PUT /api/device/vault`: the vault this daemon should open.",
  z.strictObject({ path: FolderInputSchema }),
);

export const DeviceVaultResponseSchema = named(
  "DeviceVaultResponse",
  "The vault this daemon opens.",
  z.looseObject({
    path: FolderSchema.describe("The vault's folder (absolute)."),
    lockedByEnv: z.boolean().describe("`DDL_VAULT` sets it: switching answers 409."),
    restart: DaemonRestartSchema.optional().describe(
      "Set when switching: the daemon exits with `RESTART_EXIT_CODE` (75) right after answering and opens the new vault when it starts again.",
    ),
  }),
);

// ── Reports ──────────────────────────────────────────────────────────────

export const ImportPathListSchema = named(
  "ImportPathList",
  `Paths, sorted, at most ${IMPORT_REPORT_LIMIT}; \`count\` is the full number.`,
  z.looseObject({ count: CountSchema, paths: reportItems(ReportPathSchema) }),
);

export const ImportMoveSchema = named(
  "ImportMove",
  "A file and where it goes.",
  z.looseObject({ from: ReportPathSchema, to: ReportPathSchema }),
);

export const ImportMoveListSchema = named(
  "ImportMoveList",
  `Moves sorted by \`from\`, at most ${IMPORT_REPORT_LIMIT}; \`count\` is the full number.`,
  z.looseObject({ count: CountSchema, items: reportItems(ImportMoveSchema) }),
);

export const ImportSkipReasonSchema = named(
  "ImportSkipReason",
  "Why a file isn't copied: a link leading outside the vault (`symlink_outside`) or to a folder (`symlink_folder`), not a regular file (`special_file`), unreadable, or the vault's own `.daily-do-list/` (`sidecar`).",
  z.enum(["symlink_outside", "symlink_folder", "special_file", "unreadable", "sidecar"]),
);

export const ImportSkippedListSchema = named(
  "ImportSkippedList",
  `Files not copied, sorted by path, at most ${IMPORT_REPORT_LIMIT}; \`count\` is the full number.`,
  z.looseObject({
    count: CountSchema,
    items: reportItems(z.looseObject({ path: ReportPathSchema, reason: ImportSkipReasonSchema })),
  }),
);

export const AttachmentTypeSchema = named(
  "AttachmentType",
  "Kind of attachment, by file extension.",
  z.enum(["image", "pdf", "audio", "video", "other"]),
);

export const AttachmentSummarySchema = named(
  "AttachmentSummary",
  "Attachments (files other than notes, canvases and drawings), by type.",
  z.looseObject({
    count: CountSchema,
    bytes: CountSchema,
    byType: z.array(
      z.looseObject({ type: AttachmentTypeSchema, count: CountSchema, bytes: CountSchema }),
    ),
  }),
);

export const ObsidianPluginSupportSchema = named(
  "ObsidianPluginSupport",
  "How an Obsidian community plugin fares here.",
  z.enum(["supported", "partial", "unsupported", "unknown"]),
);

export const ObsidianPluginSchema = named(
  "ObsidianPlugin",
  "An enabled community plugin.",
  z.looseObject({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200).optional().describe("From its manifest, when readable."),
    support: ObsidianPluginSupportSchema,
    note: z.string().min(1).max(500).describe("How it fares here, one sentence."),
  }),
);

export const ObsidianSettingsFoundSchema = named(
  "ObsidianSettingsFound",
  "The settings found in the Obsidian vault's config, and what is imported from them.",
  z.looseObject({
    files: z.array(ReportPathSchema).describe("Config files found."),
    dailyNotes: DailyNoteSettingsSchema.nullable().describe(
      "Obsidian's daily notes (its defaults when the plugin is on without a config); null when it keeps none.",
    ),
    editor: z.looseObject({
      vimMode: z.boolean().optional(),
      livePreview: z.boolean().optional(),
      readableLineLength: z.boolean().optional(),
      showLineNumbers: z.boolean().optional(),
      spellcheck: z.boolean().optional(),
    }),
    vimrc: z.boolean().describe("A vimrc is imported with the editor settings."),
    theme: ThemePreferenceSchema.optional(),
  }),
);

export const DailyNotesSourceSchema = named(
  "DailyNotesSource",
  "Where the new vault's daily-note settings come from: Obsidian's config, Obsidian's defaults, or this vault's (Obsidian keeps no daily notes, or its format can't be read here).",
  z.enum(["obsidian", "obsidian_defaults", "daily_do_list"]),
);

export const CarryOverPlanSchema = named(
  "CarryOverPlan",
  "What happens to the current vault's notes, routines, drawings and agent history in the new vault.",
  z.looseObject({
    vault: FolderSchema.describe("The current vault: left untouched (it's the backup)."),
    dailyNotes: DailyNoteSettingsSchema.describe("The new vault's daily-note settings."),
    dailyNotesFrom: DailyNotesSourceSchema,
    notes: ImportMoveListSchema.describe(
      "Every other file: at the same path unless it collides (see `collisions`).",
    ),
    daily: z.looseObject({
      count: CountSchema,
      merged: CountSchema.describe("Dates Obsidian also has."),
      items: reportItems(
        z.looseObject({
          date: IsoDateSchema,
          from: ReportPathSchema,
          to: ReportPathSchema,
          merged: z
            .boolean()
            .describe(
              "Obsidian has a note for this date: it's kept and this one appended under `## From Daily Do List`.",
            ),
        }),
      ),
    }),
    collisions: ImportMoveListSchema.describe(
      "Files renamed because the Obsidian vault has one at that path: `Name (Daily Do List).md`.",
    ),
    routines: CountSchema,
    drawings: CountSchema,
    agent: z.looseObject({
      threads: CountSchema,
      detached: CountSchema.describe(
        "Threads whose task isn't in its note in the new vault: kept, marked detached.",
      ),
      records: CountSchema,
      approvals: CountSchema,
      routines: CountSchema,
      trackedNotes: CountSchema.describe("Daily notes whose task identities carry over."),
      journal: CountSchema.describe("Agent journal files, copied as they are."),
    }),
    watchedOpenTasks: CountSchema.describe(
      "Open tasks in Obsidian's daily notes inside the agent's watch window; the agent acts on them after the switch only when `actOnExistingTasks` is on.",
    ),
    actOnExistingTasks: z.boolean(),
    leftBehind: ImportPathListSchema.describe(
      "Files and folders of the current vault that stay behind: hidden ones (other than the sidecar and `.trash/`) and links leading out of it.",
    ),
  }),
);

export const ObsidianImportPreviewRequestSchema = named(
  "ObsidianImportPreviewRequest",
  "Body of `POST /api/import/obsidian/preview`.",
  z.strictObject({
    source: FolderInputSchema.describe(
      "The Obsidian vault's folder: absolute or `~/…`. Only ever read.",
    ),
  }),
);

export const ObsidianImportPreviewSchema = named(
  "ObsidianImportPreview",
  "What importing the Obsidian vault would do, computed without writing anything.",
  z.looseObject({
    source: FolderSchema.describe("The resolved source folder."),
    defaultDestination: FolderSchema.describe(
      "The suggested new vault: next to the current one, never inside the source.",
    ),
    isObsidianVault: z.boolean().describe("It has an `.obsidian/` folder."),
    files: CountSchema.describe("Everything copied, `.obsidian/` and attachments included."),
    bytes: CountSchema,
    notes: CountSchema.describe("Markdown notes outside hidden folders (drawings not included)."),
    folders: CountSchema,
    attachments: AttachmentSummarySchema,
    settings: ObsidianSettingsFoundSchema,
    templates: z.looseObject({
      folder: ReportPathSchema.nullable().describe(
        "Core Templates' folder, else Templater's; null when none is set.",
      ),
      count: CountSchema,
    }),
    plugins: z.array(ObsidianPluginSchema).describe("Enabled community plugins."),
    canvases: ImportPathListSchema.describe("Canvas files: copied, not viewable here yet."),
    drawings: ImportPathListSchema.describe("Excalidraw drawings (`*.excalidraw.md`)."),
    skipped: ImportSkippedListSchema,
    carryOver: CarryOverPlanSchema,
    warnings: z.array(z.string().min(1)).describe("Things to know first, one sentence each."),
  }),
);

// ── Jobs ─────────────────────────────────────────────────────────────────

export const ObsidianImportRequestSchema = named(
  "ObsidianImportRequest",
  "Body of `POST /api/import/obsidian`.",
  z.strictObject({
    source: FolderInputSchema.describe("The Obsidian vault's folder."),
    destination: FolderInputSchema.optional().describe(
      "A new or empty folder, never inside the source; default: the preview's `defaultDestination`.",
    ),
  }),
);

export const ObsidianImportResultSchema = named(
  "ObsidianImportResult",
  "What an import did.",
  z.looseObject({
    copied: z.looseObject({ files: CountSchema, bytes: CountSchema }),
    skipped: ImportSkippedListSchema,
    carryOver: CarryOverPlanSchema,
    manifest: ReportPathSchema.describe("The manifest (`.daily-do-list/import/obsidian.json`)."),
  }),
);

export const ObsidianUpdateReportSchema = named(
  "ObsidianUpdateReport",
  "What an update from Obsidian did. It never deletes.",
  z.looseObject({
    added: ImportPathListSchema.describe("New in Obsidian: copied."),
    updated: ImportPathListSchema.describe("Changed in Obsidian, unchanged here: replaced."),
    restored: ImportPathListSchema.describe(
      "Changed in Obsidian after being deleted here: written back.",
    ),
    conflicts: ImportMoveListSchema.describe(
      "Changed on both sides: `from` is kept, the Obsidian version saved as `to`.",
    ),
    deletedInSource: ImportPathListSchema.describe("Deleted in Obsidian: kept here."),
    unchanged: CountSchema,
    skipped: ImportSkippedListSchema,
  }),
);

export const ObsidianImportJobSchema = named(
  "ObsidianImportJob",
  "An import or update from Obsidian: its phase, progress and outcome.",
  z.looseObject({
    id: RuntimeIdSchema,
    kind: z.enum(["import", "update"]),
    state: z.enum(["running", "done", "failed", "cancelled"]),
    phase: z
      .enum(["checking", "copying", "carrying_over", "finishing"])
      .describe("The current phase, or the last one reached."),
    source: FolderSchema,
    destination: FolderSchema.describe(
      "The new vault (`import`), or the vault being updated (`update`).",
    ),
    startedAt: EpochMsSchema,
    finishedAt: EpochMsSchema.optional(),
    progress: z.looseObject({
      files: CountSchema,
      totalFiles: CountSchema,
      bytes: CountSchema,
      totalBytes: CountSchema,
    }),
    error: z.string().min(1).optional().describe("Why it failed."),
    result: ObsidianImportResultSchema.optional().describe("What an import did (`done`)."),
    update: ObsidianUpdateReportSchema.optional().describe("What an update did (`done`)."),
  }),
);

export const ObsidianImportJobResponseSchema = named(
  "ObsidianImportJobResponse",
  "A job, as it stands.",
  z.looseObject({ job: ObsidianImportJobSchema }),
);

export const ObsidianImportOriginSchema = named(
  "ObsidianImportOrigin",
  "Where the vault this daemon serves was imported from (its import manifest).",
  z.looseObject({
    source: FolderSchema.describe("The Obsidian vault it was copied from."),
    importedAt: EpochMsSchema,
    updatedAt: EpochMsSchema.optional().describe('The last "Update from Obsidian".'),
    previousVault: FolderSchema.optional().describe(
      "The vault that was current at the import, left untouched: the backup.",
    ),
  }),
);

export const ObsidianImportStatusResponseSchema = named(
  "ObsidianImportStatusResponse",
  "The running job, or the last one since the daemon started, and where this vault was imported from.",
  z.looseObject({
    job: ObsidianImportJobSchema.nullable().describe("null: none since the daemon started."),
    imported: ObsidianImportOriginSchema.optional().describe(
      "Set when this vault was imported from Obsidian (so it can be updated from there).",
    ),
  }),
);
