import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import { createStorageProvider, createSyncTarget } from "./registry";

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

  it("creates sync targets", async () => {
    expect(await createSyncTarget({ kind: "none" })).toBeNull();

    const root = join(dir, "Mirror");
    const local = await createSyncTarget({ kind: "local", root });
    expect(local).toBeInstanceOf(LocalFsStorageProvider);
    expect((await stat(root)).isDirectory()).toBe(true);
    await local?.dispose();
  });
});
