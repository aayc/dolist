import type {
  AttachmentSummary,
  AttachmentType,
  DailyNoteSettings,
  ImportSkipReason,
  ObsidianEditorSettings,
  ObsidianImportJob,
  ObsidianImportPhase,
  ObsidianPluginSupport,
} from "@ddl/core";
import { HttpError, NetworkError } from "../../api/errors";
import { formatBytes, pluralize } from "../../lib/format";

export const PHASE_LABEL: Record<ObsidianImportPhase, string> = {
  checking: "Reading the vault…",
  copying: "Copying files…",
  carrying_over: "Carrying over your notes…",
  finishing: "Finishing…",
};

/** 0–1: files copied so far (a job that's done is full). */
export function progressFraction(job: ObsidianImportJob): number {
  if (job.state === "done") return 1;
  const { files, totalFiles } = job.progress;
  return totalFiles > 0 ? Math.min(1, files / totalFiles) : 0;
}

/** "12 of 64 files · 1.2 MB of 3.5 MB"; empty before the totals are known. */
export function progressText(job: ObsidianImportJob): string {
  const { files, totalFiles, bytes, totalBytes } = job.progress;
  if (totalFiles === 0) return "";
  return `${files} of ${pluralize(totalFiles, "file")} · ${formatBytes(bytes)} of ${formatBytes(totalBytes)}`;
}

export const SUPPORT: Record<ObsidianPluginSupport, { label: string; tone: string }> = {
  supported: { label: "Works here", tone: "success" },
  partial: { label: "Partly", tone: "warning" },
  unsupported: { label: "Doesn't run", tone: "faint" },
  unknown: { label: "Doesn't run", tone: "faint" },
};

export const SKIP_REASON: Record<ImportSkipReason, string> = {
  symlink_outside: "a link to something outside the vault",
  symlink_folder: "a link to a folder in the vault, copied where it is",
  special_file: "not a regular file",
  unreadable: "can't be read",
  sidecar: "Daily Do List's own folder: your current agent history replaces it",
};

const TYPE_NOUN: Record<AttachmentType, [string, string]> = {
  image: ["image", "images"],
  pdf: ["PDF", "PDFs"],
  audio: ["audio file", "audio files"],
  video: ["video", "videos"],
  other: ["other file", "other files"],
};

/** "11 images, 2 PDFs and 1 other file". */
export function attachmentKinds(attachments: AttachmentSummary): string {
  const parts = attachments.byType.map(({ type, count }) => {
    const [one, many] = TYPE_NOUN[type] ?? TYPE_NOUN.other;
    return pluralize(count, one, many);
  });
  return joinWords(parts);
}

/** "a, b and c". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Where daily notes go and how they're named: "Journal/Daily, named YYYY/MM/YYYY-MM-DD". */
export function dailyPlaceText(daily: DailyNoteSettings): string {
  return `${daily.folder ? daily.folder : "the vault's top folder"}, named ${daily.format}`;
}

/** `dailyPlaceText` and the template new ones start from. */
export function dailyNotesText(daily: DailyNoteSettings): string {
  const template = daily.template ? `, from the template ${daily.template}` : "";
  return `${dailyPlaceText(daily)}${template}`;
}

/** The editor preferences Obsidian had: ["vim mode on", "line numbers off", …]. */
export function editorSettingsText(editor: ObsidianEditorSettings, vimrc: boolean): string[] {
  const names: Array<[keyof ObsidianEditorSettings, string]> = [
    ["vimMode", "vim mode"],
    ["livePreview", "live preview"],
    ["readableLineLength", "readable line length"],
    ["showLineNumbers", "line numbers"],
    ["spellcheck", "spellcheck"],
  ];
  const parts = names
    .filter(([key]) => editor[key] !== undefined)
    .map(([key, name]) => `${name} ${editor[key] ? "on" : "off"}`);
  if (vimrc) parts.push("the vimrc");
  return parts;
}

export function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export interface ImportProblem {
  message: string;
  /** The daemon's error code (`locked_by_env`, `conflict`, `forbidden_device`, …). */
  code?: string;
  status?: number;
}

export const PAIRED_DEVICE_REASON =
  "Only the Mac that runs Daily Do List can import vaults or switch them, not a paired device.";

/** What went wrong, in words for the user (the daemon's messages already are). */
export function importProblem(error: unknown): ImportProblem {
  if (error instanceof NetworkError) {
    return { message: "Daily Do List didn't answer. Check that it's running, then try again." };
  }
  if (error instanceof HttpError) {
    const body = error.body as { error?: unknown } | undefined;
    const code = typeof body?.error === "string" ? body.error : undefined;
    const message = code === "forbidden_device" ? PAIRED_DEVICE_REASON : error.message;
    return { message, status: error.status, ...(code ? { code } : {}) };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
