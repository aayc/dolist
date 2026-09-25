import type { NoteResponse, WriteNoteRequest, WriteNoteResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../api/errors";
import { type NotesClient, NotesController } from "./notes-controller";

/**
 * Lines deleted outside an open editor (another app, another client, the agent) must stay deleted:
 * no editor may write them back unless its user types them again. These replay the incident (an
 * agent line added, then a task and its line removed through the API while the note was open in
 * two editors) and the races around it, against a daemon with content-hash versions.
 */

const PATH = "Daily/2026-09-24.md";
const TASK = "- [ ] Rehearsal: count the bots";
const RESULT = "\t- Done: 11 bots %%agent:thr_1%%";
const DAY = ["# Thursday", "- [ ] Water the plants", TASK].join("\n");
const WITH_RESULT = `${DAY}\n${RESULT}`;
const CLEANED = ["# Thursday", "- [ ] Water the plants"].join("\n");

/** The daemon: versions are content hashes; every write announces `vault.changed` to the others. */
class Daemon {
  content: string;
  readonly writes: Array<{ by: string; content: string }> = [];
  readonly editors: Editor[] = [];
  /** `vault.changed` events not yet delivered, per editor. */
  readonly inbox = new Map<Editor, string[]>();
  holdWrites = false;
  readonly held: Array<() => void> = [];
  /** Index in `writes` of the API client's delete. */
  deletedAt = 0;

  constructor(content: string) {
    this.content = content;
  }

  get version(): string {
    return `h:${this.content}`;
  }

  note(): NoteResponse {
    return { path: PATH, content: this.content, version: this.version, mtime: 1 };
  }

  /** A write from `by` (an editor's client id, the agent, or an API client). */
  set(content: string, by: string): void {
    this.content = content;
    this.writes.push({ by, content });
    for (const editor of this.editors) {
      if (editor.id === by) continue;
      this.inbox.get(editor)?.push(this.version);
    }
  }

  /** An API client's read-modify-write with `baseVersion` (the incident's cleanup). */
  removeLines(...lines: string[]): void {
    const read = this.note();
    const next = read.content
      .split("\n")
      .filter((line) => !lines.includes(line))
      .join("\n");
    if (read.version !== this.version) throw new Error("stale read");
    this.deletedAt = this.writes.length;
    this.set(next, "api");
  }

  /** Delivers every pending `vault.changed` (the WebSocket), and lets the editors react. */
  async deliver(): Promise<void> {
    for (const editor of this.editors) {
      const events = this.inbox.get(editor) ?? [];
      this.inbox.set(editor, []);
      for (const version of events) await editor.notes.handleRemoteChange(PATH, version);
    }
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** One editor (web tab or window): its text, and the note controller persisting it. */
class Editor implements NotesClient {
  readonly notes: NotesController;
  text: string;
  shown = true;
  readonly daemon: Daemon;
  readonly id: string;

  constructor(daemon: Daemon, id: string) {
    this.daemon = daemon;
    this.id = id;
    this.text = daemon.content;
    daemon.editors.push(this);
    daemon.inbox.set(this, []);
    this.notes = new NotesController({
      client: this,
      saveDelayMs: 300,
      retryDelayMs: 1000,
      hooks: {
        readLive: () => (this.shown ? this.text : null),
        applyRemote: (_path, content) => this.show(content),
        applyMerge: (_path, content) => this.show(content),
        onSaveState: () => {},
        onConflictCopy: () => {},
        onRemoteDelete: () => {},
        onSaveError: () => {},
        pathExists: () => false,
      },
    });
    this.notes.adopt(daemon.note());
  }

  private show(content: string): void {
    if (this.shown) this.text = content;
  }

  async readNote(): Promise<NoteResponse> {
    return this.daemon.note();
  }

  async writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    if (path !== PATH) return { path, version: "copy", mtime: 1 };
    if (this.daemon.holdWrites) await new Promise<void>((go) => this.daemon.held.push(go));
    if (body.baseVersion !== this.daemon.version) throw new ConflictError(this.daemon.note());
    this.daemon.set(body.content, this.id);
    return { path, version: this.daemon.version, mtime: 1 };
  }

  /** The user types at the end of a line (`- [ ] Water the plants` unless told otherwise). */
  type(suffix: string, onLine = "- [ ] Water the plants"): void {
    this.text = this.text
      .split("\n")
      .map((line) => (line === onLine ? `${line}${suffix}` : line))
      .join("\n");
    this.notes.markDirty(PATH);
  }

  /** The user adds a line after `after`. */
  addLine(line: string, after: string): void {
    const lines = this.text.split("\n");
    lines.splice(lines.indexOf(after) + 1, 0, line);
    this.text = lines.join("\n");
    this.notes.markDirty(PATH);
  }
}

function setup(content = WITH_RESULT, editors = 1) {
  const daemon = new Daemon(content);
  const list = Array.from({ length: editors }, (_, i) => new Editor(daemon, `web_${i}`));
  return { daemon, editors: list, editor: list[0]! };
}

function expectNoResurrection(daemon: Daemon, ...deleted: string[]): void {
  for (const write of daemon.writes.slice(daemon.deletedAt + 1)) {
    for (const line of deleted) {
      expect(write.content.split("\n"), `${write.by} wrote ${line} back`).not.toContain(line);
    }
  }
  for (const line of deleted) expect(daemon.content.split("\n")).not.toContain(line);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lines deleted outside an open editor stay deleted", () => {
  it("an external delete while the note is open and clean: shown, nothing written", async () => {
    const { daemon, editor } = setup();
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    expect(editor.text).toBe(CLEANED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.writes.filter((w) => w.by !== "api")).toEqual([]);
    editor.type(" today");
    await vi.advanceTimersByTimeAsync(300);
    expect(daemon.content).toBe(["# Thursday", "- [ ] Water the plants today"].join("\n"));
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("an external delete while the user has unsaved typing elsewhere in the note", async () => {
    const { daemon, editor } = setup();
    editor.type(" today");
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    expect(editor.text).toBe(["# Thursday", "- [ ] Water the plants today"].join("\n"));
    await vi.advanceTimersByTimeAsync(300);
    expect(daemon.content).toBe(editor.text);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("an agent edit, then an external delete, then typing", async () => {
    const { daemon, editor } = setup(DAY);
    daemon.set(WITH_RESULT, "agent");
    await daemon.deliver();
    expect(editor.text).toBe(WITH_RESULT);
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    editor.type(" today");
    await vi.advanceTimersByTimeAsync(300);
    expect(daemon.content).toBe(["# Thursday", "- [ ] Water the plants today"].join("\n"));
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("two editors open on the note while a third client deletes, then both type", async () => {
    const { daemon, editors } = setup(WITH_RESULT, 2);
    const [web, mac] = editors as [Editor, Editor];
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    expect(web.text).toBe(CLEANED);
    expect(mac.text).toBe(CLEANED);
    web.type(" today");
    mac.addLine("- [ ] Call mom", "# Thursday");
    await vi.advanceTimersByTimeAsync(300);
    await daemon.deliver();
    await vi.advanceTimersByTimeAsync(300);
    await daemon.deliver();
    const expected = ["# Thursday", "- [ ] Call mom", "- [ ] Water the plants today"].join("\n");
    expect(daemon.content).toBe(expected);
    expect(web.text).toBe(expected);
    expect(mac.text).toBe(expected);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("a delete racing a pending debounced save", async () => {
    const { daemon, editor } = setup();
    editor.type(" today");
    await vi.advanceTimersByTimeAsync(200);
    daemon.removeLines(TASK, RESULT);
    // The save fires before the vault.changed arrives: its baseVersion is stale.
    await vi.advanceTimersByTimeAsync(100);
    await daemon.deliver();
    await vi.advanceTimersByTimeAsync(300);
    expect(daemon.content).toBe(["# Thursday", "- [ ] Water the plants today"].join("\n"));
    expect(editor.text).toBe(daemon.content);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("a 409 after an external delete: the retry merges instead of restoring the lines", async () => {
    const { daemon, editor } = setup();
    daemon.holdWrites = true;
    editor.type(" today");
    await vi.advanceTimersByTimeAsync(300);
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver(); // in flight: re-checked afterwards
    editor.type("!", "- [ ] Water the plants today");
    daemon.holdWrites = false;
    for (const go of daemon.held.splice(0)) go();
    await vi.advanceTimersByTimeAsync(1000);
    await daemon.deliver();
    expect(daemon.content).toBe(["# Thursday", "- [ ] Water the plants today!"].join("\n"));
    expect(editor.text).toBe(daemon.content);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("a line the user added between two lines deleted elsewhere keeps only the user's line", async () => {
    const { daemon, editor } = setup();
    editor.addLine("\t- ask about the missing ones", TASK);
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    await vi.advanceTimersByTimeAsync(300);
    const expected = [...CLEANED.split("\n"), "\t- ask about the missing ones"].join("\n");
    expect(daemon.content).toBe(expected);
    expect(editor.text).toBe(expected);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("a conflict on one line doesn't bring back lines deleted elsewhere", async () => {
    const { daemon, editor } = setup();
    editor.type(" (all of them)", "- [ ] Water the plants");
    daemon.set(WITH_RESULT.replace("- [ ] Water", "- [x] Water"), "phone");
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    await vi.advanceTimersByTimeAsync(1000);
    expect(daemon.content).toBe(["# Thursday", "- [ ] Water the plants (all of them)"].join("\n"));
    expect(editor.text).toBe(daemon.content);
    expectNoResurrection(daemon, TASK, RESULT);
  });

  it("a clean editor never writes, however often it loses focus", async () => {
    const { daemon, editors } = setup(WITH_RESULT, 2);
    for (const editor of editors) await editor.notes.flush(PATH);
    daemon.removeLines(TASK, RESULT);
    for (const editor of editors) await editor.notes.flush(PATH);
    await daemon.deliver();
    for (const editor of editors) await editor.notes.flush(PATH);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.writes.map((w) => w.by)).toEqual(["api"]);
  });
});

describe("what a note without an editor state shows", () => {
  it("is the vault's text once the note is clean, even after a flush captured older text", async () => {
    const { daemon, editor } = setup();
    await editor.notes.flush(PATH); // the window lost focus
    editor.shown = false; // the note left the editor
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    expect(editor.notes.content(PATH)).toBe(CLEANED);
  });

  it("is the unsaved text while there is some", async () => {
    const { daemon, editor } = setup();
    editor.type(" today");
    await editor.notes.flush(PATH);
    editor.shown = false;
    daemon.removeLines(TASK, RESULT);
    await daemon.deliver();
    expect(editor.notes.content(PATH)).toBe(
      ["# Thursday", "- [ ] Water the plants today"].join("\n"),
    );
  });
});
