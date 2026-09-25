/**
 * A routine scheduler over real parts (library, thread store, task records, board) on an in-memory
 * vault, with fake subagents and a manual clock in Los Angeles time. Nothing waits on real time:
 * tests move `clock.now` and tick (or advance fake timers).
 */
import {
  type RoutineNotification,
  type TaskAgentStatus,
  type Thread,
  timeZoneCalendar,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import type { Capability } from "../execution/types";
import { TaskRecords } from "../orchestrator/records";
import type { SpawnResult, SubagentManager } from "../orchestrator/subagents";
import { TaskBoard } from "../orchestrator/task-board";
import type { TaskLookup } from "../orchestrator/task-watcher";
import type { SubagentSpec } from "../orchestrator/types";
import { createThreadStore } from "../threads/store";
import type { ThreadStore } from "../threads/types";
import type { RoutineDefinition } from "./catalog";
import { RoutineLibrary } from "./library";
import { type RoutineRunTriage, RoutineScheduler } from "./scheduler";
import type { RoutineState } from "./state";

export const LA = timeZoneCalendar("America/Los_Angeles");

/** Epoch ms of a wall-clock time in Los Angeles in September 2026 (the 23rd is a Wednesday). */
export function sept(day: number, hour: number, minute = 0): number {
  return LA.at(2026, 9, day, hour * 60 + minute);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** A routine file with these frontmatter lines (`key: value`) and instructions. */
export function routineFile(
  frontmatter: Record<string, string>,
  instructions = "Check the price of the blue kettle.",
): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  return ["---", ...lines, "---", instructions, ""].join("\n");
}

const NO_TASKS: TaskLookup = {
  findTask: () => undefined,
  getTasks: () => [],
  getContent: () => null,
};

/** Just what the scheduler uses of the SubagentManager; a run works until the test finishes it. */
export class FakeSubagents {
  readonly spawned: SubagentSpec[] = [];
  readonly cancelled: Array<{ taskId: string; reason: string }> = [];
  failSpawn: Error | undefined;
  private readonly working = new Set<string>();
  private readonly board: TaskBoard;

  constructor(board: TaskBoard) {
    this.board = board;
  }

  async spawn(spec: SubagentSpec): Promise<SpawnResult> {
    if (this.failSpawn) throw this.failSpawn;
    this.spawned.push(spec);
    this.working.add(spec.taskId);
    return { threadId: "", status: "working", resumed: false };
  }

  async cancel(taskId: string, reason: string): Promise<boolean> {
    this.cancelled.push({ taskId, reason });
    this.working.delete(taskId);
    this.board.setStatus(taskId, "cancelled", { note: reason });
    return true;
  }

  isWorking(taskId: string): boolean {
    return this.working.has(taskId);
  }

  stopWorking(taskId: string): void {
    this.working.delete(taskId);
  }
}

export interface FinishOptions {
  status?: TaskAgentStatus;
  /** What the run reports (its last agent message). */
  text?: string;
  summary?: string;
  changed?: boolean;
}

export interface SchedulerHarnessOptions {
  now?: number;
  capabilities?: Capability[];
  maxRunMs?: number;
  storage?: MemoryStorageProvider;
}

export async function schedulerHarness(options: SchedulerHarnessOptions = {}) {
  const storage = options.storage ?? new MemoryStorageProvider();
  const clock = { now: options.now ?? sept(23, 10) };
  const now = () => clock.now;
  const threads: ThreadStore = createThreadStore({ storage, now });
  const records = new TaskRecords({ storage, now });
  const board = new TaskBoard({ threads, records, lookup: NO_TASKS, now });
  const library = new RoutineLibrary({
    storage,
    now,
    calendar: LA,
    liveRun: (runId) => {
      const record = records.get(runId);
      return record
        ? { status: record.status, ...(record.summary ? { summary: record.summary } : {}) }
        : undefined;
    },
  });
  await Promise.all([threads.load(), records.load(), library.start()]);
  const subagents = new FakeSubagents(board);
  const triaged: RoutineRunTriage[] = [];
  const dropped: string[] = [];
  const notifications: RoutineNotification[] = [];
  const capabilities = options.capabilities ?? ["web", "files"];
  const scheduler = new RoutineScheduler({
    library,
    threads,
    records,
    board,
    subagents: subagents as unknown as SubagentManager,
    triage: (run) => triaged.push(run),
    dropTriage: (runId) => dropped.push(runId),
    capabilities: () => capabilities,
    onNotification: (notification) => notifications.push(notification),
    now,
    calendar: LA,
    ...(options.maxRunMs !== undefined ? { maxRunMs: options.maxRunMs } : {}),
  });
  // As the runtime does: a run's record changes reach the scheduler.
  const unsubscribe = records.on("task.record", (record) => scheduler.onRecord(record));

  const definition = (name: string): RoutineDefinition => {
    const found = library.catalog.findByName(name);
    if (!found) throw new Error(`No routine named ${name}`);
    return found;
  };

  return {
    storage,
    clock,
    threads,
    records,
    board,
    library,
    subagents,
    triaged,
    dropped,
    notifications,
    scheduler,
    definition,

    /** Writes `Routines/<name>.md` and waits until the catalog has read it. */
    async write(name: string, content: string): Promise<RoutineDefinition> {
      const path = `Routines/${name}.md`;
      await storage.write(path, content);
      await library.catalog.reload(path);
      return definition(name);
    },

    state(name: string): RoutineState | undefined {
      return library.state.get(definition(name).id);
    },

    /** The routine's run threads, newest first. */
    runs(name: string): Thread[] {
      const { id } = definition(name);
      return threads
        .list({ routineId: id })
        .map((summary) => threads.get(summary.id)!)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /** The task id (`run_…`) of a run's thread. */
    runOf(threadId: string): string {
      const taskId = threads.get(threadId)?.taskId;
      if (!taskId) throw new Error(`No run thread ${threadId}`);
      return taskId;
    },

    /** The run's subagent ends its turn the way the SubagentManager does. */
    finish(runId: string, finish: FinishOptions = {}): void {
      const status = finish.status ?? "done";
      if (finish.text) board.postAgentText(runId, "subagent:test", finish.text);
      board.setStatus(runId, status, { summary: finish.summary ?? null });
      subagents.stopWorking(runId);
      const threadId = records.get(runId)?.threadId ?? "";
      scheduler.onSubagentFinished({
        taskId: runId,
        threadId,
        status,
        ...(finish.summary ? { summary: finish.summary } : {}),
        ...(finish.changed !== undefined ? { changed: finish.changed } : {}),
      });
    },

    /** Moves the clock and ticks, as the scheduler's timer (or waking from sleep) would. */
    at(time: number): void {
      clock.now = time;
      scheduler.tick();
    },

    stop(): void {
      unsubscribe();
      scheduler.stop();
      library.stop();
    },
  };
}

export type SchedulerHarness = Awaited<ReturnType<typeof schedulerHarness>>;
