import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import { createStorageProvider, createSyncTarget } from "./registry";
import { S3StorageProvider } from "./s3";
import { NotImplementedError } from "./types";

describe("storage registry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-registry-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates memory providers with initial files", async () => {
    const s = await createStorageProvider({
      kind: "memory",
      id: "fixture",
      initialFiles: { "a.md": "hello" },
    });
    expect(s).toBeInstanceOf(MemoryStorageProvider);
    expect(s.id).toBe("fixture");
    expect((await s.read("a.md"))?.content).toBe("hello");
  });

  it("creates local providers and their vault folder", async () => {
    const root = join(dir, "Vault");
    const s = await createStorageProvider({ kind: "local", root, ignore: ["Archive"] });
    expect(s).toBeInstanceOf(LocalFsStorageProvider);
    expect(s.kind).toBe("local");
    expect((await stat(root)).isDirectory()).toBe(true);
    await s.write("Archive/old.md", "x");
    expect(await s.list()).toEqual([]);
    await s.dispose();
  });

  it("creates the S3 provider stub", async () => {
    const s = await createStorageProvider({ kind: "s3", bucket: "notes", prefix: "/vaults//me" });
    expect(s).toBeInstanceOf(S3StorageProvider);
    expect(s.displayName).toBe("s3://notes/vaults/me/");
    await expect(s.list()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(s.write("a.md", "x")).rejects.toBeInstanceOf(NotImplementedError);
    expect(() => s.watch(() => {})).toThrow(NotImplementedError);
    await expect(s.dispose()).resolves.toBeUndefined();
  });

  it("creates sync targets", async () => {
    expect(await createSyncTarget({ kind: "none" })).toBeNull();

    const root = join(dir, "Mirror");
    const local = await createSyncTarget({ kind: "local", root });
    expect(local).toBeInstanceOf(LocalFsStorageProvider);
    expect((await stat(root)).isDirectory()).toBe(true);
    await local?.dispose();

    const s3 = await createSyncTarget({ kind: "s3", bucket: "notes", region: "eu-west-1" });
    expect(s3).toBeInstanceOf(S3StorageProvider);
    expect(s3?.id).toMatch(/^s3-/);
  });
});
