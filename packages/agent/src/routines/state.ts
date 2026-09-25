import {
  decodePersistedRoutines,
  encodePersistedRoutines,
  mergePersistedRoutines,
  PERSISTED_PATHS,
  PERSISTED_ROUTINE_RUNS_KEPT,
  PersistedFile,
  type PersistedRoutineRun,
  type PersistedRoutineState,
  type PersistedRoutines,
} from "@ddl/contract";
import { Emitter, type Logger, silentLogger, type Unsubscribe } from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";

export const ROUTINES_STATE_PATH = PERSISTED_PATHS.routines;

export type RoutineState = PersistedRoutineState;
export type RoutineRunState = PersistedRoutineRun;

const SAVE_RETRY_MS = 5_000;

export interface RoutineStateStoreOptions {
  storage: StorageProvider;
  now?: () => number;
  logger?: Logger;
  flushDelayMs?: number;
  /** Never writes (a device that doesn't run the agent only shows what the other one wrote). */
  readOnly?: boolean;
}

type StateEvents = { changed: undefined };

/**
 * The scheduler's state per routine — next run, last run and its compact result, recent runs,
 * today's extra runs — persisted to `.daily-do-list/state/routines.json` (format in
 * @ddl/contract). Never anything the user sets: that lives in the routine files.
 */
export class RoutineStateStore {
  private readonly file: PersistedFile<PersistedRoutines>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly flushDelayMs: number;
  private readonly readOnly: boolean;
  private readonly states = new Map<string, RoutineState>();
  private readonly emitter = new Emitter<StateEvents>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(options: RoutineStateStoreOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.flushDelayMs = options.flushDelayMs ?? 300;
    this.readOnly = options.readOnly ?? false;
    this.file = new PersistedFile({
      storage: options.storage,
      path: ROUTINES_STATE_PATH,
      decode: decodePersistedRoutines,
      logger: this.logger,
      now: this.now,
    });
  }

  /** A corrupt file is moved aside and state starts empty; a newer app's file is never written. */
  async load(): Promise<void> {
    let result: Awaited<ReturnType<PersistedFile<PersistedRoutines>["load"]>>;
    try {
      result = await this.file.load();
    } catch (error) {
      this.logger.warn("Failed to read routine state", { error: errorText(error) });
      return;
    }
    if (result.status !== "loaded") return;
    let changed = false;
    for (const [id, state] of Object.entries(result.value.routines)) {
      const mine = this.states.get(id);
      if (mine && mine.updatedAt >= state.updatedAt) continue;
      this.states.set(id, { ...state, runs: state.runs.slice(0, PERSISTED_ROUTINE_RUNS_KEPT) });
      changed = true;
    }
    if (changed) this.emitter.emit("changed", undefined);
  }

  on(listener: () => void): Unsubscribe {
    return this.emitter.on("changed", listener);
  }

  get(id: string): RoutineState | undefined {
    const state = this.states.get(id);
    return state ? structuredClone(state) : undefined;
  }

  /** Creates or changes a routine's state; `patch` sees the current state (or a blank one). */
  update(
    id: string,
    path: string,
    patch: (state: RoutineState) => Partial<RoutineState>,
  ): RoutineState {
    const current = this.states.get(id) ?? {
      path,
      scheduleKey: null,
      nextRunAt: null,
      runs: [],
      updatedAt: this.now(),
    };
    const next: RoutineState = {
      ...current,
      ...patch(structuredClone(current)),
      path,
      updatedAt: this.now(),
    };
    next.runs = next.runs.slice(0, PERSISTED_ROUTINE_RUNS_KEPT);
    this.states.set(id, next);
    this.dirty = true;
    this.scheduleSave();
    this.emitter.emit("changed", undefined);
    return structuredClone(next);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private scheduleSave(delayMs = this.flushDelayMs): void {
    if (this.readOnly || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, delayMs);
    this.saveTimer.unref?.();
  }

  /** Saves are serialized and never reject; a failed write is retried later. */
  private save(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.file.save(
          () => encodePersistedRoutines(this.snapshot()),
          (theirs) => this.mergeExternal(theirs),
        );
      } catch (error) {
        this.dirty = true;
        this.logger.warn("Failed to persist routine state; will retry", {
          error: errorText(error),
        });
        this.scheduleSave(SAVE_RETRY_MS);
      }
    });
    return this.saving;
  }

  private snapshot(): PersistedRoutines {
    return { routines: Object.fromEntries(this.states) };
  }

  /** Another device wrote the file meanwhile: keep each routine's most recent state. */
  private mergeExternal(theirs: PersistedRoutines): void {
    const merged = mergePersistedRoutines(this.snapshot(), theirs);
    for (const [id, state] of Object.entries(merged.routines)) this.states.set(id, state);
    this.emitter.emit("changed", undefined);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
