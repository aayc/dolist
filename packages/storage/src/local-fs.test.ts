import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeStorageContract } from "./contract-suite";
import { LocalFsStorageProvider } from "./local-fs";
import { contentVersion } from "./memory";
import { StorageError } from "./types";

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ddl-storage-"));
}

async function allNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => entry.toString());
}

describeStorageContract("LocalFsStorageProvider", async () => {
  const dir = await makeTempDir();
  return {
    provider: new LocalFsStorageProvider({ root: join(dir, "vault") }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

describe("LocalFsStorageProvider", () => {
  let dir: string;
  let root: string;
  let s: LocalFsStorageProvider;

  beforeEach(async () => {
    dir = await makeTempDir();
    root = join(dir, "vault");
    s = new LocalFsStorageProvider({ root });
  });

  afterEach(async () => {
    await s.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a missing vault folder, with a stable id and the folder name as display name", async () => {
    const nested = new LocalFsStorageProvider({ root: join(dir, "a", "b", "My Vault") });
    await nested.init();
    expect((await stat(join(dir, "a", "b", "My Vault"))).isDirectory()).toBe(true);
    expect(nested.displayName).toBe("My Vault");
    expect(nested.id).toBe(
      new LocalFsStorageProvider({ root: join(dir, "a", "b", "My Vault") }).id,
    );
    expect(nested.id).not.toBe(s.id);
    await nested.dispose();
  });

  it("keeps versions between runs in its version cache, hashing only files that changed", async () => {
    const versionCache = join(dir, "cache", "versions.json");
    const first = new LocalFsStorageProvider({ root, versionCache });
    await first.write("a.md", "one");
    await first.write("b.md", "two");
    await first.dispose();
    const saved = JSON.parse(await readFile(versionCache, "utf8"));
    for (const entry of saved.entries) if (entry[0] === "a.md") entry[3] = "from-the-cache";
    await writeFile(versionCache, JSON.stringify(saved));
    await writeFile(join(root, "b.md"), "changed");
    const second = new LocalFsStorageProvider({ root, versionCache });
    expect((await second.list()).map((f) => [f.path, f.version])).toEqual([
      ["a.md", "from-the-cache"],
      ["b.md", contentVersion("changed")],
    ]);
    await second.dispose();
  });

  it("reads files written by other programs byte for byte", async () => {
    await mkdir(join(root, "Daily"), { recursive: true });
    const content = "\uFEFF# Title\r\n- [ ] task\r\n";
    await writeFile(join(root, "Daily", "2026-09-23.md"), content);
    const file = await s.read("Daily/2026-09-23.md");
    expect(file?.content).toBe(content);
    expect(file?.version).toBe(contentVersion(content));
    expect(file?.size).toBe(Buffer.byteLength(content));
  });

  it("writes atomically and leaves no temp files behind", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.write(`Notes/n${i}.md`, `note ${i}`)));
    for (let i = 0; i < 10; i++) await s.write("Notes/n0.md", `revision ${i}`);
    const names = await allNames(root);
    expect(names.filter((name) => name.includes(".ddl-tmp-"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".md"))).toHaveLength(20);
    expect(await readFile(join(root, "Notes", "n0.md"), "utf8")).toBe("revision 9");
  });

  it("cleans up after a failed write", async () => {
    await s.write("blocker", "I am a file");
    await expect(s.write("blocker/child.md", "x")).rejects.toBeInstanceOf(StorageError);
    await s.createFolder("Folder");
    await expect(s.write("Folder", "x")).rejects.toBeInstanceOf(StorageError);
    expect((await allNames(root)).filter((name) => name.includes(".ddl-tmp-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves file permissions across writes", async () => {
    await s.write("private.md", "one");
    await chmod(join(root, "private.md"), 0o600);
    await s.write("private.md", "two");
    expect((await stat(join(root, "private.md"))).mode & 0o777).toBe(0o600);
  });

  it("rejects empty paths", async () => {
    await expect(s.write("", "x")).rejects.toBeInstanceOf(InvalidPathError);
    await expect(s.read("./")).rejects.toBeInstanceOf(InvalidPathError);
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinks that lead outside the vault",
    async () => {
      const outside = join(dir, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secret.md"), "outside content");
      await s.write("inside.md", "inside");
      await symlink(outside, join(root, "escape-dir"));
      await symlink(join(outside, "secret.md"), join(root, "escape-file.md"));

      await expect(s.read("escape-dir/secret.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.stat("escape-file.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.read("escape-file.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.write("escape-dir/new.md", "x")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.write("escape-dir/deeper/new.md", "x")).rejects.toBeInstanceOf(
        InvalidPathError,
      );
      await expect(s.delete("escape-file.md")).rejects.toBeInstanceOf(InvalidPathError);
      await expect(s.list({ prefix: "escape-dir" })).rejects.toBeInstanceOf(InvalidPathError);
      expect(await readdir(outside)).toEqual(["secret.md"]);
      expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("outside content");

      expect((await s.list({ includeHidden: true })).map((f) => f.path)).toEqual(["inside.md"]);
      expect(await s.listFolders()).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("follows symlinked files inside the vault", async () => {
    await s.write("real.md", "original");
    await symlink(join(root, "real.md"), join(root, "alias.md"));
    expect((await s.list()).map((f) => f.path)).toEqual(["alias.md", "real.md"]);
    expect((await s.read("alias.md"))?.content).toBe("original");

    await s.write("alias.md", "through the link");
    expect((await lstat(join(root, "alias.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "real.md"), "utf8")).toBe("through the link");

    await s.delete("alias.md");
    expect(await s.read("real.md")).not.toBeNull();
  });

  it("never lists ignored folders, junk files or temp files", async () => {
    const custom = new LocalFsStorageProvider({ root, ignore: ["Private/Drafts"] });
    const files = [
      ".git/HEAD",
      "node_modules/pkg/readme.md",
      ".trash/old.md",
      ".DS_Store",
      "Notes/.DS_Store",
      "Notes/a.md",
      "Notes/.ddl-tmp-abc123",
      "Notes/a.md~",
      "Notes/.a.md.swp",
      "Notes/a.md___jb_tmp___",
      "Private/Drafts/secret.md",
      "Private/ok.md",
      ".obsidian/app.json",
    ];
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "x");
    }
    expect((await custom.list({ includeHidden: true })).map((f) => f.path)).toEqual([
      ".obsidian/app.json",
      "Notes/a.md",
      "Private/ok.md",
    ]);
    expect(await custom.listFolders({ includeHidden: true })).toEqual([
      ".obsidian",
      "Notes",
      "Private",
    ]);
    expect(await custom.list({ prefix: ".git", includeHidden: true })).toEqual([]);
    expect(await custom.list({ prefix: "Private/Drafts" })).toEqual([]);
    await custom.dispose();
  });

  // Whole seconds survive a utimes round trip exactly (sub-millisecond mtimes would not).
  const PINNED_MTIME = 1_750_000_000;

  it("serves versions from the (path, mtime, size) cache without re-reading", async () => {
    const written = await s.write("cached.md", "aaaa");
    const file = join(root, "cached.md");
    await utimes(file, PINNED_MTIME, PINNED_MTIME);
    expect((await s.stat("cached.md"))?.version).toBe(written.version);

    // Same size and mtime: only a re-read could notice the new content.
    await writeFile(file, "bbbb");
    await utimes(file, PINNED_MTIME, PINNED_MTIME);
    expect((await s.stat("cached.md"))?.version).toBe(written.version);
    expect((await s.list())[0]?.version).toBe(written.version);

    await utimes(file, PINNED_MTIME + 5, PINNED_MTIME + 5);
    expect((await s.stat("cached.md"))?.version).toBe(contentVersion("bbbb"));
    // Reads always hit the disk.
    expect((await s.read("cached.md"))?.content).toBe("bbbb");
  });

  it("checks preconditions against the disk, not the cache", async () => {
    const written = await s.write("guarded.md", "aaaa");
    const file = join(root, "guarded.md");
    await utimes(file, PINNED_MTIME, PINNED_MTIME);
    expect((await s.stat("guarded.md"))?.version).toBe(written.version);
    await writeFile(file, "bbbb");
    await utimes(file, PINNED_MTIME, PINNED_MTIME);
    await expect(s.write("guarded.md", "cccc", { ifMatch: written.version })).rejects.toMatchObject(
      {
        name: "ConflictError",
        currentVersion: contentVersion("bbbb"),
      },
    );
  });

  it("versions binary attachments by stat instead of content", async () => {
    await s.init();
    const image = join(root, "image.png");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    await utimes(image, PINNED_MTIME, PINNED_MTIME);
    const first = await s.stat("image.png");
    expect(first?.version).toMatch(/^[0-9a-f]+$/);
    // A touch changes the version even though the bytes are the same.
    await utimes(image, PINNED_MTIME + 10, PINNED_MTIME + 10);
    expect((await s.stat("image.png"))?.version).not.toBe(first?.version);
  });

  it("renames across folders and treats case-only renames as renames", async () => {
    await s.write("Inbox/Note.md", "x");
    await s.rename("Inbox/Note.md", "Archive/Note.md");
    expect(await readdir(join(root, "Archive"))).toEqual(["Note.md"]);

    const caseInsensitive = (await s.stat("archive/note.md")) !== null;
    if (caseInsensitive) {
      await s.rename("Archive/Note.md", "Archive/note.md");
      expect(await readdir(join(root, "Archive"))).toEqual(["note.md"]);
    } else {
      await s.write("Archive/note.md", "y");
      await expect(s.rename("Archive/Note.md", "Archive/note.md")).rejects.toMatchObject({
        name: "ConflictError",
      });
    }
  });

  it("refuses to create a folder where a file exists", async () => {
    await s.write("taken.md", "x");
    await expect(s.createFolder("taken.md")).rejects.toBeInstanceOf(StorageError);
  });
});
