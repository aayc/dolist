/**
 * On-disk format of the approval broker's state: standing grants plus pending and recent
 * approvals, stored in the vault sidecar (schema in @ddl/contract). Parsing is defensive —
 * malformed entries are dropped, never trusted — because the file lives next to user-editable
 * notes; a malformed grant disappears rather than turning into a broader one.
 */
import {
  decodePersistedApprovals,
  encodePersistedApprovals,
  mergePersistedApprovals,
  PERSISTED_PATHS,
  type PersistedApprovals,
  PersistedFile,
  type PersistedStorage,
} from "@ddl/contract";
import type { ApprovalRequest, Logger } from "@ddl/core";
import { errorMessage, silentLogger } from "@ddl/core";
import type { ApprovalGrant } from "./types";

export const APPROVALS_STATE_PATH = PERSISTED_PATHS.approvals;
export const MAX_PERSISTED_DECIDED = 200;

export interface ApprovalState {
  version: 1;
  grants: ApprovalGrant[];
  approvals: ApprovalRequest[];
}

/** Returns undefined for unreadable files and files from a newer app; drops malformed entries. */
export function parseApprovalState(text: string): ApprovalState | undefined {
  const result = decodePersistedApprovals(text);
  return result.ok ? toState(result.value) : undefined;
}

/** Keeps every pending approval and the most recently decided ones. */
export function serializeApprovalState(
  grants: readonly ApprovalGrant[],
  approvals: readonly ApprovalRequest[],
): string {
  return encodePersistedApprovals(prune(grants, approvals));
}

export interface ApprovalStateFileOptions {
  storage: PersistedStorage;
  logger?: Logger;
  now?: () => number;
}

export interface ApprovalStateFile {
  /**
   * The persisted state, or undefined when there is none to use: missing, corrupt (moved to
   * `.daily-do-list/corrupt/`) or written by a newer app (left untouched; see `blocked`).
   */
  load(): Promise<ApprovalState | undefined>;
  /**
   * Writes the state unless the file is blocked. If another device changed the file meanwhile,
   * `onExternal` receives its content first (merge it, then `current` is read again). Never
   * throws: failures are logged and reported as "failed" (retry on the next change).
   */
  save(
    current: () => { grants: readonly ApprovalGrant[]; approvals: readonly ApprovalRequest[] },
    onExternal?: (theirs: ApprovalState) => void,
  ): Promise<"written" | "blocked" | "failed">;
  /** Why the file is never written this run, if so. */
  readonly blocked: string | null;
}

/**
 * approvals.json bound to a storage provider with the shared compatibility rules (corrupt files
 * are moved aside, newer ones are never overwritten, writes are conditional).
 */
export function createApprovalStateFile(options: ApprovalStateFileOptions): ApprovalStateFile {
  const logger = options.logger ?? silentLogger;
  const file = new PersistedFile({
    storage: options.storage,
    path: APPROVALS_STATE_PATH,
    decode: decodePersistedApprovals,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    get blocked() {
      return file.blocked;
    },
    async load() {
      try {
        const result = await file.load();
        return result.status === "loaded" ? toState(result.value) : undefined;
      } catch (error) {
        logger.warn("Failed to read approvals state", { error: errorMessage(error) });
        return undefined;
      }
    },
    async save(current, onExternal) {
      try {
        return await file.save(
          () => {
            const { grants, approvals } = current();
            return encodePersistedApprovals(prune(grants, approvals));
          },
          (theirs) => onExternal?.(toState(theirs)),
        );
      } catch (error) {
        logger.warn("Failed to persist approvals", { error: errorMessage(error) });
        return "failed";
      }
    },
  };
}

/** Union of both sides (see `mergePersistedApprovals`): a decided copy beats a pending one. */
export function mergeApprovalStates(ours: ApprovalState, theirs: ApprovalState): ApprovalState {
  return toState(mergePersistedApprovals(ours, theirs));
}

function prune(
  grants: readonly ApprovalGrant[],
  approvals: readonly ApprovalRequest[],
): PersistedApprovals {
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, MAX_PERSISTED_DECIDED);
  return {
    grants: [...grants],
    approvals: [...pending, ...decided].sort((a, b) => a.createdAt - b.createdAt),
  };
}

function toState(value: PersistedApprovals): ApprovalState {
  return { version: 1, grants: value.grants, approvals: value.approvals };
}
