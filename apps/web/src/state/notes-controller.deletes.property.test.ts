import type { NoteResponse, WriteNoteRequest, WriteNoteResponse } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ConflictError } from "../api/errors";
import { type NotesClient, NotesController } from "./notes-controller";

/**
 * Two editors (web tabs, or the web app and the Mac app) on today's note while the agent adds lines
 * under tasks and an API client appends tasks and deletes lines (read, then a `baseVersion` write).
 * Requests, responses and `vault.changed` events are delivered in any order; versions are content
 * hashes, like the daemon's. Each editor types only on its own line and at the end, so nothing it
 * does conflicts with anyone, and every line is unique: where a line came from is never ambiguous.
 */

const PATH = "Daily/2026-09-24.md";

interface Pending {
  run(): void;
}

class Vault {
  content = "# Today\n- [ ] start";
  readonly queue: Pending[] = [];
  readonly editors: Editor[] = [];
  /** Lines the API client deleted (and nobody wrote since). */
  readonly deleted = new Set<string>();
  counter = 0;
  private read: string | null = null;

  get version(): string {
    return `h:${this.content}`;
  }

  note(): NoteResponse {
    return { path: PATH, content: this.content, version: this.version, mtime: 1 };
  }

  set(content: string, writer: Editor | null): void {
    this.content = content;
    const version = this.version;
    for (const editor of this.editors) {
      if (editor === writer) continue;
      this.queue.push({ run: () => void editor.notes.handleRemoteChange(PATH, version) });
    }
  }

  deliver(index: number): void {
    const [pending] = this.queue.splice(index % this.queue.length, 1);
    pending?.run();
  }

  agentAddUnder(pick: number): void {
    const lines = this.content.split("\n");
    const tasks = lines.flatMap((line, i) => (line.startsWith("- [ ]") ? [i] : []));
    const at = tasks.length === 0 ? lines.length - 1 : tasks[pick % tasks.length]!;
    lines.splice(at + 1, 0, `\t- result ${++this.counter} %%agent:thr_${this.counter}%%`);
    this.set(lines.join("\n"), null);
  }

  apiAppendTask(): void {
    this.set(`${this.content}\n- [ ] api task ${++this.counter}`, null);
  }

  apiRead(): void {
    this.read = this.content;
  }

  /** Deletes up to two lines the API client read (never the editors' own lines). */
  apiDelete(pick: number): void {
    const read = this.read;
    this.read = null;
    if (read === null || `h:${read}` !== this.version) return;
    const lines = read.split("\n");
    const candidates = lines.slice(2).filter((line) => !/ c\d task /.test(line));
    if (candidates.length === 0) return;
    const victims = new Set([
      candidates[pick % candidates.length]!,
      candidates[(pick + 1) % candidates.length]!,
    ]);
    for (const line of victims) this.deleted.add(line);
    this.set(lines.filter((line) => !victims.has(line)).join("\n"), null);
  }
}

class Editor implements NotesClient {
  readonly notes: NotesController;
  /** The editor's text while the note is shown (null while the editor is unmounted). */
  live: string | null;
  /** A cached editor state for the note while another note is shown (null: none). */
  cached: string | null = null;
  active = true;
  mounted = true;
  /** Tokens this editor's user typed. */
  readonly typed = new Set<string>();

  constructor(
    readonly vault: Vault,
    readonly id: number,
  ) {
    this.live = vault.content;
    this.notes = new NotesController({
      client: this,
      saveDelayMs: 300,
      retryDelayMs: 1000,
      hooks: {
        readLive: () => (this.active && this.mounted ? this.live : null),
        applyRemote: (_path, content) => this.show(content),
        applyMerge: (_path, content) => this.show(content),
        onSaveState: () => {},
        onConflictCopy: () => {
          throw new Error("nothing here conflicts");
        },
        onRemoteDelete: () => {},
        onSaveError: () => {},
        pathExists: () => false,
      },
    });
    this.notes.adopt(vault.note());
  }

  /** `EditorController.applyRemote`: the shown note, else its cached state if it has one. */
  private show(content: string): void {
    if (this.active && this.mounted) this.live = content;
    else if (this.cached !== null) this.cached = content;
  }

  /** `EditorController.show` without a cached state: what the workspace says to show. */
  private fresh(): string {
    return this.notes.content(PATH) ?? "";
  }

  /** What the user sees for the note, or would see on coming back to it. */
  shown(): string {
    if (this.active && this.mounted) return this.live!;
    return this.cached ?? this.fresh();
  }

  readNote(): Promise<NoteResponse> {
    return new Promise((resolve) => {
      this.vault.queue.push({ run: () => resolve(this.vault.note()) });
    });
  }

  writeNote(_path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    return new Promise((resolve, reject) => {
      this.vault.queue.push({
        run: () => {
          if (body.baseVersion !== this.vault.version) {
            reject(new ConflictError(this.vault.note()));
            return;
          }
          this.check(body.content);
          this.vault.set(body.content, this);
          resolve({ path: PATH, version: this.vault.version, mtime: 1 });
        },
      });
    });
  }

  /** The properties, checked on every write that lands. */
  private check(content: string): void {
    const current = this.vault.content;
    for (const line of content.split("\n")) {
      expect(this.vault.deleted.has(line), `editor ${this.id} brought back ${line}`).toBe(false);
    }
    const unsaved = [...this.typed].filter((token) => !current.includes(token));
    if (unsaved.length === 0) {
      expect(content, `editor ${this.id} wrote without unsaved typing`).toBe(current);
    }
  }

  private edit(token: string, change: (text: string) => string): void {
    if (!this.active || !this.mounted || this.live === null) return;
    this.typed.add(token);
    this.live = change(this.live);
    this.notes.markDirty(PATH);
  }

  typeOnOwnLine(): void {
    const token = `c${this.id}t${++this.vault.counter}`;
    this.edit(token, (text) => {
      const lines = text.split("\n");
      lines[this.id] = `${lines[this.id]} ${token}`;
      return lines.join("\n");
    });
  }

  typeNewTask(): void {
    const token = `c${this.id} task ${++this.vault.counter}`;
    this.edit(token, (text) => `${text}\n- [ ] ${token}`);
  }

  /** Switches to another note (flushing this one) or back. */
  toggleTab(): void {
    if (this.active) {
      void this.notes.flush(PATH);
      this.cached = this.mounted ? this.live : null;
      this.active = false;
    } else {
      this.active = true;
      if (this.mounted) this.live = this.cached ?? this.fresh();
      this.cached = null;
    }
  }

  /** The LRU drops the cached state (never for a note with unsaved edits). */
  evict(): void {
    if (!this.active && !this.notes.isBusy(PATH)) this.cached = null;
  }

  /** `EditorController.unmount` (flush, drop every cached state) and `mount`. */
  toggleMount(): void {
    if (this.mounted) {
      if (this.active) void this.notes.flush(PATH);
      this.mounted = false;
      this.cached = null;
      this.live = null;
    } else {
      this.mounted = true;
      if (this.active) this.live = this.fresh();
    }
  }
}

type Op =
  | { k: "type" | "task" | "tab" | "evict" | "mount" | "flush" | "resync"; c: number }
  | { k: "deliver"; i: number }
  | { k: "advance"; ms: number }
  | { k: "agent"; i: number }
  | { k: "append" }
  | { k: "apiRead" }
  | { k: "apiDelete"; i: number };

const editor = fc.nat({ max: 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("type" as const), c: editor }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("task" as const), c: editor }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("tab" as const), c: editor }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("evict" as const), c: editor }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("mount" as const), c: editor }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("flush" as const), c: editor }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("resync" as const), c: editor }) },
  { weight: 10, arbitrary: fc.record({ k: fc.constant("deliver" as const), i: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({ k: fc.constant("advance" as const), ms: fc.constantFrom(1, 300, 2000) }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("agent" as const), i: fc.nat() }) },
  { weight: 2, arbitrary: fc.constant({ k: "append" as const }) },
  { weight: 2, arbitrary: fc.constant({ k: "apiRead" as const }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("apiDelete" as const), i: fc.nat() }) },
);

async function run(ops: readonly Op[]): Promise<Vault> {
  const vault = new Vault();
  vault.editors.push(new Editor(vault, 0), new Editor(vault, 1));
  for (const op of ops) {
    const e = "c" in op ? vault.editors[op.c]! : null;
    switch (op.k) {
      case "type":
        e!.typeOnOwnLine();
        break;
      case "task":
        e!.typeNewTask();
        break;
      case "tab":
        e!.toggleTab();
        break;
      case "evict":
        e!.evict();
        break;
      case "mount":
        e!.toggleMount();
        break;
      case "flush":
        void e!.notes.flush(PATH);
        break;
      case "resync":
        void e!.notes.handleRemoteChange(PATH);
        break;
      case "deliver":
        if (vault.queue.length > 0) vault.deliver(op.i);
        break;
      case "advance":
        await vi.advanceTimersByTimeAsync(op.ms);
        break;
      case "agent":
        vault.agentAddUnder(op.i);
        break;
      case "append":
        vault.apiAppendTask();
        break;
      case "apiRead":
        vault.apiRead();
        break;
      case "apiDelete":
        vault.apiDelete(op.i);
        break;
    }
    await vi.advanceTimersByTimeAsync(0);
  }
  for (const e of vault.editors) {
    if (!e.mounted) e.toggleMount();
    if (!e.active) e.toggleTab();
  }
  for (let i = 0; i < 400; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (vault.queue.length > 0) vault.deliver(0);
    else if (vi.getTimerCount() === 0) break;
    else await vi.advanceTimersByTimeAsync(5_000);
  }
  return vault;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesController and lines deleted elsewhere (model-based)", () => {
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 60 })], { numRuns: 300 })(
    "nothing deleted elsewhere comes back, a clean editor writes nothing new, all converge",
    async (ops) => {
      const vault = await run(ops);
      expect(vault.queue).toEqual([]);
      for (const e of vault.editors) {
        expect(e.notes.isDirty(PATH), `editor ${e.id} saved everything`).toBe(false);
        expect(e.shown(), `editor ${e.id} shows the vault's text`).toBe(vault.content);
        for (const token of e.typed) {
          expect(vault.content, `editor ${e.id} lost ${token}`).toContain(token);
        }
      }
    },
    60_000,
  );
});
