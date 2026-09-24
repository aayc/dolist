import {
  createId,
  type Logger,
  type MessageAuthor,
  type StatusMessage,
  silentLogger,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TaskStatus,
  type TextMessage,
  type Thread,
} from "@ddl/core";
import type { ThreadStore } from "../threads/types";
import { ToolInputError } from "../tools/input";
import type { TaskRecords } from "./records";
import type { TaskLookup } from "./task-watcher";

/** Everything the agents need to know about one to-do item. */
export interface TaskRef {
  taskId: string;
  notePath: string;
  date: string | null;
  text: string;
  line: number;
  /** Checkbox state when the task is still in a watched note. */
  status?: TaskStatus;
  notes: string[];
}

export class UnknownTaskError extends ToolInputError {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Unknown task id "${taskId}" (it may have been deleted). Use list_tasks to see tasks.`);
    this.name = "UnknownTaskError";
    this.taskId = taskId;
  }
}

export interface TaskBoardOptions {
  threads: ThreadStore;
  records: TaskRecords;
  lookup: TaskLookup;
  now?: () => number;
  logger?: Logger;
}

/**
 * Keeps a task's record, thread and badge consistent: creating the record/thread on demand,
 * posting agent messages (counting them as unread) and mirroring status into the thread.
 */
export class TaskBoard {
  private readonly threads: ThreadStore;
  private readonly records: TaskRecords;
  private readonly lookup: TaskLookup;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(options: TaskBoardOptions) {
    this.threads = options.threads;
    this.records = options.records;
    this.lookup = options.lookup;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  describe(taskId: string): TaskRef | undefined {
    const found = this.lookup.findTask(taskId);
    if (found) {
      return {
        taskId,
        notePath: found.notePath,
        date: found.date,
        text: found.task.text,
        line: found.task.line,
        status: found.task.status,
        notes: [...found.task.notes],
      };
    }
    const record = this.records.get(taskId);
    if (!record) return undefined;
    return {
      taskId,
      notePath: record.notePath,
      date: record.date,
      text: record.text,
      line: record.line,
      notes: [],
    };
  }

  require(taskId: string): TaskRef {
    const ref = this.describe(taskId);
    if (!ref) throw new UnknownTaskError(taskId);
    return ref;
  }

  ensureRecord(taskId: string): TaskAgentRecord {
    const existing = this.records.get(taskId);
    if (existing) return existing;
    const ref = this.require(taskId);
    return this.records.ensure({
      taskId,
      notePath: ref.notePath,
      date: ref.date,
      text: ref.text,
      line: ref.line,
    });
  }

  ensureThread(taskId: string): Thread {
    const record = this.ensureRecord(taskId);
    const current = record.threadId ? this.threads.get(record.threadId) : undefined;
    if (current) return current;
    const thread =
      this.threads.findByTask(taskId) ??
      this.threads.create({ taskId, notePath: record.notePath, title: record.text });
    this.records.update(taskId, { threadId: thread.id });
    if (thread.status !== record.status) this.threads.setStatus(thread.id, record.status);
    return thread;
  }

  /** Posts an agent message to the task's thread and counts it as unread. */
  postAgentText(taskId: string, author: MessageAuthor, text: string): TextMessage {
    const thread = this.ensureThread(taskId);
    const message: TextMessage = {
      id: createId("msg"),
      kind: "text",
      role: "agent",
      author,
      text,
      createdAt: this.now(),
    };
    this.threads.upsertMessage(thread.id, message);
    this.records.bumpUnread(taskId);
    return message;
  }

  setSummary(taskId: string, summary: string | null): void {
    this.records.update(taskId, { summary });
  }

  /** Threads are titled with the task text and follow its edits. */
  renameThread(threadId: string, title: string): void {
    this.threads.setTitle(threadId, title);
  }

  /**
   * Updates the badge status (and optionally its summary) and mirrors it into the thread. A `note`
   * also appends a status message to the thread (creating it if needed).
   */
  setStatus(
    taskId: string,
    status: TaskAgentStatus,
    options: { summary?: string | null; note?: string } = {},
  ): void {
    let record = this.records.get(taskId);
    if (!record) {
      try {
        record = this.ensureRecord(taskId);
      } catch (error) {
        this.logger.debug("Status change for an unknown task", { taskId, status });
        if (error instanceof UnknownTaskError) return;
        throw error;
      }
    }
    this.records.update(taskId, {
      status,
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    });
    const threadId = options.note ? this.ensureThread(taskId).id : record.threadId;
    if (!threadId) return;
    this.threads.setStatus(threadId, status);
    if (options.note) {
      const message: StatusMessage = {
        id: createId("msg"),
        kind: "status",
        author: "system",
        status,
        text: options.note,
        createdAt: this.now(),
      };
      this.threads.upsertMessage(threadId, message);
    }
  }
}
