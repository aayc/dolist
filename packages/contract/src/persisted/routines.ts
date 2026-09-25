/**
 * `.daily-do-list/state/routines.json` — the scheduler's state for every routine: its next run,
 * its last run (with a compact result the next run starts from) and its recent runs. Written by
 * the routine store (packages/agent/src/routines/state.ts), compact JSON with a trailing newline.
 * The routine files in `Routines/` hold the definitions; this file never holds settings.
 *
 * v1: `{ version, routines: { <routineId>: state } }`. A file without `version` is read the same.
 */
import { z } from "zod";
import {
  decodePersisted,
  isPersistedObject,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedDocument,
  type PersistedFormatSpec,
  PersistedMapSchema,
  readEnvelope,
  salvageRecord,
} from "./common";
import {
  PersistedCountSchema,
  PersistedIdSchema,
  PersistedIsoDateSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";

export const PERSISTED_ROUTINES_VERSION = 1;

/** Runs kept per routine (their threads stay in `threads/` either way). */
export const PERSISTED_ROUTINE_RUNS_KEPT = 100;

export const PersistedRoutineRunSchema = z.object({
  /** The run's task id (`run_…`): its record and subagent. */
  runId: PersistedIdSchema,
  threadId: PersistedIdSchema,
  trigger: z.enum(["schedule", "catch_up", "manual"]),
  status: PersistedTaskAgentStatusSchema,
  startedAt: PersistedTimestampSchema,
  finishedAt: PersistedTimestampSchema.optional(),
  /** Badge text. */
  summary: z.string().optional(),
  /** What the run reported, shortened: the next run starts from it. */
  result: z.string().optional(),
  changed: z.boolean().optional(),
  /** The finished run was announced (or deliberately not): never twice. */
  notified: z.boolean().optional(),
});
export type PersistedRoutineRun = z.infer<typeof PersistedRoutineRunSchema>;

export const PersistedRoutineStateSchema = z.object({
  /** The file it was last seen at. */
  path: z.string().min(1),
  /** The schedule phrase `nextRunAt` was computed from; a different one means reschedule. */
  scheduleKey: z.string().nullable(),
  /** Null: not scheduled (paused, invalid, never seen enabled). In the past: a missed run. */
  nextRunAt: PersistedTimestampSchema.nullable(),
  lastRun: PersistedRoutineRunSchema.optional(),
  /** Thread ids of its runs, newest first (writers keep `PERSISTED_ROUTINE_RUNS_KEPT`). */
  runs: z.array(PersistedIdSchema),
  /** Runs beyond the schedule on that local day (the daily budget). */
  extraRuns: z.object({ date: PersistedIsoDateSchema, count: PersistedCountSchema }).optional(),
  updatedAt: PersistedTimestampSchema,
});
export type PersistedRoutineState = z.infer<typeof PersistedRoutineStateSchema>;

export const PersistedRoutinesFileSchema = z.object({
  version: z.literal(PERSISTED_ROUTINES_VERSION),
  routines: z.record(z.string(), PersistedRoutineStateSchema),
});
export type PersistedRoutinesFile = z.infer<typeof PersistedRoutinesFileSchema>;
export type PersistedRoutines = Omit<PersistedRoutinesFile, "version">;

const RoutinesEnvelopeSchema = z.object({ routines: PersistedMapSchema });

const routinesSpec: PersistedFormatSpec<PersistedRoutines> = {
  version: PERSISTED_ROUTINES_VERSION,
  migrateUnversioned: (doc: PersistedDocument) => ({
    ...doc,
    version: 1,
    routines: isPersistedObject(doc.routines) ? doc.routines : {},
  }),
  read(doc, issues) {
    const envelope = readEnvelope(RoutinesEnvelopeSchema, doc);
    if (envelope instanceof PersistedCorruption) return envelope;
    return {
      routines: salvageRecord(envelope.routines, PersistedRoutineStateSchema, "routines", issues),
    };
  },
};

export function decodePersistedRoutines(text: string): PersistedDecodeResult<PersistedRoutines> {
  return decodePersisted(routinesSpec, text);
}

export function encodePersistedRoutines(state: PersistedRoutines): string {
  const file: PersistedRoutinesFile = {
    version: PERSISTED_ROUTINES_VERSION,
    routines: state.routines,
  };
  return `${JSON.stringify(file)}\n`;
}

/**
 * Union by routine id: a routine's state from `theirs` replaces ours only when it was updated
 * later (another device ran it more recently). Deleted routines' state is harmless leftover.
 */
export function mergePersistedRoutines(
  ours: PersistedRoutines,
  theirs: PersistedRoutines,
): PersistedRoutines {
  const routines = { ...ours.routines };
  for (const [id, state] of Object.entries(theirs.routines)) {
    const mine = routines[id];
    if (!mine || state.updatedAt > mine.updatedAt) routines[id] = state;
  }
  return { routines };
}
