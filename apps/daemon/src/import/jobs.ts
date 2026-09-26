/**
 * One import or update at a time, with its progress. Listeners get a snapshot on every phase and
 * state change, and at most every `PROGRESS_INTERVAL_MS` while files are copied.
 */
import type {
  ObsidianImportJob,
  ObsidianImportJobKind,
  ObsidianImportPhase,
  ObsidianImportResult,
  ObsidianUpdateReport,
  Unsubscribe,
} from "@ddl/core";
import { Listeners } from "@ddl/core";
import { ApiError } from "../errors";

export const PROGRESS_INTERVAL_MS = 200;

export type JobListener = (job: ObsidianImportJob) => void;

/** What a running job reports through. */
export class JobRun {
  readonly job: ObsidianImportJob;
  readonly signal: AbortSignal;
  readonly #emit: (force: boolean) => void;

  constructor(job: ObsidianImportJob, signal: AbortSignal, emit: (force: boolean) => void) {
    this.job = job;
    this.signal = signal;
    this.#emit = emit;
  }

  phase(phase: ObsidianImportPhase): void {
    this.job.phase = phase;
    this.#emit(true);
  }

  totals(files: number, bytes: number): void {
    this.job.progress.totalFiles = files;
    this.job.progress.totalBytes = bytes;
    this.#emit(true);
  }

  bytes(bytes: number): void {
    const { progress } = this.job;
    progress.bytes += bytes;
    progress.totalBytes = Math.max(progress.totalBytes, progress.bytes);
    this.#emit(false);
  }

  file(): void {
    const { progress } = this.job;
    progress.files++;
    progress.totalFiles = Math.max(progress.totalFiles, progress.files);
    this.#emit(false);
  }
}

export type JobOutcome = { result: ObsidianImportResult } | { update: ObsidianUpdateReport };

export interface JobRunnerOptions {
  now: () => number;
  newId: () => string;
  /** A failure's message for the job (never includes file contents). */
  describe: (error: unknown) => string;
}

export class JobRunner {
  readonly #options: JobRunnerOptions;
  readonly #listeners = new Listeners<ObsidianImportJob>();
  #running: { job: ObsidianImportJob; controller: AbortController; done: Promise<void> } | null =
    null;
  #last: ObsidianImportJob | null = null;
  #lastEmit = 0;

  constructor(options: JobRunnerOptions) {
    this.#options = options;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  /** The running job, or the last one. */
  current(): ObsidianImportJob | null {
    const job = this.#running?.job ?? this.#last;
    return job ? structuredClone(job) : null;
  }

  onProgress(listener: JobListener): Unsubscribe {
    return this.#listeners.add(listener);
  }

  /** Refuses while a job runs. */
  assertIdle(): void {
    if (this.#running) {
      const what = this.#running.job.kind === "import" ? "An import" : "An update from Obsidian";
      throw new ApiError(409, "conflict", `${what} is running; wait for it or cancel it`);
    }
  }

  start(
    kind: ObsidianImportJobKind,
    places: { source: string; destination: string },
    work: (run: JobRun) => Promise<JobOutcome>,
  ): ObsidianImportJob {
    this.assertIdle();
    const controller = new AbortController();
    const job: ObsidianImportJob = {
      id: this.#options.newId(),
      kind,
      state: "running",
      phase: "checking",
      source: places.source,
      destination: places.destination,
      startedAt: this.#options.now(),
      progress: { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 },
    };
    const run = new JobRun(job, controller.signal, (force) => this.#emit(job, force));
    const done = Promise.resolve()
      .then(() => work(run))
      .then(
        (outcome) => {
          job.state = "done";
          Object.assign(job, outcome);
        },
        (error: unknown) => {
          if (controller.signal.aborted) {
            job.state = "cancelled";
          } else {
            job.state = "failed";
            job.error = this.#options.describe(error);
          }
        },
      )
      .finally(() => {
        job.finishedAt = this.#options.now();
        this.#last = job;
        this.#running = null;
        this.#emit(job, true);
      });
    this.#running = { job, controller, done };
    this.#emit(job, true);
    return structuredClone(job);
  }

  /** Stops the running job and waits until it cleaned up. */
  async cancel(): Promise<ObsidianImportJob> {
    const running = this.#running;
    if (!running) throw new ApiError(404, "not_found", "Nothing is being imported");
    running.controller.abort();
    await running.done;
    return structuredClone(running.job);
  }

  /** Waits for the running job, if any (tests, shutdown). */
  async settled(): Promise<void> {
    await this.#running?.done;
  }

  async close(): Promise<void> {
    this.#running?.controller.abort();
    await this.settled();
  }

  #emit(job: ObsidianImportJob, force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastEmit < PROGRESS_INTERVAL_MS) return;
    this.#lastEmit = now;
    if (this.#listeners.size === 0) return;
    // A listener's failure must not stop the import.
    this.#listeners.emit(structuredClone(job));
  }
}
