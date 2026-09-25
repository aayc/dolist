export { conflictCopyPath, isConflictCopyPath } from "./conflict-path";
export { decideSync, type SyncDecision } from "./decide";
export {
  type DiffHunk,
  type DiffOptions,
  diff3Regions,
  diffLines,
  type MergeLinesResult,
  type MergeOptions,
  type MergeRegion,
  type MergeTextResult,
  mergeLines,
  mergeText,
} from "./diff3";
export {
  disabledSyncStatus,
  SyncAbortedError,
  SyncEngine,
  type SyncEngineOptions,
  type SyncStartOptions,
} from "./engine";
export { SYNC_STATE_DIR, snapshotPath } from "./snapshot";
