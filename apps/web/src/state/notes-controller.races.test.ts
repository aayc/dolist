import type { NoteResponse, WriteNoteRequest, WriteNoteResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError, NetworkError } from "../api/errors";
import { type NotesClient, NotesController, type NotesControllerHooks } from "./notes-controller";
import type { SaveState } from "./notes-store";

/** Fake daemon whose writes can be held in flight and released one at a time. */
class HeldClient implements NotesClient {
  readonly notes = new Map<string, NoteResponse>();
  readonly writes: Array<{ path: string; body: WriteNoteRequest }> = [];
  readonly held: Array<() => void> = [];
  hold = false;
  failures: unknown[] = [];
  private counter = 0;

  seed(path: string, content: string): NoteResponse {
    const note = { path, content, version: `v${++this.counter}`, mtime: this.counter };
    this.notes.set(path, note);
    return note;
  }

  rename(from: string, to: string): void {
    const note = this.notes.get(from);
    if (!note) throw new HttpError(404, "not found");
    this.notes.delete(from);
    this.notes.set(to, { ...note, path: to });
  }

  releaseOne(): void {
    this.held.shift()?.();
  }

  async readNote(path: string): Promise<NoteResponse> {
    const note = this.notes.get(path);
    if (!note) throw new HttpError(404, "not found");
    return { ...note };
  }

  async writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    this.writes.push({ path, body });
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    const failure = this.failures.shift();
    if (failure) throw failure;
    const current = this.notes.get(path);
    if (body.baseVersion === null && current) throw new ConflictError({ ...current });
    if (typeof body.baseVersion === "string" && current?.version !== body.baseVersion) {
      throw new ConflictError(current ? { ...current } : null);
    }
    const note = this.seed(path, body.content);
    return { path, version: note.version, mtime: note.mtime };
  }
}

const PATH = "Daily/2026-09-23.md";

function setup(initial = "- [ ] ") {
  const client = new HeldClient();
  const note = client.seed(PATH, initial);
  const live = new Map<string, string>([[PATH, initial]]);
  const states: Array<[string, SaveState | null]> = [];
  const hooks = {
    readLive: vi.fn((path: string) => live.get(path) ?? null),
    applyRemote: vi.fn((path: string, content: string) => {
      if (live.has(path)) live.set(path, content);
    }),
    onSaveState: vi.fn((path: string, state: SaveState | null) => states.push([path, state])),
    onConflictCopy: vi.fn(),
    onRemoteDelete: vi.fn(),
    onSaveError: vi.fn(),
    pathExists: vi.fn((path: string) => client.notes.has(path)),
  } satisfies NotesControllerHooks;
  const notes = new NotesController({ client, hooks, saveDelayMs: 300, retryDelayMs: 1000 });
  notes.adopt(note);
  const edit = (content: string, path = PATH) => {
    live.set(path, content);
    notes.markDirty(path);
  };
  return { client, notes, hooks, live, edit, states };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesController races", () => {
  it("flush() during an in-flight write resolves only once the newer edits are saved", async () => {
    const { client, notes, edit } = setup();
    client.hold = true;
    edit("- [ ] one");
    await vi.advanceTimersByTimeAsync(300);
    expect(client.writes).toHaveLength(1);
    edit("- [ ] one two");
    let flushed = false;
    const flush = notes.flush(PATH).then(() => {
      flushed = true;
    });
    client.releaseOne();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.writes).toHaveLength(2);
    expect(flushed, "must wait for the write carrying the newer edits").toBe(false);
    client.releaseOne();
    await flush;
    expect(client.notes.get(PATH)?.content).toBe("- [ ] one two");
    expect(notes.isDirty(PATH)).toBe(false);
  });

  it("renaming right after typing during a save moves the latest text (no stale or zombie copy)", async () => {
    // Workspace.renamePath: await flush, rename on the server, then move the bookkeeping.
    const { client, notes, edit, live } = setup();
    client.hold = true;
    edit("- [ ] draft");
    await vi.advanceTimersByTimeAsync(300);
    edit("- [ ] draft, finished");
    const renamed = (async () => {
      await notes.flush(PATH);
      client.rename(PATH, "Journal/renamed.md");
      notes.rename(PATH, "Journal/renamed.md");
      live.set("Journal/renamed.md", live.get(PATH)!);
      live.delete(PATH);
    })();
    client.releaseOne();
    await vi.advanceTimersByTimeAsync(0);
    client.hold = false;
    client.releaseOne();
    await renamed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.notes.get("Journal/renamed.md")?.content).toBe("- [ ] draft, finished");
    expect(client.notes.has(PATH), "the old path is not recreated").toBe(false);
    expect([...client.notes.keys()]).toEqual(["Journal/renamed.md"]);
  });

  it("a note deleted locally while its save is in flight is not recreated", async () => {
    const { client, notes, hooks, edit, states } = setup();
    client.hold = true;
    edit("- [ ] typed just before deleting");
    await vi.advanceTimersByTimeAsync(300);
    // Workspace.deletePath: the daemon deletes the note, then the controller forgets it.
    client.notes.delete(PATH);
    notes.forget(PATH);
    const statesBefore = states.length;
    client.hold = false;
    client.releaseOne();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.notes.has(PATH), "deleted note resurrected").toBe(false);
    expect(client.writes).toHaveLength(1);
    expect(hooks.onRemoteDelete).not.toHaveBeenCalled();
    expect(hooks.onSaveError).not.toHaveBeenCalled();
    expect(states.slice(statesBefore), "no save state for a forgotten note").toEqual([]);
  });

  it("a failed save of a forgotten note neither toasts nor retries", async () => {
    const { client, notes, hooks, edit } = setup();
    client.hold = true;
    client.failures.push(new NetworkError("offline"));
    edit("- [ ] x");
    await vi.advanceTimersByTimeAsync(300);
    notes.forget(PATH);
    client.hold = false;
    client.releaseOne();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks.onSaveError).not.toHaveBeenCalled();
    expect(client.writes).toHaveLength(1);
  });

  it("a remote change during an in-flight save is re-checked afterwards and shown", async () => {
    const { client, notes, edit, live, hooks } = setup();
    client.hold = true;
    edit("- [ ] mine");
    await vi.advanceTimersByTimeAsync(300);
    const remoteChange = notes.handleRemoteChange(PATH, "v-remote");
    client.hold = false;
    client.releaseOne();
    await remoteChange;
    await vi.advanceTimersByTimeAsync(0);
    // The remote edit lands after our write: it is newer, and we have no unsaved edits.
    const remote = client.seed(PATH, "- [ ] mine\n- [ ] from phone");
    await notes.handleRemoteChange(PATH, remote.version);
    expect(live.get(PATH)).toBe("- [ ] mine\n- [ ] from phone");
    expect(hooks.onConflictCopy).not.toHaveBeenCalled();
  });

  it("typing while the conflict copy is being written saves the newer text too", async () => {
    const { client, notes, edit, hooks } = setup();
    edit("- [ ] mine");
    client.seed(PATH, "- [ ] theirs");
    client.hold = true;
    await vi.advanceTimersByTimeAsync(300);
    client.releaseOne(); // 409 → the conflict copy write is now held
    await vi.advanceTimersByTimeAsync(0);
    edit("- [ ] mine, more");
    client.hold = false;
    while (client.held.length > 0) client.releaseOne();
    await vi.advanceTimersByTimeAsync(1000);
    expect(hooks.onConflictCopy).toHaveBeenCalledOnce();
    expect(client.notes.get("Daily/2026-09-23 (conflict).md")?.content).toBe("- [ ] theirs");
    expect(client.notes.get(PATH)?.content).toBe("- [ ] mine, more");
    expect(notes.isDirty(PATH)).toBe(false);
  });

  it("keeps typing through failures: one error report, backoff retry, latest text saved", async () => {
    const { client, notes, edit, hooks } = setup();
    client.failures.push(new NetworkError("offline"), new HttpError(500, "boom"));
    edit("- [ ] a");
    await vi.advanceTimersByTimeAsync(300);
    edit("- [ ] ab");
    await vi.advanceTimersByTimeAsync(300);
    edit("- [ ] abc");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.notes.get(PATH)?.content).toBe("- [ ] abc");
    expect(hooks.onSaveError).toHaveBeenCalledTimes(2);
    expect(notes.isDirty(PATH)).toBe(false);
    const writesAfter = client.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.writes, "pending retry timers don't write again").toHaveLength(writesAfter);
  });

  it("offline edits meet a remote change on reconnect: resync keeps both versions", async () => {
    const { client, notes, edit, hooks } = setup("- [ ] base");
    client.failures.push(new NetworkError("offline"));
    edit("- [ ] base, offline edit");
    await vi.advanceTimersByTimeAsync(300);
    expect(hooks.onSaveError).toHaveBeenCalledOnce();
    client.seed(PATH, "- [ ] base, edited on the laptop");
    await notes.handleRemoteChange(PATH); // Workspace.resync after the reconnect
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.notes.get(PATH)?.content).toBe("- [ ] base, offline edit");
    expect(client.notes.get("Daily/2026-09-23 (conflict).md")?.content).toBe(
      "- [ ] base, edited on the laptop",
    );
  });

  it("a note deleted elsewhere while a save is in flight is restored with the local text", async () => {
    const { client, notes, edit, hooks } = setup();
    client.hold = true;
    edit("- [ ] keep me");
    await vi.advanceTimersByTimeAsync(300);
    client.notes.delete(PATH);
    notes.handleRemoteDelete(PATH);
    client.hold = false;
    client.releaseOne();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.notes.get(PATH)?.content).toBe("- [ ] keep me");
    expect(hooks.onRemoteDelete).toHaveBeenCalledWith(PATH, true);
  });

  it("the same note in two controllers (two windows): the last writer wins, the other text is copied", async () => {
    const a = setup("- [ ] shared");
    const client = a.client;
    const b = new NotesController({
      client,
      hooks: { ...a.hooks, readLive: () => "- [ ] from window B" },
      saveDelayMs: 300,
    });
    b.adopt({ ...client.notes.get(PATH)! });
    a.edit("- [ ] from window A");
    b.markDirty(PATH);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    const contents = [...client.notes.values()].map((n) => n.content).sort();
    expect(contents).toEqual(["- [ ] from window A", "- [ ] from window B"]);
  });
});
