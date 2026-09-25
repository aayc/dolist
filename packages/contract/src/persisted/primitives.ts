/**
 * Building blocks of the persisted formats. They are defined independently of the wire schemas on
 * purpose: files on disk outlive protocol versions, so they evolve (and are versioned) separately.
 * Readers are lenient where it costs nothing (any finite timestamp) and strict where data drives
 * behavior (enums, ids used in file paths).
 */
import { SIDECAR_DIR } from "@ddl/core";
import { z } from "zod";

/** Every sidecar location the app persists to, relative to the vault root. */
export const PERSISTED_PATHS = {
  sidecar: SIDECAR_DIR,
  threads: `${SIDECAR_DIR}/threads`,
  artifacts: `${SIDECAR_DIR}/artifacts`,
  taskState: `${SIDECAR_DIR}/state/tasks`,
  records: `${SIDECAR_DIR}/state/records.json`,
  approvals: `${SIDECAR_DIR}/state/approvals.json`,
  routines: `${SIDECAR_DIR}/state/routines.json`,
  /** Append-only journals (`*.jsonl`): the SyncEngine merges them as a union of lines. */
  journal: `${SIDECAR_DIR}/state/journal`,
  threadJournals: `${SIDECAR_DIR}/state/journal/threads`,
  settings: `${SIDECAR_DIR}/settings.json`,
  /** Unreadable files are moved here, and originals of repaired files are copied here. */
  corrupt: `${SIDECAR_DIR}/corrupt`,
  /** Owned by @ddl/storage's SyncEngine (machine-local, never synced). */
  sync: `${SIDECAR_DIR}/sync`,
} as const;

/** Epoch milliseconds. Any finite number is accepted on read; writers produce integers. */
export const PersistedTimestampSchema = z.number();
/** Non-negative integer: 0-based line numbers, byte sizes, unread counters. */
export const PersistedCountSchema = z.int().min(0);
export const PersistedIdSchema = z.string().min(1);
/**
 * Ids that become file or folder names (thread ids: `threads/<id>.json`, `artifacts/<id>/`). The
 * pattern rules out separators and dot segments, so a crafted file cannot redirect writes.
 */
export const PERSISTED_FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const PersistedFileIdSchema = z.string().regex(PERSISTED_FILE_ID_PATTERN);
/** Local calendar date `YYYY-MM-DD`. */
export const PersistedIsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PersistedTaskAgentStatusSchema = z.enum([
  "idle",
  "triaging",
  "queued",
  "working",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
  "ignored",
]);

/** Checkbox state of a markdown task. */
export const PersistedTaskStatusSchema = z.enum([
  "open",
  "done",
  "in_progress",
  "cancelled",
  "deferred",
  "other",
]);

export const PersistedRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const PersistedActionCategorySchema = z.enum([
  "read",
  "compute",
  "network",
  "file_write",
  "browser_input",
  "form_submission",
  "computer_control",
  "communication",
  "publishing",
  "payment",
  "booking",
  "account",
  "credentials",
  "privacy",
  "destructive",
  "system",
  "unknown",
]);

export const PersistedApprovalScopeSchema = z.enum(["once", "task", "always"]);
export const PersistedApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export const PersistedArtifactKindSchema = z.enum([
  "markdown",
  "code",
  "html",
  "image",
  "json",
  "text",
  "file",
]);
export const PersistedSurfaceKindSchema = z.enum(["browser", "computer"]);
/** What a subagent may use (`SubagentSpec.capabilities`). */
export const PersistedCapabilitySchema = z.enum([
  "web",
  "browser",
  "computer",
  "shell",
  "files",
  "connectors",
]);

/**
 * `.daily-do-list/corrupt/<path inside the sidecar>` with a UTC timestamp before the extension:
 * `threads/thr_a.json` → `corrupt/threads/thr_a.20260923T215800123Z.json`. `attempt` > 1 adds a
 * counter for collisions within the same millisecond.
 */
export function persistedQuarantinePath(path: string, at: Date, attempt = 1): string {
  const inside = path.startsWith(`${SIDECAR_DIR}/`) ? path.slice(SIDECAR_DIR.length + 1) : path;
  const slash = inside.lastIndexOf("/");
  const folder = slash === -1 ? "" : inside.slice(0, slash + 1);
  const name = inside.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = at.toISOString().replace(/[-:.]/g, "");
  const counter = attempt > 1 ? `-${attempt}` : "";
  return `${PERSISTED_PATHS.corrupt}/${folder}${stem}.${stamp}${counter}${ext}`;
}
