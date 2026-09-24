import type { NoteResponse, WriteNoteRequest, WriteNoteResponse } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ConflictError, HttpError, NetworkError } from "../api/errors";
import { type NotesClient, NotesController } from "./notes-controller";

const PATH = "Daily/2026-09-23.md";

interface Pending {
  client: number;
  describe: string;
  run(): void;
}

/**
 * In-memory daemon with a network whose requests the test delivers one by one, in any order.
 * It enforces the protocol (baseVersion → 409) and checks that no write ever silently overwrites
 * text the writing client never saw.
 */
class World {
  readonly notes = new Map<string, { content: string; version: string }>();
  readonly queue: Pending[] = [];
  readonly clients: Client[] = [];
  /** Every content the main note ever had, in order. */
  readonly history: string[] = [];
  offline = false;
  remoteChanges = 0;
  private versions = 0;

  write(path: string, content: string): string {
    const version = `v${++this.versions}`;
    this.notes.set(path, { content, version });
    if (path === PATH) this.history.push(content);
    return version;
  }

  /** Contents preserved in conflict copies. */
  copies(): Set<string> {
    const out = new Set<string>();
    for (const [path, note] of this.notes) if (path !== PATH) out.add(note.content);
    return out;
  }

  deliver(index: number): void {
    const [request] = this.queue.splice(index % this.queue.length, 1);
    request?.run();
  }

  /** Another device edits or deletes the note; clients hear about it through `vault.changed`. */
  remoteEdit(token: string): void {
    const current = this.notes.get(PATH);
    const version = this.write(PATH, `${current?.content ?? ""} ${token}`);
    this.remoteChanges++;
    for (const client of this.clients) void client.notes.handleRemoteChange(PATH, version);
  }

  remoteDelete(): void {
    if (!this.notes.delete(PATH)) return;
    this.remoteChanges++;
    for (const client of this.clients) client.notes.handleRemoteDelete(PATH);
  }
}

class Client implements NotesClient {
  readonly id: number;
  readonly notes: NotesController;
  live: string;
  active = true;
  /** The editor dropped its cached state for the note (a remote change arrived while hidden). */
  cacheDropped = false;
  forgotten = false;
  failNextWrite = false;
  /** Contents this client wrote, or had applied to its editor: overwriting those is informed. */
  readonly seen = new Set<string>();
  private readonly world: World;

  constructor(world: World, id: number) {
    this.world = world;
    this.id = id;
    this.notes = new NotesController({
      client: this,
      saveDelayMs: 300,
      retryDelayMs: 1000,
      hooks: {
        readLive: (path) => (path === PATH && this.active && !this.forgotten ? this.live : null),
        applyRemote: (_path, content) => {
          this.expectSaved("replacing the editor content with a remote version");
          this.seen.add(content);
          if (this.active) this.live = content;
          else this.cacheDropped = true;
        },
        onSaveState: () => {},
        onConflictCopy: () => {},
        onRemoteDelete: (_path, restored) => {
          if (restored) return;
          this.expectSaved("dropping a note deleted elsewhere");
          this.forgotten = true;
        },
        onSaveError: () => {},
        pathExists: (path) => world.notes.has(path),
      },
    });
    const note = world.notes.get(PATH)!;
    this.live = note.content;
    this.seen.add(note.content);
    this.notes.adopt({ path: PATH, content: note.content, version: note.version, mtime: 1 });
  }

  readNote(path: string): Promise<NoteResponse> {
    return new Promise((resolve, reject) => {
      this.world.queue.push({
        client: this.id,
        describe: `read ${path}`,
        run: () => {
          if (this.world.offline) return reject(new NetworkError("offline"));
          const note = this.world.notes.get(path);
          if (!note) return reject(new HttpError(404, "not found"));
          resolve({ path, content: note.content, version: note.version, mtime: 1 });
        },
      });
    });
  }

  writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    // The client's own text: a server version equal to it is not someone else's work.
    this.seen.add(body.content);
    return new Promise((resolve, reject) => {
      this.world.queue.push({
        client: this.id,
        describe: `write ${path}`,
        run: () => {
          if (this.world.offline || this.failNextWrite) {
            this.failNextWrite = false;
            return reject(new NetworkError("offline"));
          }
          const current = this.world.notes.get(path);
          const response = (): NoteResponse | null =>
            current ? { path, content: current.content, version: current.version, mtime: 1 } : null;
          if (body.baseVersion === null && current) return reject(new ConflictError(response()));
          if (typeof body.baseVersion === "string" && current?.version !== body.baseVersion) {
            return reject(new ConflictError(response()));
          }
          if (path === PATH && current && current.content !== body.content) {
            const informed =
              this.seen.has(current.content) || this.world.copies().has(current.content);
            expect(
              informed,
              `client ${this.id} overwrote text it never saw: ${JSON.stringify(current.content)}`,
            ).toBe(true);
          }
          const version = this.world.write(path, body.content);
          this.seen.add(body.content);
          resolve({ path, version, mtime: 1 });
          for (const other of this.world.clients) {
            if (other !== this && path === PATH) void other.notes.handleRemoteChange(path, version);
          }
        },
      });
    });
  }

  /** Local text may only be discarded once it exists on the server (the note or a copy). */
  private expectSaved(action: string): void {
    const text = this.shown();
    const saved = this.world.history.includes(text) || this.world.copies().has(text);
    expect(saved, `client ${this.id} lost ${JSON.stringify(text)} when ${action}`).toBe(true);
  }

  edit(token: string, remove: boolean): void {
    if (!this.active || this.forgotten || !this.notes.has(PATH)) return;
    const words = this.live.split(" ");
    this.live = remove && words.length > 1 ? words.slice(0, -1).join(" ") : `${this.live} ${token}`;
    this.notes.markDirty(PATH);
  }

  /** Tab switch away (the editor flushes before swapping the note out) or back. */
  toggleActive(): void {
    if (this.forgotten) return;
    if (this.active) {
      void this.notes.flush(PATH);
      this.active = false;
      return;
    }
    this.active = true;
    if (this.cacheDropped) {
      this.cacheDropped = false;
      this.live = this.notes.serverContent(PATH) ?? this.live;
    }
  }

  /** What the user sees for the note (or would see when switching back). */
  shown(): string {
    return this.cacheDropped ? (this.notes.serverContent(PATH) ?? this.live) : this.live;
  }
}

type Op =
  | { kind: "edit"; client: number; remove: boolean }
  | { kind: "advance"; ms: number }
  | { kind: "deliver"; index: number }
  | { kind: "flush"; client: number }
  | { kind: "tab"; client: number }
  | { kind: "failNextWrite"; client: number }
  | { kind: "offline"; on: boolean }
  | { kind: "resync"; client: number }
  | { kind: "remoteEdit" }
  | { kind: "remoteDelete" };

const client = fc.nat({ max: 1 });
const localOps: Array<fc.WeightedArbitrary<Op>> = [
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("edit"), client, remove: fc.boolean() }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("advance"),
      ms: fc.constantFrom(1, 50, 299, 300, 1000, 5000),
    }),
  },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("deliver"), index: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("flush"), client }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("tab"), client }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("failNextWrite"), client }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("offline"), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("resync"), client }) },
];
const remoteOps: Array<fc.WeightedArbitrary<Op>> = [
  { weight: 2, arbitrary: fc.constant({ kind: "remoteEdit" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "remoteDelete" as const }) },
];

async function flushPromises(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function run(ops: readonly Op[], clients: number): Promise<World> {
  const world = new World();
  world.write(PATH, "- [ ] start");
  for (let i = 0; i < clients; i++) world.clients.push(new Client(world, i));
  let tokens = 0;
  for (const o of ops) {
    const c = world.clients["client" in o ? o.client % clients : 0]!;
    switch (o.kind) {
      case "edit":
        c.edit(`c${c.id}e${tokens++}`, o.remove);
        break;
      case "advance":
        await vi.advanceTimersByTimeAsync(o.ms);
        break;
      case "deliver":
        if (world.queue.length > 0) world.deliver(o.index);
        break;
      case "flush":
        if (!c.forgotten) void c.notes.flush(PATH);
        break;
      case "tab":
        c.toggleActive();
        break;
      case "failNextWrite":
        c.failNextWrite = true;
        break;
      case "offline":
        world.offline = o.on;
        break;
      case "resync":
        if (!world.offline && !c.forgotten) void c.notes.handleRemoteChange(PATH);
        break;
      case "remoteEdit":
        world.remoteEdit(`r${tokens++}`);
        break;
      case "remoteDelete":
        world.remoteDelete();
        break;
    }
    await flushPromises();
  }
  // Back online: deliver everything and let retries/debounces run until nothing is pending.
  world.offline = false;
  for (const c of world.clients) {
    c.failNextWrite = false;
    if (!c.active) c.toggleActive();
  }
  for (const c of world.clients) if (!c.forgotten) void c.notes.handleRemoteChange(PATH);
  for (let i = 0; i < 400; i++) {
    await flushPromises();
    if (world.queue.length > 0) {
      world.deliver(0);
      continue;
    }
    const busy = world.clients.some((c) => !c.forgotten && c.notes.isBusy(PATH));
    if (!busy && vi.getTimerCount() === 0) break;
    await vi.advanceTimersByTimeAsync(31_000);
  }
  return world;
}

function expectConverged(world: World): void {
  expect(world.queue, "nothing left in flight").toEqual([]);
  const server = world.notes.get(PATH);
  for (const c of world.clients) {
    if (c.forgotten) {
      expect(c.notes.has(PATH)).toBe(false);
      continue;
    }
    expect(server, "a note with local edits is never lost").toBeDefined();
    expect(c.notes.isDirty(PATH)).toBe(false);
    expect(c.shown(), `client ${c.id} shows what is saved`).toBe(server!.content);
    expect(c.notes.version(PATH)).toBe(server!.version);
  }
  if (!server) expect(world.clients.every((c) => c.forgotten)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesController under random races (model-based)", () => {
  test.prop([fc.array(fc.oneof(...localOps), { minLength: 1, maxLength: 40 })])(
    "one tab, no remote changes: the server converges to the last local edit, without conflicts",
    async (ops) => {
      const world = await run(ops, 1);
      expectConverged(world);
      const [only] = world.clients;
      expect(world.notes.get(PATH)?.content).toBe(only!.live);
      expect(world.notes.size, "no conflict copies").toBe(1);
    },
  );

  test.prop([fc.array(fc.oneof(...localOps, ...remoteOps), { minLength: 1, maxLength: 40 })])(
    "one tab with remote edits/deletes: nothing is overwritten unseen and everything converges",
    async (ops) => {
      expectConverged(await run(ops, 1));
    },
  );

  test.prop([fc.array(fc.oneof(...localOps, ...remoteOps), { minLength: 1, maxLength: 50 })])(
    "two tabs (or devices) on the same note: no text lost, both converge",
    async (ops) => {
      expectConverged(await run(ops, 2));
    },
  );
});
