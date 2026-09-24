/**
 * `.daily-do-list/state/tasks/<hash(notePath)>.json` — the task watcher's identity tracking for one
 * daily note: the tracked tasks (stable ids across edits) and the snapshot each task last settled
 * at. Written by `TaskWatcher` (packages/agent/src/orchestrator/task-watcher.ts), compact JSON.
 * Machine-local scratch data: the SyncEngine never syncs it (a vault inside a synced folder will
 * still carry it along).
 *
 * v1: the only version so far (the writer always wrote `version: 1`).
 */
import { z } from "zod";
import {
  decodePersisted,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedFormatSpec,
  PersistedListSchema,
  PersistedMapSchema,
  readEnvelope,
  salvageList,
  salvageRecord,
} from "./common";
import {
  PersistedCountSchema,
  PersistedIdSchema,
  PersistedTaskStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";

export const PERSISTED_TASK_STATE_VERSION = 1;

export const PersistedTrackedTaskSchema = z.object({
  id: PersistedIdSchema,
  text: z.string(),
  status: PersistedTaskStatusSchema,
  line: PersistedCountSchema,
  depth: PersistedCountSchema,
  parentId: z.string().nullable(),
  notes: z.array(z.string()),
  firstSeenAt: PersistedTimestampSchema,
  updatedAt: PersistedTimestampSchema,
});
export type PersistedTrackedTask = z.infer<typeof PersistedTrackedTaskSchema>;

export const PersistedSettledTaskSchema = z.object({
  /** The task as of its last settled event: the baseline for the next one. */
  task: PersistedTrackedTaskSchema,
  /** The orchestrator was told about this task. */
  announced: z.boolean(),
});
export type PersistedSettledTask = z.infer<typeof PersistedSettledTaskSchema>;

export const PersistedTaskStateFileSchema = z.object({
  version: z.literal(PERSISTED_TASK_STATE_VERSION),
  /** The note this state belongs to (the file name is only its hash). */
  notePath: z.string().min(1),
  /** Storage version of the note at the last parse. */
  contentVersion: z.string().nullable(),
  tasks: z.array(PersistedTrackedTaskSchema),
  /** Keyed by task id (equal to `task.id`). */
  settled: z.record(z.string(), PersistedSettledTaskSchema),
});
export type PersistedTaskStateFile = z.infer<typeof PersistedTaskStateFileSchema>;
export type PersistedTaskState = Omit<PersistedTaskStateFile, "version">;

const TaskStateEnvelopeSchema = z.object({
  notePath: z.string().min(1),
  contentVersion: z.string().nullable(),
  tasks: PersistedListSchema,
  settled: PersistedMapSchema,
});

function taskStateSpec(expectedNotePath?: string): PersistedFormatSpec<PersistedTaskState> {
  return {
    version: PERSISTED_TASK_STATE_VERSION,
    migrateUnversioned: (doc) => ({ ...doc, version: 1 }),
    read(doc, issues) {
      const envelope = readEnvelope(TaskStateEnvelopeSchema, doc);
      if (envelope instanceof PersistedCorruption) return envelope;
      if (expectedNotePath !== undefined && envelope.notePath !== expectedNotePath) {
        return new PersistedCorruption("tracker state belongs to a different note");
      }
      return {
        notePath: envelope.notePath,
        contentVersion: envelope.contentVersion,
        tasks: salvageList(
          envelope.tasks,
          PersistedTrackedTaskSchema,
          "tasks",
          issues,
          (t) => t.id,
        ),
        settled: salvageRecord(
          envelope.settled,
          PersistedSettledTaskSchema,
          "settled",
          issues,
          (taskId, snapshot) => snapshot.task.id === taskId,
        ),
      };
    },
  };
}

/** With `expectedNotePath`, state recorded for another note counts as corrupt for this slot. */
export function decodePersistedTaskState(
  text: string,
  expectedNotePath?: string,
): PersistedDecodeResult<PersistedTaskState> {
  return decodePersisted(taskStateSpec(expectedNotePath), text);
}

export function encodePersistedTaskState(state: PersistedTaskState): string {
  const file: PersistedTaskStateFile = {
    version: PERSISTED_TASK_STATE_VERSION,
    notePath: state.notePath,
    contentVersion: state.contentVersion,
    tasks: state.tasks,
    settled: state.settled,
  };
  return `${JSON.stringify(file)}\n`;
}
