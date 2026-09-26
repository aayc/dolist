import { InvalidPathError } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToFile } from "./append";
import { utf8ByteLength } from "./file-types";
import { ConflictError, NotFoundError, type StorageEvent, type StorageProvider } from "./types";

export interface StorageContractSubject {
  /** A fresh, empty provider. */
  provider: StorageProvider;
  /** Runs after `provider.dispose()`, e.g. to delete a temp folder. */
  cleanup?: () => Promise<void> | void;
}

export type StorageContractFactory = () => Promise<StorageContractSubject> | StorageContractSubject;

/**
 * Shared behavioural tests every StorageProvider must pass. Call from a `*.test.ts` file:
 * `describeStorageContract("MyProvider", async () => ({ provider: new MyProvider() }))`.
 */
export function describeStorageContract(name: string, factory: StorageContractFactory): void {
  describe(`${name} satisfies the StorageProvider contract`, () => {
    let subject: StorageContractSubject;
    let s: StorageProvider;

    beforeEach(async () => {
      subject = await factory();
      s = subject.provider;
    });

    afterEach(async () => {
      await s.dispose();
      await subject.cleanup?.();
    });

    it("exposes identity and capabilities", () => {
      expect(["local", "memory", "remote"]).toContain(s.kind);
      expect(s.id).toMatch(/\S/);
      expect(typeof s.displayName).toBe("string");
      expect(typeof s.capabilities.watch).toBe("boolean");
      expect(typeof s.capabilities.atomicWrites).toBe("boolean");
      expect(typeof s.capabilities.folders).toBe("boolean");
    });

    it("writes, reads and stats a file", async () => {
      const content = "- [ ] water the plants\n";
      const w = await s.write("Daily/2026-09-23.md", content);
      expect(w).toMatchObject({ path: "Daily/2026-09-23.md", created: true });
      expect(w.size).toBe(utf8ByteLength(content));
      expect(Number.isFinite(w.mtime)).toBe(true);

      const r = await s.read("Daily/2026-09-23.md");
      expect(r).toEqual({
        path: w.path,
        content,
        version: w.version,
        size: w.size,
        mtime: w.mtime,
      });
      expect(await s.stat("Daily/2026-09-23.md")).toEqual({
        path: w.path,
        version: w.version,
        size: w.size,
        mtime: w.mtime,
      });

      const w2 = await s.write("Daily/2026-09-23.md", "- [x] water the plants\n");
      expect(w2.created).toBe(false);
      expect(w2.version).not.toBe(w.version);
    });

    it("derives versions from content", async () => {
      const a = await s.write("a.md", "same");
      const again = await s.write("a.md", "same");
      expect(again.version).toBe(a.version);
      const changed = await s.write("a.md", "different");
      expect(changed.version).not.toBe(a.version);
    });

    it("round-trips text exactly", async () => {
      const samples = [
        "",
        "no trailing newline",
        "crlf\r\nlines\r\n",
        "emoji 🎉 · ümlaut · 日本語\n",
      ];
      for (const [i, content] of samples.entries()) {
        const w = await s.write(`samples/${i}.md`, content);
        expect(w.size).toBe(utf8ByteLength(content));
        expect((await s.read(`samples/${i}.md`))?.content).toBe(content);
      }
    });

    it("returns null for missing files", async () => {
      expect(await s.read("missing.md")).toBeNull();
      expect(await s.stat("missing.md")).toBeNull();
      expect(await s.read("no/such/folder/file.md")).toBeNull();
    });

    it("normalizes paths", async () => {
      const w = await s.write("./Notes//idea.md", "x");
      expect(w.path).toBe("Notes/idea.md");
      expect((await s.read("Notes\\idea.md"))?.path).toBe("Notes/idea.md");
      expect((await s.list()).map((f) => f.path)).toEqual(["Notes/idea.md"]);
    });

    it("rejects paths that escape the vault", async () => {
      await s.write("a.md", "x");
      await expect(s.read("../outside.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.write("Notes/../../outside.md", "x")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.delete("../outside.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.rename("a.md", "../b.md")).rejects.toBeInstanceOf(InvalidPathError);
      expect((await s.read("a.md"))?.content).toBe("x");
    });

    it("enforces conditional writes", async () => {
      const w = await s.write("a.md", "one");
      const stale = s.write("a.md", "two", { ifMatch: "stale-version" });
      await expect(stale).rejects.toBeInstanceOf(ConflictError);
      await expect(stale).rejects.toMatchObject({ currentVersion: w.version, path: "a.md" });
      await expect(s.write("a.md", "two", { ifMatch: null })).rejects.toBeInstanceOf(ConflictError);
      expect((await s.read("a.md"))?.content).toBe("one");

      await expect(s.write("a.md", "two", { ifMatch: w.version })).resolves.toMatchObject({
        created: false,
      });
      await expect(s.write("new.md", "x", { ifMatch: null })).resolves.toMatchObject({
        created: true,
      });
      await expect(s.write("absent.md", "x", { ifMatch: "some-version" })).rejects.toMatchObject({
        currentVersion: null,
      });
      expect(await s.stat("absent.md")).toBeNull();
    });

    it("appends (natively or through appendToFile), honoring preconditions", async () => {
      const journal = ".daily-do-list/state/journal/threads/thr_a.jsonl";
      for (const path of ["log.md", journal]) {
        const first = await appendToFile(s, path, '{"id":"1"}\n', { ifMatch: null });
        expect(first).toMatchObject({ path, created: true });
        const second = await appendToFile(s, path, '{"id":"2"} ✓\n', { ifMatch: first.version });
        expect(second).toMatchObject({ created: false });
        expect(second.version).not.toBe(first.version);
        expect(second.size).toBe(utf8ByteLength('{"id":"1"}\n{"id":"2"} ✓\n'));
        const read = await s.read(path);
        expect(read).toMatchObject({
          content: '{"id":"1"}\n{"id":"2"} ✓\n',
          version: second.version,
        });
        expect((await s.stat(path))?.version).toBe(second.version);
        await expect(
          appendToFile(s, path, "x\n", { ifMatch: first.version }),
        ).rejects.toMatchObject({
          currentVersion: second.version,
        });
        await expect(appendToFile(s, path, "x\n", { ifMatch: null })).rejects.toBeInstanceOf(
          ConflictError,
        );
        expect((await s.read(path))?.content).toBe('{"id":"1"}\n{"id":"2"} ✓\n');
        await expect(appendToFile(s, path, "3\n")).resolves.toMatchObject({ created: false });
      }
      await expect(
        appendToFile(s, "absent.md", "x", { ifMatch: "some-version" }),
      ).rejects.toMatchObject({ currentVersion: null });
      expect(await s.stat("absent.md")).toBeNull();
    });

    it("lets exactly one of several concurrent create-only writes win", async () => {
      const results = await Promise.allSettled(
        [0, 1, 2, 3, 4].map((i) => s.write("race.md", `writer ${i}`, { ifMatch: null })),
      );
      const winners = results.filter((r) => r.status === "fulfilled");
      const losers = results.filter((r) => r.status === "rejected");
      expect(winners).toHaveLength(1);
      for (const loser of losers) expect(loser.reason).toBeInstanceOf(ConflictError);
      const content = (await s.read("race.md"))?.content;
      expect(content).toMatch(/^writer \d$/);
    });

    it("deletes files, honoring preconditions", async () => {
      const w = await s.write("a.md", "x");
      await expect(s.delete("a.md", { ifMatch: "stale-version" })).rejects.toBeInstanceOf(
        ConflictError,
      );
      await expect(s.delete("a.md", { ifMatch: null })).rejects.toBeInstanceOf(ConflictError);
      expect(await s.stat("a.md")).not.toBeNull();
      await s.delete("a.md", { ifMatch: w.version });
      expect(await s.read("a.md")).toBeNull();
      await expect(s.delete("a.md")).rejects.toBeInstanceOf(NotFoundError);
      await expect(s.delete("a.md", { ifMatch: w.version })).rejects.toMatchObject({
        currentVersion: null,
      });
      await s.write("b.md", "y");
      await s.delete("b.md");
      expect(await s.list()).toEqual([]);
    });

    it("renames files", async () => {
      const w = await s.write("Inbox/a.md", "content");
      const r = await s.rename("Inbox/a.md", "Archive/2026/a.md");
      expect(r).toMatchObject({ path: "Archive/2026/a.md", version: w.version, created: true });
      expect(r.size).toBe(w.size);
      expect(await s.read("Inbox/a.md")).toBeNull();
      expect((await s.read("Archive/2026/a.md"))?.content).toBe("content");

      const other = await s.write("other.md", "other");
      await expect(s.rename("Archive/2026/a.md", "other.md")).rejects.toMatchObject({
        name: "ConflictError",
        currentVersion: other.version,
      });
      expect((await s.read("Archive/2026/a.md"))?.content).toBe("content");
      expect((await s.read("other.md"))?.content).toBe("other");
      await expect(s.rename("other.md", "other.md")).rejects.toBeInstanceOf(ConflictError);
      await expect(s.rename("missing.md", "x.md")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("lists files in code-point order, filtered by prefix and visibility", async () => {
      const files = {
        "b.md": "b",
        "a.md": "a",
        "Daily/2026-09-23.md": "today",
        "Daily/Archive/2026-01-01.md": "old",
        "Dailyish/x.md": "x",
        ".daily-do-list/threads/t.json": "{}",
        ".obsidian/app.json": "{}",
      };
      for (const [path, content] of Object.entries(files)) await s.write(path, content);

      expect((await s.list()).map((f) => f.path)).toEqual([
        "Daily/2026-09-23.md",
        "Daily/Archive/2026-01-01.md",
        "Dailyish/x.md",
        "a.md",
        "b.md",
      ]);
      expect((await s.list({ includeHidden: true })).map((f) => f.path)).toEqual([
        ".daily-do-list/threads/t.json",
        ".obsidian/app.json",
        "Daily/2026-09-23.md",
        "Daily/Archive/2026-01-01.md",
        "Dailyish/x.md",
        "a.md",
        "b.md",
      ]);
      const daily = ["Daily/2026-09-23.md", "Daily/Archive/2026-01-01.md"];
      expect((await s.list({ prefix: "Daily" })).map((f) => f.path)).toEqual(daily);
      expect((await s.list({ prefix: "Daily/" })).map((f) => f.path)).toEqual(daily);
      expect(await s.list({ prefix: ".daily-do-list" })).toEqual([]);
      expect(
        (await s.list({ prefix: ".daily-do-list", includeHidden: true })).map((f) => f.path),
      ).toEqual([".daily-do-list/threads/t.json"]);
      expect(await s.list({ prefix: "Nope" })).toEqual([]);

      for (const entry of await s.list({ includeHidden: true })) {
        expect(entry).toEqual(await s.stat(entry.path));
      }
    });

    it("lists folders", async () => {
      for (const path of ["Daily/Archive/old.md", "Dailyish/x.md", ".obsidian/app.json", "a.md"]) {
        await s.write(path, "x");
      }
      expect(await s.listFolders()).toEqual(["Daily", "Daily/Archive", "Dailyish"]);
      expect(await s.listFolders({ includeHidden: true })).toEqual([
        ".obsidian",
        "Daily",
        "Daily/Archive",
        "Dailyish",
      ]);
      expect(await s.listFolders({ prefix: "Daily" })).toEqual(["Daily", "Daily/Archive"]);
    });

    it("creates empty folders idempotently", async () => {
      await s.createFolder("Projects/Empty");
      await s.createFolder("Projects/Empty");
      expect(await s.listFolders()).toEqual(["Projects", "Projects/Empty"]);
      expect(await s.list()).toEqual([]);
    });

    it("deletes folders recursively with an event per file", async () => {
      await s.write("Projects/Kyoto/plan.md", "a");
      await s.write("Projects/Kyoto/Days/day1.md", "b");
      await s.write("Projects/keep.md", "c");
      await s.createFolder("Projects/Kyoto/Empty");
      const events: StorageEvent[] = [];
      const off = s.watch((event) => events.push(event));
      await s.deleteFolder("Projects/Kyoto");
      off();
      expect((await s.list()).map((f) => f.path)).toEqual(["Projects/keep.md"]);
      expect(await s.listFolders()).toEqual(["Projects"]);
      expect(
        events
          .filter((e) => e.self)
          .map((e) => `${e.kind}:${e.path}`)
          .sort(),
      ).toEqual(["deleted:Projects/Kyoto/Days/day1.md", "deleted:Projects/Kyoto/plan.md"]);
      await expect(s.deleteFolder("Projects/Kyoto")).rejects.toBeInstanceOf(NotFoundError);
      await expect(s.deleteFolder("")).rejects.toThrow();
    });

    it("emits self events for its own changes", async () => {
      const events: StorageEvent[] = [];
      const off = s.watch((event) => events.push(event));
      const created = await s.write("a.md", "one");
      const modified = await s.write("a.md", "two");
      await s.rename("a.md", "b.md");
      await s.delete("b.md");

      expect(events.filter((e) => e.self)).toEqual([
        { kind: "created", path: "a.md", version: created.version, self: true },
        { kind: "modified", path: "a.md", version: modified.version, self: true },
        { kind: "deleted", path: "a.md", self: true },
        { kind: "created", path: "b.md", version: modified.version, self: true },
        { kind: "deleted", path: "b.md", self: true },
      ]);

      off();
      const before = events.length;
      await s.write("c.md", "x");
      expect(events.length).toBe(before);
    });
  });
}
