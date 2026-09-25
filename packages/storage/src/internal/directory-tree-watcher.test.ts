import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilEventsFlow } from "../testing/fs-events";
import { type DirectoryTreeWatcher, watchDirectoryTree } from "./directory-tree-watcher";

describe("watchDirectoryTree", { timeout: 60_000 }, () => {
  let dir: string;
  let root: string;
  let events: string[];
  let errors: unknown[];
  let watcher: DirectoryTreeWatcher | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ddl-tree-"));
    root = join(dir, "vault");
    mkdirSync(root);
    events = [];
    errors = [];
  });

  afterEach(() => {
    watcher?.close();
    watcher = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function start(skip?: (path: string) => boolean): DirectoryTreeWatcher {
    watcher = watchDirectoryTree(root, (_type, name) => events.push(name ?? "<unknown>"), {
      ...(skip ? { skip } : {}),
    });
    watcher.on("error", (error) => errors.push(error));
    return watcher;
  }

  const sawEvent = (path: string) =>
    vi.waitFor(() => expect(events).toContain(path), { timeout: 10_000, interval: 10 });

  /**
   * Returns once changes in each of `dirs` (vault-relative, `""` = root) get reported. Needed
   * after every change to the set of watched folders: see `untilEventsFlow`.
   */
  async function eventsFlowIn(...dirs: string[]): Promise<void> {
    const probes = dirs.map((d) => (d === "" ? ".probe" : `${d}/.probe`));
    await untilEventsFlow(
      async (attempt) => {
        await Promise.all(probes.map((p) => writeFile(join(root, p), String(attempt))));
      },
      () => probes.every((p) => events.includes(p)),
    );
    events.length = 0;
  }

  it("reports in-place edits to a file that an atomic save replaced", async () => {
    await writeFile(join(root, "note.md"), "v1");
    start();
    await eventsFlowIn("");
    await writeFile(join(root, ".note.md.tmp"), "v2");
    await rename(join(root, ".note.md.tmp"), join(root, "note.md"));
    await sawEvent("note.md");
    events.length = 0;
    // An editor that writes in place: Node's recursive mode on Linux misses this one.
    await writeFile(join(root, "note.md"), "v3");
    await sawEvent("note.md");
    expect(errors).toEqual([]);
  });

  it("watches folders created later, including nested ones", async () => {
    const w = start();
    await eventsFlowIn("");
    await mkdir(join(root, "New", "Deep"), { recursive: true });
    await sawEvent("New");
    await vi.waitFor(() => expect(w.watchedDirectories).toContain("New/Deep"), { timeout: 10_000 });
    await eventsFlowIn("New/Deep");
    await writeFile(join(root, "New", "Deep", "x.md"), "x");
    await sawEvent("New/Deep/x.md");
  });

  it("stops watching folders that are removed or moved away", async () => {
    mkdirSync(join(root, "Gone", "Inner"), { recursive: true });
    mkdirSync(join(root, "Moved"));
    const w = start();
    expect(w.watchedDirectories).toEqual(["", "Gone", "Gone/Inner", "Moved"]);
    await eventsFlowIn("", "Gone", "Gone/Inner", "Moved");
    await rm(join(root, "Gone"), { recursive: true });
    await vi.waitFor(() => expect(w.watchedDirectories).toEqual(["", "Moved"]), {
      timeout: 10_000,
    });
    await eventsFlowIn("", "Moved");
    await rename(join(root, "Moved"), join(root, "Renamed"));
    await vi.waitFor(() => expect(w.watchedDirectories).toEqual(["", "Renamed"]), {
      timeout: 10_000,
    });
    await eventsFlowIn("Renamed");
    await writeFile(join(root, "Renamed", "y.md"), "y");
    await sawEvent("Renamed/y.md");
    expect(errors).toEqual([]);
  });

  it("does not follow symlinked folders or enter skipped ones", () => {
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(root, "link"));
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    mkdirSync(join(root, "Notes"));
    const w = start((path) => path.startsWith("."));
    expect(w.watchedDirectories).toEqual(["", "Notes"]);
  });

  it("closes every directory watch", () => {
    mkdirSync(join(root, "A", "B"), { recursive: true });
    const w = start();
    expect(w.watchedDirectories).toHaveLength(3);
    w.close();
    expect(w.watchedDirectories).toEqual([]);
  });

  it("throws when the root cannot be watched", () => {
    expect(() => watchDirectoryTree(join(dir, "missing"), () => {})).toThrow();
  });
});
