import {
  decodePersistedApprovals,
  decodePersistedRecords,
  decodePersistedThread,
  encodePersistedThread,
  isPersistedArtifactPath,
  mergePersistedThreads,
  PERSISTED_BINARY_ARTIFACT_SUFFIX,
  PERSISTED_PATHS,
  type PersistedThread,
  persistedThreadIdFromPath,
} from "@ddl/contract";
import {
  type ApprovalRequest,
  type ApprovalStatus,
  type ArtifactMeta,
  type Logger,
  summarizeThread,
  type TaskAgentRecord,
  type Thread,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { errorMessage } from "./errors";

const THREADS_PREFIX = `${PERSISTED_PATHS.threads}/`;
/** Sync writes files in bursts; each file is read again once they settle. */
const DEFAULT_SETTLE_MS = 50;

export type SidecarViewEvent =
  | { type: "thread.upsert"; thread: ThreadSummary }
  | { type: "approval.upsert"; approval: ApprovalRequest }
  | { type: "task.records"; notePath: string; records: TaskAgentRecord[] };

export interface SidecarViewOptions {
  storage: StorageProvider;
  logger: Logger;
  settleMs?: number;
}

/**
 * The agent's work as the vault's sidecar shows it, for a device that doesn't run the agent:
 * threads (`threads/<id>.json`, sync conflict copies merged in), approvals and task records, read
 * with the contract's persisted-format parsers and followed as sync changes them. Read-only: it
 * never writes, repairs or moves a file (they belong to the agent holding the lease). Files it
 * can't read, or that a newer app wrote, are skipped.
 */
export class SidecarView {
  readonly #options: SidecarViewOptions;
  readonly #listeners = new Set<(event: SidecarViewEvent) => void>();
  /** Every readable thread file, by path (a thread's own file and any conflict copies). */
  readonly #files = new Map<string, PersistedThread>();
  readonly #threads = new Map<string, Thread>();
  #approvals: ApprovalRequest[] = [];
  #records: TaskAgentRecord[] = [];
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #unwatch: Unsubscribe | undefined;
  #generation = 0;

  constructor(options: SidecarViewOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#unwatch !== undefined;
  }

  /** Loads everything and follows changes until `stop()`. */
  async start(): Promise<void> {
    if (this.#unwatch) return;
    const generation = ++this.#generation;
    const { storage } = this.#options;
    this.#unwatch = storage.watch((event) => this.#changed(event.path));
    const entries = await storage
      .list({ prefix: PERSISTED_PATHS.threads, includeHidden: true })
      .catch(() => []);
    await Promise.all([
      ...entries
        .filter((entry) => isThreadFile(entry.path))
        .map((entry) => this.#readThread(entry.path, generation, false)),
      this.#readApprovals(generation, false),
      this.#readRecords(generation, false),
    ]);
  }

  /** Stops following and forgets everything (the agent runs here now, or the daemon stops). */
  stop(): void {
    this.#generation++;
    this.#unwatch?.();
    this.#unwatch = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#files.clear();
    this.#threads.clear();
    this.#approvals = [];
    this.#records = [];
  }

  on(listener: (event: SidecarViewEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  listThreads(
    filter: { notePath?: string; taskId?: string; routineId?: string } = {},
  ): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const thread of this.#threads.values()) {
      if (filter.notePath !== undefined && thread.notePath !== filter.notePath) continue;
      if (filter.taskId !== undefined && thread.taskId !== filter.taskId) continue;
      if (filter.routineId !== undefined && thread.routineId !== filter.routineId) continue;
      out.push(this.#summarize(thread));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    const thread = this.#threads.get(id);
    if (!thread) return undefined;
    return { thread, approvals: this.listApprovals().filter((a) => a.threadId === id) };
  }

  listApprovals(filter: { status?: ApprovalStatus } = {}): ApprovalRequest[] {
    return this.#approvals
      .filter((approval) => filter.status === undefined || approval.status === filter.status)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingApprovals(): number {
    return this.#approvals.filter((approval) => approval.status === "pending").length;
  }

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.#records
      .filter((record) => record.notePath === notePath)
      .sort((a, b) => a.line - b.line);
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    const meta = this.#threads.get(threadId)?.artifacts.find((a) => a.id === artifactId);
    if (!meta || !isPersistedArtifactPath(meta.path)) return null;
    const file = await this.#options.storage.read(meta.path);
    if (!file) return null;
    if (!meta.path.endsWith(PERSISTED_BINARY_ARTIFACT_SUFFIX)) {
      return { meta, body: new TextEncoder().encode(file.content) };
    }
    return { meta, body: new Uint8Array(Buffer.from(file.content, "base64")) };
  }

  // ── Following changes ─────────────────────────────────────────────────

  #changed(path: string): void {
    const read =
      path === PERSISTED_PATHS.approvals
        ? (generation: number) => this.#readApprovals(generation, true)
        : path === PERSISTED_PATHS.records
          ? (generation: number) => this.#readRecords(generation, true)
          : isThreadFile(path)
            ? (generation: number) => this.#readThread(path, generation, true)
            : null;
    if (!read) return;
    clearTimeout(this.#timers.get(path));
    const generation = this.#generation;
    this.#timers.set(
      path,
      setTimeout(() => {
        this.#timers.delete(path);
        void read(generation);
      }, this.#options.settleMs ?? DEFAULT_SETTLE_MS),
    );
  }

  async #readText(path: string): Promise<string | null> {
    try {
      return (await this.#options.storage.read(path))?.content ?? null;
    } catch (error) {
      this.#options.logger.debug("Couldn't read an agent file", {
        path,
        error: errorMessage(error),
      });
      return null;
    }
  }

  async #readThread(path: string, generation: number, announce: boolean): Promise<void> {
    const text = await this.#readText(path);
    if (generation !== this.#generation) return;
    const before = this.#files.get(path)?.id;
    const decoded =
      text === null
        ? null
        : decodePersistedThread(text, persistedThreadIdFromPath(path) ?? undefined);
    if (decoded?.ok) this.#files.set(path, decoded.value);
    else this.#files.delete(path);
    const ids = new Set([before, decoded?.ok ? decoded.value.id : undefined]);
    for (const id of ids) if (id) this.#rebuild(id, announce);
  }

  /** A thread from its own file first, then its copies from the most recently updated. */
  #rebuild(id: string, announce: boolean): void {
    const own = `${THREADS_PREFIX}${id}.json`;
    const copies = [...this.#files.entries()]
      .filter(([, thread]) => thread.id === id)
      .sort(
        ([pathA, a], [pathB, b]) =>
          Number(pathB === own) - Number(pathA === own) || b.updatedAt - a.updatedAt,
      )
      .map(([, thread]) => thread);
    const previous = this.#threads.get(id);
    const [first, ...rest] = copies;
    if (!first) {
      this.#threads.delete(id);
      return;
    }
    const thread = rest.reduce(mergePersistedThreads, first) as Thread;
    this.#threads.set(id, thread);
    if (
      announce &&
      (!previous || encodePersistedThread(previous) !== encodePersistedThread(thread))
    ) {
      this.#emit({ type: "thread.upsert", thread: this.#summarize(thread) });
    }
  }

  async #readApprovals(generation: number, announce: boolean): Promise<void> {
    const text = await this.#readText(PERSISTED_PATHS.approvals);
    if (generation !== this.#generation) return;
    const decoded = text === null ? null : decodePersistedApprovals(text);
    if (decoded && !decoded.ok) return;
    const next = (decoded?.value.approvals ?? []) as ApprovalRequest[];
    const previous = new Map(
      this.#approvals.map((approval) => [approval.id, JSON.stringify(approval)]),
    );
    this.#approvals = next;
    if (!announce) return;
    const threads = new Set<string>();
    for (const approval of next) {
      if (previous.get(approval.id) === JSON.stringify(approval)) continue;
      this.#emit({ type: "approval.upsert", approval });
      if (approval.threadId) threads.add(approval.threadId);
    }
    for (const id of threads) {
      const thread = this.#threads.get(id);
      if (thread) this.#emit({ type: "thread.upsert", thread: this.#summarize(thread) });
    }
  }

  async #readRecords(generation: number, announce: boolean): Promise<void> {
    const text = await this.#readText(PERSISTED_PATHS.records);
    if (generation !== this.#generation) return;
    const decoded = text === null ? null : decodePersistedRecords(text);
    if (decoded && !decoded.ok) return;
    const next = (decoded?.value.records ?? []) as TaskAgentRecord[];
    const notes = new Set<string>();
    const previous = new Map(
      this.#records.map((record) => [record.taskId, JSON.stringify(record)]),
    );
    for (const record of next) {
      if (previous.get(record.taskId) !== JSON.stringify(record)) notes.add(record.notePath);
      previous.delete(record.taskId);
    }
    for (const gone of previous.keys()) {
      const record = this.#records.find((r) => r.taskId === gone);
      if (record) notes.add(record.notePath);
    }
    this.#records = next;
    if (!announce) return;
    for (const notePath of notes) {
      this.#emit({ type: "task.records", notePath, records: this.getTaskRecords(notePath) });
    }
  }

  #summarize(thread: Thread): ThreadSummary {
    const pending = this.#approvals.filter(
      (approval) => approval.threadId === thread.id && approval.status === "pending",
    ).length;
    return summarizeThread(thread, pending);
  }

  #emit(event: SidecarViewEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#options.logger.error("Sidecar view listener failed", { error: errorMessage(error) });
      }
    }
  }
}

/** A file directly in `threads/` (a thread or a sync conflict copy of one). */
function isThreadFile(path: string): boolean {
  return (
    path.startsWith(THREADS_PREFIX) &&
    path.endsWith(".json") &&
    !path.slice(THREADS_PREFIX.length).includes("/")
  );
}
