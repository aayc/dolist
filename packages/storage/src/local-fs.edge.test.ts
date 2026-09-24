import {
  chmod,
  stat as fsStat,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { contentVersion } from "./memory";
import { ConflictError, StorageError, type StorageEvent } from "./types";

const NFC = "Caf\u00e9";
const NFD = "Cafe\u0301";
const unix = process.platform !== "win32";
const root = typeof process.getuid === "function" && process.getuid() === 0;

describe("LocalFsStorageProvider edge cases", () => {
  let dir: string;
  let vault: string;
  let s: LocalFsStorageProvider;
  let events: StorageEvent[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-edge-"));
    vault = join(dir, "vault");
    s = new LocalFsStorageProvider({ root: vault });
    await s.init();
    events = [];
  });

  afterEach(async () => {
    await s.dispose();
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  /** Whether the disk treats these two names as the same entry (macOS APFS: yes). */
  async function folds(a: string, b: string): Promise<boolean> {
    const probe = join(dir, `probe-${a}`);
    await writeFile(probe, "x");
    const same = await fsStat(join(dir, `probe-${b}`)).then(
      () => true,
      () => false,
    );
    await rm(probe);
    return same;
  }

  const selfEvents = () => events.filter((e) => e.self).map((e) => `${e.kind} ${e.path}`);

  describe("spellings the disk folds together (case, Unicode normalization)", () => {
    it("reports one file under its on-disk spelling, whatever spelling the caller used", async () => {
      const caseFolds = await folds("Probe.md", "probe.md");
      s.watch((e) => events.push(e));
      await s.write("Notes/a.md", "one");
      const second = await s.write("Notes/A.md", "two");
      if (caseFolds) {
        expect(second).toMatchObject({ path: "Notes/a.md", created: false });
        expect((await s.list()).map((f) => f.path)).toEqual(["Notes/a.md"]);
        expect((await s.read("NOTES/A.MD"))?.path).toBe("Notes/a.md");
        expect((await s.stat("notes/a.md"))?.version).toBe(contentVersion("two"));
        expect((await s.write("notes/new.md", "x")).path).toBe("Notes/new.md");
        expect(selfEvents()).toEqual([
          "created Notes/a.md",
          "modified Notes/a.md",
          "created Notes/new.md",
        ]);
      } else {
        expect(second).toMatchObject({ path: "Notes/A.md", created: true });
        expect((await s.list()).map((f) => f.path)).toEqual(["Notes/A.md", "Notes/a.md"]);
      }
    });

    it("treats NFC and NFD names as one file where the disk does", async () => {
      const normalizationFolds = await folds(`${NFC}.md`, `${NFD}.md`);
      await s.write(`${NFC}/${NFC}.md`, "nfc");
      const second = await s.write(`${NFD}/${NFD}.md`, "nfd");
      if (normalizationFolds) {
        expect(second).toMatchObject({ path: `${NFC}/${NFC}.md`, created: false });
        expect((await s.list()).map((f) => f.path)).toEqual([`${NFC}/${NFC}.md`]);
        expect((await s.read(`${NFD}/${NFD}.md`))?.content).toBe("nfd");
      } else {
        expect((await s.list()).map((f) => f.path).sort()).toEqual(
          [`${NFC}/${NFC}.md`, `${NFD}/${NFD}.md`].sort(),
        );
      }
    });

    it("never lets conditional writes through two spellings of one file both win", async () => {
      if (!(await folds("Probe.md", "probe.md"))) return;
      const { version } = await s.write("race.md", "base");
      const results = await Promise.allSettled([
        s.write("race.md", "lower", { ifMatch: version }),
        s.write("RACE.md", "upper", { ifMatch: version }),
        s.write("Race.md", "title", { ifMatch: version }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
      }
    });

    it("renames by case only, reporting the new spelling", async () => {
      if (!(await folds("Probe.md", "probe.md"))) return;
      s.watch((e) => events.push(e));
      await s.write("Note.md", "x");
      expect((await s.rename("Note.md", "NOTE.md")).path).toBe("NOTE.md");
      expect(await readdir(vault)).toEqual(["NOTE.md"]);
      expect(selfEvents()).toEqual(["created Note.md", "deleted Note.md", "created NOTE.md"]);
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of many conditional writes from the same version win", async () => {
      const { version } = await s.write("shared.md", "v0");
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          s.write("shared.md", `writer ${i}`, { ifMatch: version }),
        ),
      );
      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners).toHaveLength(1);
      const winner = (winners[0] as PromiseFulfilledResult<{ version: string }>).value.version;
      for (const r of results) {
        if (r.status === "rejected")
          expect(r.reason).toMatchObject({ name: "ConflictError", currentVersion: winner });
      }
      expect((await s.read("shared.md"))?.version).toBe(winner);
    });

    it("serializes a conditional delete racing a conditional write", async () => {
      const { version } = await s.write("x.md", "v0");
      const [write, del] = await Promise.allSettled([
        s.write("x.md", "v1", { ifMatch: version }),
        s.delete("x.md", { ifMatch: version }),
      ]);
      expect([write.status, del.status].filter((st) => st === "fulfilled")).toHaveLength(1);
      const final = await s.read("x.md");
      expect(final === null ? "deleted" : final.content).toBe(
        write.status === "fulfilled" ? "v1" : "deleted",
      );
    });

    it("writes many different files concurrently without losing any", async () => {
      await Promise.all(
        Array.from({ length: 40 }, (_, i) => s.write(`n/${i % 5}/f${i}.md`, `#${i}`)),
      );
      const files = await s.list();
      expect(files).toHaveLength(40);
      expect(
        (await readdir(vault, { recursive: true })).filter((n) => String(n).includes(".ddl-tmp-")),
      ).toEqual([]);
    });
  });

  describe("names", () => {
    it.each([
      "with space.md",
      "hash #1.md",
      "50% off.md",
      "a&b=c?.md",
      "emoji 🎉.md",
      "日記/2026年9月.md",
      "עברית.md",
      "(parens) [brackets] {braces}.md",
      "trailing dot..md",
      "-leading-dash.md",
    ])("round-trips %j", async (name) => {
      const w = await s.write(name, name);
      expect(w.path).toBe(name);
      expect((await s.list()).map((f) => f.path)).toEqual([name]);
      expect((await s.read(name))?.content).toBe(name);
    });

    it("rejects names longer than the disk allows as invalid paths, leaving no temp files", async () => {
      const longest = `${"x".repeat(252)}.md`;
      expect((await s.write(longest, "ok")).created).toBe(true);
      const tooLong = `${"x".repeat(253)}.md`;
      await expect(s.write(tooLong, "x")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.write(`New/${tooLong}`, "x")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.rename(longest, tooLong)).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.createFolder(`${"d".repeat(256)}/x`)).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.read(tooLong)).rejects.toBeInstanceOf(InvalidPathError);
      // Nothing can exist below a folder that doesn't exist.
      expect(await s.stat(`Missing/${tooLong}`)).toBeNull();
      const names = (await readdir(vault, { recursive: true })).map(String);
      expect(names.filter((n) => n.includes(".ddl-tmp-"))).toEqual([]);
      expect((await s.list()).map((f) => f.path)).toEqual([longest]);
    });
  });

  describe("text that UTF-8 can't hold", () => {
    it("stores lone surrogates as U+FFFD and versions what it stored", async () => {
      const w = await s.write("broken.md", "emoji half \uD83D here");
      const r = await s.read("broken.md");
      expect(r?.content).toBe("emoji half \uFFFD here");
      expect(r?.version).toBe(w.version);
      expect(w.version).toBe(contentVersion("emoji half \uFFFD here"));
      await expect(s.write("broken.md", "next", { ifMatch: w.version })).resolves.toMatchObject({
        created: false,
      });
    });

    it("versions binary attachments by stat, not content (unlike the memory provider)", async () => {
      const w = await s.write("image.png", "not really a png");
      expect(w.version).not.toBe(contentVersion("not really a png"));
      expect((await s.read("image.png"))?.content).toBe("not really a png");
    });
  });

  describe.skipIf(!unix)("symlinks", () => {
    it("does not list through a symlinked folder, but paths through it resolve", async () => {
      await s.write("Real/note.md", "real");
      await symlink(join(vault, "Real"), join(vault, "Linked"));
      expect((await s.list()).map((f) => f.path)).toEqual(["Real/note.md"]);
      expect((await s.read("Linked/note.md"))?.content).toBe("real");
    });

    it("treats dangling links and link loops as missing files", async () => {
      await symlink(join(vault, "nowhere.md"), join(vault, "dangling.md"));
      await symlink(join(vault, "loop-b.md"), join(vault, "loop-a.md"));
      await symlink(join(vault, "loop-a.md"), join(vault, "loop-b.md"));
      await s.write("ok.md", "ok");
      expect((await s.list()).map((f) => f.path)).toEqual(["ok.md"]);
      for (const path of ["dangling.md", "loop-a.md"]) {
        expect(await s.read(path)).toBeNull();
        expect(await s.stat(path)).toBeNull();
        await expect(s.delete(path)).rejects.toMatchObject({ name: "NotFoundError" });
      }
      // Writing replaces the broken link with a real file.
      await s.write("loop-a.md", "fixed");
      expect((await lstat(join(vault, "loop-a.md"))).isFile()).toBe(true);
      expect((await s.read("loop-a.md"))?.content).toBe("fixed");
    });
  });

  describe.skipIf(!unix || root)("permissions", () => {
    it("lists everything it can read and skips the rest", async () => {
      await s.write("readable.md", "ok");
      await s.write("Folder/inside.md", "ok");
      await writeFile(join(vault, "locked.md"), "secret");
      await chmod(join(vault, "locked.md"), 0o000);
      await mkdir(join(vault, "Sealed"));
      await writeFile(join(vault, "Sealed", "hidden.md"), "secret");
      await chmod(join(vault, "Sealed"), 0o000);
      try {
        expect((await s.list()).map((f) => f.path)).toEqual(["Folder/inside.md", "readable.md"]);
        await expect(s.read("locked.md")).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(join(vault, "locked.md"), 0o644);
        await chmod(join(vault, "Sealed"), 0o755);
      }
    });

    it("fails a write into a read-only folder without leaving a temp file", async () => {
      await mkdir(join(vault, "ReadOnly"));
      await chmod(join(vault, "ReadOnly"), 0o555);
      try {
        await expect(s.write("ReadOnly/new.md", "x")).rejects.toMatchObject({ code: "EACCES" });
        expect(await readdir(join(vault, "ReadOnly"))).toEqual([]);
      } finally {
        await chmod(join(vault, "ReadOnly"), 0o755);
      }
    });
  });

  describe("folders", () => {
    it("deleteFolder removes ignored files too, reporting only what was listed", async () => {
      s.watch((e) => events.push(e));
      await s.write("Proj/a.md", "a");
      await mkdir(join(vault, "Proj", "node_modules"), { recursive: true });
      await writeFile(join(vault, "Proj", "node_modules", "x.md"), "x");
      await writeFile(join(vault, "Proj", "a.md~"), "backup");
      events.length = 0;
      await s.deleteFolder("Proj");
      expect(await readdir(vault)).toEqual([]);
      expect(selfEvents()).toEqual(["deleted Proj/a.md"]);
    });

    it("keeps emptied folders, like Obsidian", async () => {
      await s.write("Inbox/a.md", "a");
      await s.rename("Inbox/a.md", "Archive/a.md");
      expect(await s.listFolders()).toEqual(["Archive", "Inbox"]);
      await s.delete("Archive/a.md");
      expect(await s.listFolders()).toEqual(["Archive", "Inbox"]);
    });

    it("refuses file/folder collisions with StorageError and changes nothing", async () => {
      await s.write("file.md", "x");
      await s.createFolder("Dir");
      await expect(s.write("file.md/child.md", "x")).rejects.toBeInstanceOf(StorageError);
      await expect(s.createFolder("file.md/sub")).rejects.toBeInstanceOf(StorageError);
      await expect(s.write("Dir", "x")).rejects.toBeInstanceOf(StorageError);
      await expect(s.rename("file.md", "Dir")).rejects.toMatchObject({
        name: "ConflictError",
        currentVersion: null,
      });
      await expect(s.deleteFolder("file.md")).rejects.toBeInstanceOf(StorageError);
      expect(await readFile(join(vault, "file.md"), "utf8")).toBe("x");
      expect((await s.list()).map((f) => f.path)).toEqual(["file.md"]);
    });
  });
});
