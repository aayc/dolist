import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { LocalFsStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp, tempDir } from "../test-helpers";
import { RecordingLogger } from "./harness";

let dir: { path: string; cleanup: () => void };
let app: TestApp<LocalFsStorageProvider>;
let logger: RecordingLogger;

beforeEach(async () => {
  dir = tempDir("ddl-storage-errors-");
  mkdirSync(join(dir.path, "Folder.md"));
  logger = new RecordingLogger();
  app = await createTestApp({ storage: new LocalFsStorageProvider({ root: dir.path }), logger });
  await app.storage.write("x.md", "a file");
  await app.storage.write("b.md", "another file");
});

afterEach(async () => {
  await app.storage.dispose();
  dir.cleanup();
});

const put = (path: string) =>
  app.request(API_ROUTES.note(path), { method: "PUT", json: { content: "x" } });

describe("storage errors that are the client's doing", () => {
  it("still answer without leaking internals and without touching the file in the way", async () => {
    for (const res of [
      await put("x.md/a.md"),
      await put("Folder.md"),
      await app.request(API_ROUTES.rename, {
        method: "POST",
        json: { from: "b.md", to: "x.md/b.md" },
      }),
      await app.request(API_ROUTES.folders, { method: "POST", json: { path: "x.md/sub" } }),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.text();
      expect(body).not.toContain(dir.path);
      expect(body).not.toMatch(/at .*\.ts:\d+/);
    }
    expect((await app.storage.read("x.md"))?.content).toBe("a file");
    expect((await app.storage.read("b.md"))?.content).toBe("another file");
  });

  // BUG (errors.ts, not owned here): a plain StorageError from the provider ("a file is in the way",
  // "Not a file") is not in NAMED_ERRORS, so these client mistakes answer 500 internal_error and are
  // logged as daemon failures with a stack trace. Expected: 409 conflict.
  it.fails("PUT under an existing file answers 409 conflict", async () => {
    expect((await put("x.md/a.md")).status).toBe(409);
  });

  it.fails("PUT onto an existing folder answers 409 conflict", async () => {
    expect((await put("Folder.md")).status).toBe(409);
  });

  it.fails("renaming a note under an existing file answers 409 conflict", async () => {
    const res = await app.request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "b.md", to: "x.md/b.md" },
    });
    expect(res.status).toBe(409);
  });

  it.fails("creating a folder under or onto a file answers 409 conflict", async () => {
    for (const path of ["x.md/sub", "x.md"]) {
      const res = await app.request(API_ROUTES.folders, { method: "POST", json: { path } });
      expect(res.status, path).toBe(409);
    }
  });

  it.fails("a daily-notes folder that is a file answers a client error", async () => {
    await app.request(API_ROUTES.settings, {
      method: "PUT",
      json: { dailyNotes: { folder: "x.md" } },
    });
    const res = await app.request(API_ROUTES.daily("2031-01-01"));
    expect([400, 409]).toContain(res.status);
  });

  it.fails("client mistakes are not logged as daemon errors", async () => {
    await put("x.md/a.md");
    expect(logger.lines.filter((line) => line.startsWith("error"))).toEqual([]);
  });

  // macOS limits a whole path to 1024 bytes, which a valid 1,000-character vault path plus the vault
  // root exceeds; Linux allows 4096 bytes, so the request succeeds there.
  it.runIf(process.platform === "darwin")(
    "a path longer than the OS allows answers 400 invalid_path",
    async () => {
      const deep = `${Array.from({ length: 100 }, () => "abcdefghi").join("/")}/n.md`;
      const res = await put(deep);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_path" });
    },
  );
});
