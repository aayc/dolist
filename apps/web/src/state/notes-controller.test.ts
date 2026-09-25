import type { NoteResponse, WriteNoteRequest, WriteNoteResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError, NetworkError } from "../api/errors";
import { type NotesClient, NotesController, type NotesControllerHooks } from "./notes-controller";
import type { SaveState } from "./notes-store";

class FakeClient implements NotesClient {
  readonly notes = new Map<string, NoteResponse>();
  readonly writes: Array<{ path: string; body: WriteNoteRequest }> = [];
  private counter = 0;
  holdWrites = false;
  private held: Array<() => void> = [];
  failNext: unknown = null;

  seed(path: string, content: string): NoteResponse {
    const note = { path, content, version: `v${++this.counter}`, mtime: 1 };
    this.notes.set(path, note);
    return note;
  }

  release(): void {
    const held = this.held;
    this.held = [];
    for (const resolve of held) resolve();
  }

  async readNote(path: string): Promise<NoteResponse> {
    const note = this.notes.get(path);
    if (!note) throw new HttpError(404, "not found");
    return { ...note };
  }

  async writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    this.writes.push({ path, body });
    if (this.holdWrites) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const current = this.notes.get(path);
    if (body.baseVersion === null && current) throw new ConflictError({ ...current });
    if (typeof body.baseVersion === "string" && current?.version !== body.baseVersion) {
      throw new ConflictError(current ? { ...current } : null);
    }
    const note = this.seed(path, body.content);
    return { path, version: note.version, mtime: note.mtime };
  }
}

function setup(initial = "- [ ] ") {
  const client = new FakeClient();
  const note = client.seed("Daily/2026-09-23.md", initial);
  const live = new Map<string, string>();
  const states: Array<[string, SaveState | null]> = [];
  const show = (path: string, content: string) => {
    if (live.has(path)) live.set(path, content);
  };
  const hooks = {
    readLive: vi.fn((path: string) => live.get(path) ?? null),
    applyRemote: vi.fn(show),
    applyMerge: vi.fn(show),
    onSaveState: vi.fn((path: string, state: SaveState | null) => states.push([path, state])),
    onConflictCopy: vi.fn(),
    onRemoteDelete: vi.fn(),
    onSaveError: vi.fn(),
    pathExists: vi.fn((path: string) => client.notes.has(path)),
  } satisfies NotesControllerHooks;
  const notes = new NotesController({ client, hooks, saveDelayMs: 300, retryDelayMs: 1000 });
  notes.adopt(note);
  live.set(note.path, initial);
  const edit = (content: string) => {
    live.set(note.path, content);
    notes.markDirty(note.path);
  };
  const lastState = () => states.filter(([p]) => p === note.path).at(-1)?.[1];
  return { client, notes, hooks, live, path: note.path, edit, lastState, states };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesController autosave", () => {
  it("debounces edits into one write with the latest content", async () => {
    const { client, edit, lastState, path } = setup();
    edit("- [ ] B");
    await vi.advanceTimersByTimeAsync(100);
    edit("- [ ] Bu");
    await vi.advanceTimersByTimeAsync(100);
    edit("- [ ] Buy milk");
    expect(lastState()).toBe("dirty");
    await vi.advanceTimersByTimeAsync(299);
    expect(client.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.writes).toHaveLength(1);
    expect(client.writes[0]?.body).toEqual({ content: "- [ ] Buy milk", baseVersion: "v1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastState()).toBe("saved");
    expect(client.notes.get(path)?.content).toBe("- [ ] Buy milk");
  });

  it("reports state transitions only (not per keystroke)", async () => {
    const { edit, states } = setup();
    for (let i = 0; i < 20; i++) edit(`- [ ] ${"x".repeat(i)}`);
    expect(states.map(([, s]) => s)).toEqual(["saved", "dirty"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(states.map(([, s]) => s)).toEqual(["saved", "dirty", "saving", "saved"]);
  });

  it("keeps a single write in flight and saves newer edits afterwards on the new version", async () => {
    const { client, notes, edit, path } = setup();
    client.holdWrites = true;
    edit("- [ ] one");
    await vi.advanceTimersByTimeAsync(300);
    expect(client.writes).toHaveLength(1);
    edit("- [ ] one two");
    void notes.flush(path);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.writes).toHaveLength(1);
    client.holdWrites = false;
    client.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.writes).toHaveLength(2);
    expect(client.writes[1]?.body).toEqual({ content: "- [ ] one two", baseVersion: "v2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(notes.isDirty(path)).toBe(false);
  });

  it("flush captures content synchronously so the note can leave the editor", async () => {
    const { client, notes, edit, live, path } = setup();
    edit("- [ ] draft");
    const flushed = notes.flush(path);
    live.delete(path);
    await flushed;
    expect(client.notes.get(path)?.content).toBe("- [ ] draft");
  });

  it("retries failed saves with backoff and reports the error once per failure", async () => {
    const { client, edit, hooks, lastState, path } = setup();
    client.failNext = new NetworkError("offline");
    edit("- [ ] retry me");
    await vi.advanceTimersByTimeAsync(300);
    expect(hooks.onSaveError).toHaveBeenCalledOnce();
    expect(lastState()).toBe("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastState()).toBe("saved");
    expect(client.notes.get(path)?.content).toBe("- [ ] retry me");
  });
});

describe("NotesController conflicts", () => {
  it("keeps local edits and preserves the remote version as a conflict copy", async () => {
    const { client, edit, hooks, path } = setup();
    edit("- [ ] mine");
    client.seed(path, "- [ ] theirs");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    const copy = "Daily/2026-09-23 (conflict).md";
    expect(client.notes.get(copy)?.content).toBe("- [ ] theirs");
    expect(client.notes.get(path)?.content).toBe("- [ ] mine");
    expect(hooks.onConflictCopy).toHaveBeenCalledWith(path, copy);
  });

  it("numbers conflict copies when one already exists", async () => {
    const { client, edit, path } = setup();
    client.seed("Daily/2026-09-23 (conflict).md", "older copy");
    edit("- [ ] mine");
    client.seed(path, "- [ ] theirs");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.notes.get("Daily/2026-09-23 (conflict 2).md")?.content).toBe("- [ ] theirs");
  });

  it("takes the remote version when there are no real local changes", async () => {
    const { client, edit, hooks, live, path } = setup("- [ ] same");
    edit("- [ ] same");
    client.seed(path, "- [ ] updated elsewhere");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.onConflictCopy).not.toHaveBeenCalled();
    expect(hooks.applyRemote).toHaveBeenCalledWith(path, "- [ ] updated elsewhere");
    expect(live.get(path)).toBe("- [ ] updated elsewhere");
  });

  it("recreates a note deleted elsewhere when local edits exist", async () => {
    const { client, edit, hooks, path } = setup();
    edit("- [ ] keep me");
    client.notes.delete(path);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.notes.get(path)?.content).toBe("- [ ] keep me");
    expect(hooks.onRemoteDelete).toHaveBeenCalledWith(path, true);
  });
});

describe("NotesController remote changes", () => {
  it("applies remote content when there are no pending edits", async () => {
    const { client, notes, hooks, path } = setup();
    const remote = client.seed(path, "- [ ] from another device");
    await notes.handleRemoteChange(path, remote.version);
    expect(hooks.applyRemote).toHaveBeenCalledWith(path, "- [ ] from another device");
    expect(notes.version(path)).toBe(remote.version);
  });

  it("ignores changes that match the known version", async () => {
    const { notes, hooks, path } = setup();
    await notes.handleRemoteChange(path, notes.version(path) ?? undefined);
    expect(hooks.applyRemote).not.toHaveBeenCalled();
  });

  it("marks a conflict while dirty and resolves it on the next save", async () => {
    const { client, notes, edit, hooks, lastState, path } = setup();
    edit("- [ ] local");
    client.seed(path, "- [ ] remote");
    await notes.handleRemoteChange(path);
    expect(lastState()).toBe("conflict");
    expect(hooks.applyRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastState()).toBe("saved");
    expect(client.notes.get(path)?.content).toBe("- [ ] local");
    expect(hooks.onConflictCopy).toHaveBeenCalled();
  });

  it("merges an agent edit into unsaved typing and saves the merge on the new version", async () => {
    const base = "- [ ] Book a table\n- [ ] Call mom";
    const { client, notes, edit, hooks, live, lastState, path } = setup(base);
    edit("- [ ] Book a table\n- [ ] Call mom tonight");
    const agent = client.seed(
      path,
      "- [ ] Book a table\n\t- Trattoria Sole at 7 %%agent:thr_1%%\n- [ ] Call mom",
    );
    await notes.handleRemoteChange(path, agent.version);
    const merged =
      "- [ ] Book a table\n\t- Trattoria Sole at 7 %%agent:thr_1%%\n- [ ] Call mom tonight";
    expect(hooks.applyMerge).toHaveBeenCalledWith(path, merged);
    expect(hooks.applyRemote).not.toHaveBeenCalled();
    expect(live.get(path)).toBe(merged);
    expect(lastState()).toBe("dirty");
    expect(notes.version(path)).toBe(agent.version);

    await vi.advanceTimersByTimeAsync(300);
    expect(client.writes.at(-1)?.body).toEqual({ content: merged, baseVersion: agent.version });
    expect(client.notes.get(path)?.content).toBe(merged);
    expect(hooks.onConflictCopy).not.toHaveBeenCalled();
    expect(lastState()).toBe("saved");
  });

  it("merges when the save meets the agent's change (409)", async () => {
    const { client, edit, hooks, live, path } = setup("- [ ] a\n- [ ] b");
    edit("- [ ] a!\n- [ ] b");
    const agent = client.seed(path, "- [ ] a\n- [ ] b\n- [ ] c %%agent%%");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.writes.map((w) => w.body)).toEqual([
      { content: "- [ ] a!\n- [ ] b", baseVersion: "v1" },
      { content: "- [ ] a!\n- [ ] b\n- [ ] c %%agent%%", baseVersion: agent.version },
    ]);
    expect(live.get(path)).toBe("- [ ] a!\n- [ ] b\n- [ ] c %%agent%%");
    expect(hooks.onConflictCopy).not.toHaveBeenCalled();
  });

  it("a save meeting the same edit plus the agent's line under it keeps that line (no copy)", async () => {
    // The fuzz test's shrunk counterexample: both tabs cut "start", then the agent added a line.
    const { client, edit, hooks, live, path } = setup("- [ ] start");
    edit("- [ ]");
    client.seed(path, "- [ ]\n- a3 %%agent%%");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.notes.get(path)?.content).toBe("- [ ]\n- a3 %%agent%%");
    expect(live.get(path)).toBe("- [ ]\n- a3 %%agent%%");
    expect(hooks.onConflictCopy).not.toHaveBeenCalled();
  });

  it("keeps typing that happens while the merge is being saved", async () => {
    const { client, notes, edit, live, path } = setup("- [ ] a\n- [ ] b");
    edit("- [ ] a1\n- [ ] b");
    client.seed(path, "- [ ] a\n- [ ] b\n- note %%agent%%");
    client.holdWrites = true;
    await vi.advanceTimersByTimeAsync(300); // first write held
    client.release();
    await vi.advanceTimersByTimeAsync(0); // 409 → merge → merged write held
    expect(live.get(path)).toBe("- [ ] a1\n- [ ] b\n- note %%agent%%");
    edit("- [ ] a12\n- [ ] b\n- note %%agent%%");
    client.holdWrites = false;
    client.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.notes.get(path)?.content).toBe("- [ ] a12\n- [ ] b\n- note %%agent%%");
    expect(notes.isDirty(path)).toBe(false);
  });

  it("takes the other version once when it already has the local edits", async () => {
    const { client, notes, edit, hooks, lastState, path } = setup("- [ ] a");
    edit("- [x] a");
    const remote = client.seed(path, "- [x] a");
    await notes.handleRemoteChange(path, remote.version);
    expect(hooks.applyMerge).not.toHaveBeenCalled();
    expect(lastState()).toBe("saved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.writes).toHaveLength(0);
  });

  it("merges into a note that is no longer in the editor", async () => {
    const { client, notes, edit, hooks, live, path } = setup("- [ ] a\n- [ ] b");
    edit("- [ ] a, edited\n- [ ] b");
    client.holdWrites = true;
    const flushed = notes.flush(path); // the note leaves the editor with its edits in flight
    live.delete(path);
    const agent = client.seed(path, "- [ ] a\n- [ ] b\n- found it %%agent%%");
    client.holdWrites = false;
    client.release();
    await flushed;
    await vi.advanceTimersByTimeAsync(0);
    const merged = "- [ ] a, edited\n- [ ] b\n- found it %%agent%%";
    expect(hooks.applyMerge).toHaveBeenCalledWith(path, merged);
    expect(client.writes.at(-1)?.body).toEqual({ content: merged, baseVersion: agent.version });
    expect(client.notes.get(path)?.content).toBe(merged);
  });

  it("forgets a clean note deleted elsewhere", async () => {
    const { client, notes, hooks, path } = setup();
    client.notes.delete(path);
    await notes.handleRemoteChange(path);
    expect(notes.has(path)).toBe(false);
    expect(hooks.onRemoteDelete).toHaveBeenCalledWith(path, false);
  });

  it("moves bookkeeping on rename", () => {
    const { notes, path } = setup();
    notes.rename("Daily", "Journal");
    expect(notes.has(path)).toBe(false);
    expect(notes.has("Journal/2026-09-23.md")).toBe(true);
  });
});
