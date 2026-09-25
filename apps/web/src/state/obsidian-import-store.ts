import type {
  ObsidianImportJob,
  ObsidianImportOrigin,
  ObsidianImportStatusResponse,
} from "@ddl/core";
import { create } from "zustand";

export interface ObsidianImportState {
  /** The running import or update, or the last one this page saw since the daemon started. */
  job: ObsidianImportJob | null;
  /** Where the vault was imported from; null when it wasn't (or before the first answer). */
  imported: ObsidianImportOrigin | null;
}

export const useObsidianImportStore = create<ObsidianImportState>(() => ({
  job: null,
  imported: null,
}));

/** A snapshot of the same job that ended wins over a late "running" one (an answer in flight). */
export function laterJob(
  current: ObsidianImportJob | null,
  next: ObsidianImportJob | null,
): ObsidianImportJob | null {
  if (!current || !next || current.id !== next.id) return next;
  return current.state !== "running" && next.state === "running" ? current : next;
}

/** An `import.progress` event. */
export function applyImportJob(job: ObsidianImportJob): void {
  useObsidianImportStore.setState((s) => ({ job: laterJob(s.job, job) }));
}

/** `GET /api/import/obsidian`. */
export function applyImportStatus(status: ObsidianImportStatusResponse): void {
  useObsidianImportStore.setState((s) => ({
    job: laterJob(s.job, status.job),
    imported: status.imported ?? null,
  }));
}
