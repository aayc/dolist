import {
  API_ROUTES,
  type ConflictResponse,
  type NoteResponse,
  type VaultTreeResponse,
  type WriteNoteResponse,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { createTestApp } from "../test-helpers";

describe("notes CRUD", () => {
  it("creates, reads, updates and deletes a note", async () => {
    const { request } = await createTestApp();
    const path = "Projects/Launch plan.md";

    const created = await request(API_ROUTES.note(path), {
      method: "PUT",
      json: { content: "# Plan", baseVersion: null },
    });
    expect(created.status).toBe(201);
    const v1 = (await created.json()) as WriteNoteResponse;
    expect(v1.path).toBe(path);

    const read = await request(API_ROUTES.note(path));
    expect(read.status).toBe(200);
    expect((await read.json()) as NoteResponse).toMatchObject({
      path,
      content: "# Plan",
      version: v1.version,
    });

    const updated = await request(API_ROUTES.note(path), {
      method: "PUT",
      json: { content: "# Plan v2", baseVersion: v1.version },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as WriteNoteResponse).version).not.toBe(v1.version);

    const deleted = await request(API_ROUTES.note(path), { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, trashedTo: `.trash/${path}` });
    expect((await request(API_ROUTES.note(path))).status).toBe(404);
    expect((await request(API_ROUTES.note(path), { method: "DELETE" })).status).toBe(404);
  });

  it("soft-deletes into .trash without overwriting earlier trashed copies", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { "a.md": "second", ".trash/a.md": "first" },
    });
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.note("a.md"), { method: "DELETE" });
    const { trashedTo } = (await res.json()) as { trashedTo: string };
    expect(trashedTo).toMatch(/^\.trash\/a \(\d{4}-\d{2}-\d{2} \d{6}\)\.md$/);
    expect((await storage.read(".trash/a.md"))?.content).toBe("first");
    expect((await storage.read(trashedTo))?.content).toBe("second");
  });

  it("round-trips names that need percent-encoding", async () => {
    const { request } = await createTestApp();
    for (const path of ["50% off?.md", "C# & notes/#1 a%20b.md", "Café/日記.md"]) {
      const put = await request(API_ROUTES.note(path), { method: "PUT", json: { content: path } });
      expect(put.ok, path).toBe(true);
      expect(((await put.json()) as WriteNoteResponse).path).toBe(path);
      const get = await request(API_ROUTES.note(path));
      expect(((await get.json()) as NoteResponse).content).toBe(path);
    }
  });

  it("writes unconditionally when baseVersion is omitted", async () => {
    const storage = new MemoryStorageProvider({ initialFiles: { "a.md": "old" } });
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.note("a.md"), { method: "PUT", json: { content: "new" } });
    expect(res.status).toBe(200);
    expect((await storage.read("a.md"))?.content).toBe("new");
  });
});

describe("optimistic concurrency", () => {
  it("returns 409 with the current note when baseVersion is stale", async () => {
    const storage = new MemoryStorageProvider({ initialFiles: { "a.md": "theirs" } });
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.note("a.md"), {
      method: "PUT",
      json: { content: "mine", baseVersion: "stale-version" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ConflictResponse;
    expect(body.error).toBe("conflict");
    expect(body.current).toMatchObject({ path: "a.md", content: "theirs" });
    expect((await storage.read("a.md"))?.content).toBe("theirs");
  });

  it("returns 409 for create-only writes when the note exists", async () => {
    const storage = new MemoryStorageProvider({ initialFiles: { "a.md": "exists" } });
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.note("a.md"), {
      method: "PUT",
      json: { content: "new", baseVersion: null },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ConflictResponse).current?.content).toBe("exists");
  });

  it("returns 409 with current null when the note was deleted", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.note("gone.md"), {
      method: "PUT",
      json: { content: "x", baseVersion: "v1" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ConflictResponse).current).toBeNull();
  });
});

describe("path validation", () => {
  const rejected: Array<[string, string]> = [
    ["traversal via encoded slashes", "/api/notes/..%2F..%2Fetc%2Fpasswd.md"],
    ["encoded traversal segment", "/api/notes/Projects/..%2F..%2F..%2Fsecret.md"],
    ["sidecar", "/api/notes/.daily-do-list/settings.json"],
    ["obsidian config", "/api/notes/.obsidian/app.json"],
    ["dot-file", "/api/notes/Notes/%2Esecret.md"],
    ["NUL byte", "/api/notes/a%00b.md"],
    ["control character", "/api/notes/a%0Ab.md"],
    ["binary type", "/api/notes/photo.png"],
    ["no extension", "/api/notes/README"],
    ["malformed escape", "/api/notes/%E0%A4%A.md"],
    ["empty path", "/api/notes/"],
  ];

  for (const [name, url] of rejected) {
    it(`rejects ${name}`, async () => {
      const { request } = await createTestApp();
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await request(url, {
          method,
          ...(method === "PUT" ? { json: { content: "x" } } : {}),
        });
        expect(res.status, `${method} ${url}`).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_path" });
      }
    });
  }

  it("never lets URL-level dot segments reach the notes route", async () => {
    const { request } = await createTestApp();
    const res = await request("/api/notes/%2e%2e/%2e%2e/etc/passwd");
    expect(res.status).toBe(404);
  });
});

describe("rename and folders", () => {
  it("renames a note and reports conflicts with the target", async () => {
    const storage = new MemoryStorageProvider({ initialFiles: { "a.md": "A", "b.md": "B" } });
    const { request } = await createTestApp({ storage });

    const conflict = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "a.md", to: "b.md" },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as ConflictResponse).current?.content).toBe("B");

    const ok = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "a.md", to: "Archive/a.md" },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as WriteNoteResponse).path).toBe("Archive/a.md");
    expect(await storage.read("a.md")).toBeNull();

    const missing = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "nope.md", to: "c.md" },
    });
    expect(missing.status).toBe(404);

    const hidden = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "b.md", to: ".daily-do-list/b.md" },
    });
    expect(hidden.status).toBe(400);
  });

  it("renames folders with everything inside, refusing conflicts", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        "Projects/Kyoto/plan.md": "plan",
        "Projects/Kyoto/days/day1.md": "day1",
        "Archive/Kyoto/plan.md": "old",
      },
    });
    const { request } = await createTestApp({ storage });
    const conflict = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "Projects/Kyoto", to: "Archive/Kyoto" },
    });
    expect(conflict.status).toBe(409);
    expect((await storage.read("Projects/Kyoto/plan.md"))?.content).toBe("plan");

    const into = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "Projects", to: "Projects/Nested" },
    });
    expect(into.status).toBe(409);

    const ok = await request(API_ROUTES.rename, {
      method: "POST",
      json: { from: "Projects/Kyoto", to: "Trips/Kyoto 2026" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "Trips/Kyoto 2026", moved: 2 });
    expect((await storage.list()).map((f) => f.path).sort()).toEqual([
      "Archive/Kyoto/plan.md",
      "Trips/Kyoto 2026/days/day1.md",
      "Trips/Kyoto 2026/plan.md",
    ]);
  });

  it("soft-deletes folders into .trash", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { "Projects/Kyoto/plan.md": "plan", "Projects/keep.md": "keep" },
    });
    const { request } = await createTestApp({ storage });
    const res = await request(
      `${API_ROUTES.folders}?path=${encodeURIComponent("Projects/Kyoto")}`,
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashedTo: ".trash/Projects/Kyoto" });
    expect((await storage.list()).map((f) => f.path)).toEqual(["Projects/keep.md"]);
    expect((await storage.read(".trash/Projects/Kyoto/plan.md"))?.content).toBe("plan");

    const missing = await request(`${API_ROUTES.folders}?path=Nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    const hidden = await request(`${API_ROUTES.folders}?path=.daily-do-list`, { method: "DELETE" });
    expect(hidden.status).toBe(400);
  });

  it("creates folders and lists only visible entries in the tree", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        "Daily/2026-09-23.md": "- [ ] ",
        ".daily-do-list/settings.json": "{}",
        ".obsidian/app.json": "{}",
      },
    });
    const { request } = await createTestApp({ storage });
    expect(
      (await request(API_ROUTES.folders, { method: "POST", json: { path: "Projects/" } })).status,
    ).toBe(201);
    expect(
      (await request(API_ROUTES.folders, { method: "POST", json: { path: ".hidden" } })).status,
    ).toBe(400);

    const tree = (await (await request(API_ROUTES.tree)).json()) as VaultTreeResponse;
    const paths = tree.entries.map((entry) => `${entry.kind}:${entry.path}`).sort();
    expect(paths).toEqual(["file:Daily/2026-09-23.md", "folder:Daily", "folder:Projects"]);
    expect(tree.entries.find((e) => e.kind === "file")).toMatchObject({
      size: 6,
      version: expect.any(String),
    });
  });
});

describe("search", () => {
  it("finds file names and lines, 0-based, skipping hidden files", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        "Daily/2026-09-23.md": "- [ ] Call the dentist\n- [ ] Book flights to Lisbon",
        "Dentist.md": "Opening hours",
        ".daily-do-list/threads/t.json": "dentist",
      },
    });
    const { request } = await createTestApp({ storage });
    const res = await request(API_ROUTES.search("dentist"));
    const { hits } = (await res.json()) as { hits: Array<{ path: string; line: number }> };
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Dentist.md", line: 0 }),
        expect.objectContaining({ path: "Daily/2026-09-23.md", line: 0 }),
      ]),
    );
    expect(hits.some((hit) => hit.path.startsWith("."))).toBe(false);

    const multi = await request(API_ROUTES.search("book lisbon"));
    expect(((await multi.json()) as { hits: unknown[] }).hits).toEqual([
      {
        path: "Daily/2026-09-23.md",
        kind: "content",
        line: 1,
        preview: "- [ ] Book flights to Lisbon",
      },
    ]);
    expect(await (await request(API_ROUTES.search("   "))).json()).toEqual({ hits: [] });
  });
});
