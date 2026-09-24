/**
 * `.daily-do-list/state/records.json` — the agent badge state of every task (`TaskAgentRecord`)
 * plus the last subagent spec per task (so Retry survives restarts). Written by `TaskRecords`
 * (packages/agent/src/orchestrator/records.ts), compact JSON with a trailing newline.
 *
 * v1: `{ version, records, specs }`. The writer always wrote `version: 1`; the reader accepts the
 * same shape without it, as the pre-contract reader did.
 */
import { z } from "zod";
import {
  decodePersisted,
  isPersistedObject,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedDocument,
  type PersistedFormatSpec,
  PersistedListSchema,
  PersistedMapSchema,
  readEnvelope,
  salvageList,
  salvageRecord,
} from "./common";
import {
  PersistedCapabilitySchema,
  PersistedCountSchema,
  PersistedIdSchema,
  PersistedIsoDateSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";

export const PERSISTED_RECORDS_VERSION = 1;

export const PersistedTaskAgentRecordSchema = z.object({
  taskId: PersistedIdSchema,
  notePath: z.string().min(1),
  date: PersistedIsoDateSchema.nullable(),
  text: z.string(),
  line: PersistedCountSchema,
  status: PersistedTaskAgentStatusSchema,
  summary: z.string().optional(),
  threadId: z.string().nullable(),
  updatedAt: PersistedTimestampSchema,
  unread: PersistedCountSchema,
  /** The record belongs to a non-task line the orchestrator anchored a thread to. */
  anchor: z.literal("line").optional(),
});
export type PersistedTaskAgentRecord = z.infer<typeof PersistedTaskAgentRecordSchema>;

export const PersistedSubagentSpecSchema = z.object({
  taskId: PersistedIdSchema,
  goal: z.string(),
  instructions: z.string().optional(),
  capabilities: z.array(PersistedCapabilitySchema),
});
export type PersistedSubagentSpec = z.infer<typeof PersistedSubagentSpecSchema>;

export const PersistedRecordsFileSchema = z.object({
  version: z.literal(PERSISTED_RECORDS_VERSION),
  records: z.array(PersistedTaskAgentRecordSchema),
  /** Keyed by task id (equal to the spec's own `taskId`). */
  specs: z.record(z.string(), PersistedSubagentSpecSchema),
});
export type PersistedRecordsFile = z.infer<typeof PersistedRecordsFileSchema>;
export type PersistedRecords = Omit<PersistedRecordsFile, "version">;

const RecordsEnvelopeSchema = z.object({ records: PersistedListSchema, specs: PersistedMapSchema });

const recordsSpec: PersistedFormatSpec<PersistedRecords> = {
  version: PERSISTED_RECORDS_VERSION,
  // Defaults the pre-contract reader applied to entries of files without `version`.
  migrateUnversioned: (doc: PersistedDocument) => ({
    ...doc,
    version: 1,
    records: Array.isArray(doc.records)
      ? doc.records.map((entry) =>
          isPersistedObject(entry)
            ? {
                ...entry,
                date: typeof entry.date === "string" ? entry.date : null,
                threadId: typeof entry.threadId === "string" ? entry.threadId : null,
                unread: typeof entry.unread === "number" ? entry.unread : 0,
              }
            : entry,
        )
      : doc.records,
    specs: isPersistedObject(doc.specs) ? doc.specs : {},
  }),
  read(doc, issues) {
    const envelope = readEnvelope(RecordsEnvelopeSchema, doc);
    if (envelope instanceof PersistedCorruption) return envelope;
    return {
      records: salvageList(
        envelope.records,
        PersistedTaskAgentRecordSchema,
        "records",
        issues,
        (r) => r.taskId,
      ),
      specs: salvageRecord(
        envelope.specs,
        PersistedSubagentSpecSchema,
        "specs",
        issues,
        (taskId, spec) => spec.taskId === taskId,
      ),
    };
  },
};

export function decodePersistedRecords(text: string): PersistedDecodeResult<PersistedRecords> {
  return decodePersisted(recordsSpec, text);
}

export function encodePersistedRecords(state: PersistedRecords): string {
  const file: PersistedRecordsFile = {
    version: PERSISTED_RECORDS_VERSION,
    records: state.records,
    specs: state.specs,
  };
  return `${JSON.stringify(file)}\n`;
}

/**
 * Union by task id: a record from `theirs` replaces ours only when it was updated later; specs
 * only in `theirs` are added. Deletions are not tracked, so a record removed on one side can come
 * back from the other (harmless: records of tasks that no longer exist are never shown).
 */
export function mergePersistedRecords(
  ours: PersistedRecords,
  theirs: PersistedRecords,
): PersistedRecords {
  const records = new Map(ours.records.map((record) => [record.taskId, record]));
  for (const record of theirs.records) {
    const mine = records.get(record.taskId);
    if (!mine || record.updatedAt > mine.updatedAt) records.set(record.taskId, record);
  }
  return { records: [...records.values()], specs: { ...theirs.specs, ...ours.specs } };
}
