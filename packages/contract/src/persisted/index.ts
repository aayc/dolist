/**
 * Persisted sidecar file schemas (.daily-do-list/**): one zod schema per format with an explicit
 * integer `version`, lenient decoders with migrations from older versions, exact encoders, merge
 * rules, and `PersistedFile`, which applies the shared compatibility rules (read old, never
 * overwrite newer, quarantine corrupt). Every export is prefixed `Persisted`/`PERSISTED_` so it
 * never collides with the wire schemas in the same barrel. See docs/DATA_FORMATS.md.
 */
export {
  decodePersistedApprovals,
  encodePersistedApprovals,
  mergePersistedApprovals,
  PERSISTED_APPROVALS_VERSION,
  type PersistedApprovalGrant,
  PersistedApprovalGrantSchema,
  type PersistedApprovalRequest,
  PersistedApprovalRequestSchema,
  type PersistedApprovals,
  type PersistedApprovalsFile,
  PersistedApprovalsFileSchema,
} from "./approvals";
export {
  isPersistedArtifactPath,
  normalizePersistedBase64,
  PERSISTED_BINARY_ARTIFACT_SUFFIX,
} from "./artifact";
export {
  decodePersisted,
  isPersistedObject,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedDocument,
  type PersistedFormatSpec,
  type PersistedIssue,
  type PersistedJsonResult,
  parsePersistedJson,
} from "./common";
export {
  PersistedFile,
  type PersistedFileOptions,
  type PersistedLoadResult,
  type PersistedSaveResult,
  type PersistedStorage,
  PersistedWriteConflictError,
} from "./file";
export {
  decodePersistedImportManifest,
  encodePersistedImportManifest,
  PERSISTED_IMPORT_MANIFEST_VERSION,
  type PersistedImportFile,
  PersistedImportFileSchema,
  type PersistedImportManifest,
  type PersistedImportManifestFile,
  PersistedImportManifestFileSchema,
} from "./import-manifest";
export {
  PERSISTED_FILE_ID_PATTERN,
  PERSISTED_PATHS,
  PersistedActionCategorySchema,
  PersistedApprovalScopeSchema,
  PersistedApprovalStatusSchema,
  PersistedArtifactKindSchema,
  PersistedCapabilitySchema,
  PersistedCountSchema,
  PersistedFileIdSchema,
  PersistedIdSchema,
  PersistedIsoDateSchema,
  PersistedRiskLevelSchema,
  PersistedSurfaceKindSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTaskStatusSchema,
  PersistedTimestampSchema,
  persistedQuarantinePath,
} from "./primitives";
export {
  decodePersistedRecords,
  encodePersistedRecords,
  mergePersistedRecords,
  PERSISTED_RECORDS_VERSION,
  type PersistedRecords,
  type PersistedRecordsFile,
  PersistedRecordsFileSchema,
  type PersistedSubagentSpec,
  PersistedSubagentSpecSchema,
  type PersistedTaskAgentRecord,
  PersistedTaskAgentRecordSchema,
} from "./records";
export {
  PERSISTED_FORMATS,
  type PersistedFormatInfo,
  type PersistedFormatName,
} from "./registry";
export {
  decodePersistedRoutines,
  encodePersistedRoutines,
  mergePersistedRoutines,
  PERSISTED_ROUTINE_RUNS_KEPT,
  PERSISTED_ROUTINES_VERSION,
  type PersistedRoutineRun,
  PersistedRoutineRunSchema,
  type PersistedRoutineState,
  PersistedRoutineStateSchema,
  type PersistedRoutines,
  type PersistedRoutinesFile,
  PersistedRoutinesFileSchema,
} from "./routines";
export {
  decodePersistedSettings,
  encodePersistedSettings,
  PERSISTED_SETTINGS_VERSION,
  type PersistedSettingsDocument,
  PersistedSettingsFileSchema,
  type PersistedSettingsOverrides,
  PersistedSettingsOverridesSchema,
  type PersistedSettingsResolution,
  resolvePersistedSettings,
} from "./settings";
export {
  decodePersistedTaskState,
  encodePersistedTaskState,
  PERSISTED_TASK_STATE_VERSION,
  type PersistedSettledTask,
  PersistedSettledTaskSchema,
  type PersistedTaskState,
  type PersistedTaskStateFile,
  PersistedTaskStateFileSchema,
  type PersistedTrackedTask,
  PersistedTrackedTaskSchema,
} from "./task-state";
export {
  decodePersistedThread,
  encodePersistedThread,
  finishInterruptedPersistedMessage,
  mergePersistedThreads,
  PERSISTED_THREAD_VERSION,
  type PersistedArtifactMeta,
  PersistedArtifactMetaSchema,
  type PersistedCitedSource,
  PersistedCitedSourceSchema,
  PersistedMessageAuthorSchema,
  type PersistedThread,
  type PersistedThreadFile,
  PersistedThreadFileSchema,
  type PersistedThreadMessage,
  PersistedThreadMessageSchema,
  persistedThreadIdFromPath,
  readPersistedThreadObject,
} from "./thread";
export {
  comparePersistedJournalEvents,
  decodePersistedJournalLine,
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  PERSISTED_THREAD_JOURNAL_VERSION,
  type PersistedJournalAllowedVia,
  PersistedJournalAllowedViaSchema,
  type PersistedJournalEvent,
  type PersistedJournalLineResult,
  type PersistedJournalPayload,
  type PersistedJournalRead,
  PersistedJournalThreadHeaderSchema,
  persistedThreadIdFromJournalPath,
  persistedThreadImportEvent,
  persistedThreadJournalPath,
} from "./thread-journal";
