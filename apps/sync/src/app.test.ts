import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { SYNC_API_VERSION } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePath, startTestServer, type TestServer, upgradeStatus } from "./test-helpers";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let t: TestServer;

beforeEach(async () => {
  t = await startTestServer();
});

afterEach(async () => {
  await t.close();
});

describe("health", () => {
  it("answers without authentication and says nothing about vaults", async () => {
    const response = await fetch(`${t.url}/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, apiVersion: SYNC_API_VERSION });
  });
});

describe("authentication", () => {
  it("answers every token problem with the same 401, whether or not the vault exists", async () => {
    const cases = [
      await t.api("GET", "/files", { token: null }),
      await t.api("GET", "/files", { token: "wrong" }),
      await t.api("GET", "/files", {
        headers: { authorization: `Basic ${t.a.token}` },
        token: null,
      }),
      await t.api("GET", "/files", { token: t.b.token }),
      await t.api("GET", "/files", {}, { id: "v_doesnotexist0000000", token: t.a.token }),
      await t.api("GET", "/files", {}, { id: "not a vault!", token: t.a.token }),
      await t.api("PUT", filePath("a.md"), { body: { content: "x" }, token: t.b.token }),
      await t.api("GET", "/nope", { token: "wrong" }),
    ];
    for (const response of cases) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(cases[0]!.body);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="ddl-sync"');
    }
    expect(cases[0]!.body).toEqual({ error: "unauthorized", message: "Missing or invalid token" });
  });

  it("lets a token into its own vault only", async () => {
    await t.api("PUT", filePath("a.md"), { body: { content: "in a" } });
    expect((await t.api("GET", filePath("a.md"))).body.content).toBe("in a");
    expect((await t.api("GET", filePath("a.md"), {}, t.b)).status).toBe(404);
  });

  it("refuses stream upgrades the same way", async () => {
    const stream = (vault: string) => `/v1/vaults/${vault}/stream`;
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    expect(await upgradeStatus(t.url, stream(t.a.id), bearer(t.a.token))).toBe(101);
    expect(await upgradeStatus(t.url, stream(t.a.id))).toBe(401);
    expect(await upgradeStatus(t.url, stream(t.a.id), bearer("wrong"))).toBe(401);
    expect(await upgradeStatus(t.url, stream(t.a.id), bearer(t.b.token))).toBe(401);
    expect(await upgradeStatus(t.url, stream("v_doesnotexist0000000"), bearer(t.a.token))).toBe(
      401,
    );
    expect(await upgradeStatus(t.url, "/v1/health", bearer(t.a.token))).toBe(404);
  });

  it("stores only a hash of each token", () => {
    const { store } = t.server;
    expect(store.authenticate(t.a.id, t.a.token)).not.toBeNull();
    expect(store.authenticate(t.a.id, t.b.token)).toBeNull();
    expect(store.authenticate("v_doesnotexist0000000", t.a.token)).toBeNull();
  });
});

describe("files", () => {
  it("writes, reads, stats and lists files with revs, sizes and hashes", async () => {
    const content = "- [ ] water the plants 🌱\n";
    const put = await t.api("PUT", filePath("Daily/2026-09-24.md"), { body: { content } });
    expect(put.status).toBe(201);
    expect(put.body).toEqual({
      path: "Daily/2026-09-24.md",
      rev: expect.any(String),
      size: Buffer.byteLength(content),
      hash: sha256(content),
      mtime: expect.any(Number),
      created: true,
      seq: 1,
    });
    const { created: _created, seq: _seq, ...entry } = put.body;
    expect((await t.api("GET", filePath("Daily/2026-09-24.md"))).body).toEqual({
      ...entry,
      content,
    });
    expect(
      (await t.api("GET", filePath("Daily/2026-09-24.md"), { query: { meta: "1" } })).body,
    ).toEqual(entry);
    expect((await t.api("GET", "/files")).body).toEqual({ files: [entry], seq: 1 });
    expect((await t.api("GET", "/files", { query: { prefix: "Daily" } })).body.files).toEqual([
      entry,
    ]);
    expect((await t.api("GET", "/files", { query: { prefix: "Dailyish" } })).body.files).toEqual(
      [],
    );
    expect((await t.api("GET", filePath("missing.md"))).status).toBe(404);
    expect((await t.api("GET", filePath("missing.md"), { query: { meta: "1" } })).status).toBe(404);
  });

  it("enforces conditional writes and says what the current rev is", async () => {
    const first = (
      await t.api("PUT", filePath("a.md"), { body: { content: "one", ifMatch: null } })
    ).body;
    const exists = await t.api("PUT", filePath("a.md"), {
      body: { content: "two", ifMatch: null },
    });
    expect(exists.status).toBe(409);
    expect(exists.body).toEqual({
      error: "conflict",
      message: 'Version conflict for "a.md"',
      currentRev: first.rev,
    });
    const stale = await t.api("PUT", filePath("a.md"), {
      body: { content: "two", ifMatch: "r999" },
    });
    expect(stale).toMatchObject({ status: 409, body: { currentRev: first.rev } });
    const absent = await t.api("PUT", filePath("b.md"), { body: { content: "x", ifMatch: "r1" } });
    expect(absent).toMatchObject({ status: 409, body: { error: "conflict", currentRev: null } });

    const second = await t.api("PUT", filePath("a.md"), {
      body: { content: "two", ifMatch: first.rev },
    });
    expect(second).toMatchObject({ status: 200, body: { created: false } });
    expect(second.body.rev).not.toBe(first.rev);
    const forced = await t.api("PUT", filePath("a.md"), { body: { content: "three" } });
    expect(forced.status).toBe(200);
    expect((await t.api("GET", filePath("a.md"))).body.content).toBe("three");
  });

  it("keeps the rev and appends nothing when the content is identical", async () => {
    const first = (await t.api("PUT", filePath("a.md"), { body: { content: "same" } })).body;
    const again = await t.api("PUT", filePath("a.md"), {
      body: { content: "same", ifMatch: first.rev },
    });
    expect(again).toMatchObject({
      status: 200,
      body: { rev: first.rev, created: false, seq: null },
    });
    expect((await t.api("GET", "/changes")).body.changes).toHaveLength(1);
  });

  it("stores lone surrogates the way every provider does", async () => {
    const put = await t.api("PUT", filePath("odd.md"), { rawBody: '{"content":"a\\ud800b"}' });
    expect(put.body).toMatchObject({ size: 5, hash: sha256("a\uFFFDb") });
    expect((await t.api("GET", filePath("odd.md"))).body.content).toBe("a\uFFFDb");
  });

  it("behaves like a disk: no file over a folder, no folder below a file", async () => {
    await t.api("PUT", filePath("Notes/a.md"), { body: { content: "x" } });
    const overFolder = await t.api("PUT", filePath("Notes"), { body: { content: "x" } });
    expect(overFolder).toMatchObject({ status: 409, body: { error: "not_a_file" } });
    const belowFile = await t.api("PUT", filePath("Notes/a.md/b.md"), { body: { content: "x" } });
    expect(belowFile).toMatchObject({ status: 409, body: { error: "path_blocked" } });
  });

  it("requires the device header on every change", async () => {
    for (const device of [null, "", "has spaces", "x".repeat(65)]) {
      const response = await t.api("PUT", filePath("a.md"), { body: { content: "x" }, device });
      expect(response).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
    expect((await t.api("DELETE", filePath("a.md"), { device: null })).status).toBe(400);
    expect(
      (await t.api("POST", "/rename", { body: { from: "a", to: "b" }, device: null })).status,
    ).toBe(400);
  });
});

describe("deletes", () => {
  it("deletes with or without a precondition, keeping the folders", async () => {
    const put = (await t.api("PUT", filePath("Notes/a.md"), { body: { content: "x" } })).body;
    const stale = await t.api("DELETE", filePath("Notes/a.md"), { query: { ifMatch: "r999" } });
    expect(stale).toMatchObject({ status: 409, body: { error: "conflict", currentRev: put.rev } });
    const ok = await t.api("DELETE", filePath("Notes/a.md"), { query: { ifMatch: put.rev } });
    expect(ok.status).toBe(204);
    expect((await t.api("GET", filePath("Notes/a.md"))).status).toBe(404);
    expect((await t.api("DELETE", filePath("Notes/a.md"))).status).toBe(404);
    const gone = await t.api("DELETE", filePath("Notes/a.md"), { query: { ifMatch: put.rev } });
    expect(gone).toMatchObject({ status: 409, body: { currentRev: null } });
    expect((await t.api("GET", "/folders")).body.folders).toEqual(["Notes"]);
  });
});

describe("rename", () => {
  it("moves a file with its rev and mtime and logs both paths", async () => {
    const put = (await t.api("PUT", filePath("Inbox/a.md"), { body: { content: "content" } })).body;
    const moved = await t.api("POST", "/rename", {
      body: { from: "Inbox/a.md", to: "Archive/a.md" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      path: "Archive/a.md",
      rev: put.rev,
      mtime: put.mtime,
      size: put.size,
      created: true,
      seq: 3,
    });
    expect((await t.api("GET", filePath("Inbox/a.md"))).status).toBe(404);
    expect((await t.api("GET", filePath("Archive/a.md"))).body.content).toBe("content");
    const changes = (await t.api("GET", "/changes", { query: { since: "1" } })).body.changes;
    expect(changes.map((c: { path: string; deleted: boolean }) => [c.path, c.deleted])).toEqual([
      ["Inbox/a.md", true],
      ["Archive/a.md", false],
    ]);
  });

  it("never replaces a file or a folder, nor digs below a file", async () => {
    const other = (await t.api("PUT", filePath("other.md"), { body: { content: "o" } })).body;
    await t.api("PUT", filePath("a.md"), { body: { content: "a" } });
    await t.api("POST", "/folders", { body: { path: "Folder" } });
    const rename = (from: string, to: string) => t.api("POST", "/rename", { body: { from, to } });
    expect(await rename("a.md", "other.md")).toMatchObject({
      status: 409,
      body: { error: "conflict", currentRev: other.rev },
    });
    expect(await rename("a.md", "a.md")).toMatchObject({
      status: 409,
      body: { error: "conflict" },
    });
    expect(await rename("a.md", "Folder")).toMatchObject({
      status: 409,
      body: { currentRev: null },
    });
    expect(await rename("a.md", "other.md/x.md")).toMatchObject({
      status: 409,
      body: { error: "path_blocked" },
    });
    expect(await rename("missing.md", "x.md")).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
  });
});

describe("folders", () => {
  it("creates, lists and deletes folders; files make their folders too", async () => {
    expect((await t.api("POST", "/folders", { body: { path: "Projects/Empty" } })).status).toBe(
      201,
    );
    expect((await t.api("POST", "/folders", { body: { path: "Projects/Empty" } })).status).toBe(
      200,
    );
    await t.api("PUT", filePath("Projects/Kyoto/plan.md"), { body: { content: "a" } });
    await t.api("PUT", filePath("Projects/Kyoto/Days/day1.md"), { body: { content: "b" } });
    await t.api("PUT", filePath("Projects/keep.md"), { body: { content: "c" } });
    await t.api("PUT", filePath(".obsidian/app.json"), { body: { content: "{}" } });
    expect((await t.api("GET", "/folders")).body.folders).toEqual([
      ".obsidian",
      "Projects",
      "Projects/Empty",
      "Projects/Kyoto",
      "Projects/Kyoto/Days",
    ]);
    expect(
      (await t.api("GET", "/folders", { query: { prefix: "Projects/Kyoto" } })).body.folders,
    ).toEqual(["Projects/Kyoto", "Projects/Kyoto/Days"]);

    const deleted = await t.api("DELETE", "/folders", { query: { path: "Projects/Kyoto" } });
    expect(deleted.body).toEqual({
      deleted: ["Projects/Kyoto/Days/day1.md", "Projects/Kyoto/plan.md"],
    });
    expect(
      (await t.api("GET", "/files", { query: { prefix: "Projects" } })).body.files,
    ).toHaveLength(1);
    expect(
      (await t.api("GET", "/folders", { query: { prefix: "Projects" } })).body.folders,
    ).toEqual(["Projects", "Projects/Empty"]);
    const log = (await t.api("GET", "/changes", { query: { since: "4" } })).body.changes;
    expect(log.map((c: { path: string }) => c.path)).toEqual([
      "Projects/Kyoto/Days/day1.md",
      "Projects/Kyoto/plan.md",
    ]);
  });

  it("refuses folders where files are, and deleting what isn't a folder", async () => {
    await t.api("PUT", filePath("a.md"), { body: { content: "x" } });
    expect(await t.api("POST", "/folders", { body: { path: "a.md" } })).toMatchObject({
      status: 409,
      body: { error: "not_a_folder" },
    });
    expect(await t.api("POST", "/folders", { body: { path: "a.md/sub" } })).toMatchObject({
      status: 409,
      body: { error: "path_blocked" },
    });
    expect(await t.api("DELETE", "/folders", { query: { path: "a.md" } })).toMatchObject({
      status: 409,
      body: { error: "not_a_folder" },
    });
    expect(await t.api("DELETE", "/folders", { query: { path: "Nope" } })).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
  });
});

describe("change log", () => {
  it("pages through changes after a cursor, oldest first", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await t.api("PUT", filePath(`${name}.md`), {
        body: { content: name },
        device: `dev_${name}`,
      });
    }
    await t.api("DELETE", filePath("a.md"), { device: "dev_z" });
    const page = (await t.api("GET", "/changes", { query: { since: "2", limit: "2" } })).body;
    expect(page).toEqual({
      changes: [
        {
          seq: 3,
          path: "c.md",
          rev: "r3",
          deleted: false,
          created: true,
          device: "dev_c",
          at: expect.any(Number),
        },
        {
          seq: 4,
          path: "d.md",
          rev: "r4",
          deleted: false,
          created: true,
          device: "dev_d",
          at: expect.any(Number),
        },
      ],
      seq: 6,
      more: true,
    });
    const rest = (await t.api("GET", "/changes", { query: { since: "4" } })).body;
    expect(rest.more).toBe(false);
    expect(rest.changes.map((c: { seq: number; deleted: boolean }) => [c.seq, c.deleted])).toEqual([
      [5, false],
      [6, true],
    ]);
    expect((await t.api("GET", "/changes", { query: { since: "6" } })).body).toEqual({
      changes: [],
      seq: 6,
      more: false,
    });
  });

  it("numbers each vault's changes on its own", async () => {
    await t.api("PUT", filePath("a.md"), { body: { content: "a" } });
    await t.api("PUT", filePath("b.md"), { body: { content: "b" } });
    const inB = await t.api("PUT", filePath("x.md"), { body: { content: "x" } }, t.b);
    expect(inB.body).toMatchObject({ rev: "r1", seq: 1 });
  });

  it("rejects malformed cursors", async () => {
    const queries: Array<Record<string, string>> = [
      { since: "-1" },
      { since: "abc" },
      { limit: "0" },
      { limit: "1001" },
    ];
    for (const query of queries) {
      expect(await t.api("GET", "/changes", { query })).toMatchObject({
        status: 400,
        body: { error: "invalid_request" },
      });
    }
  });
});

describe("paths", () => {
  it("refuses anything that isn't a canonical vault path", async () => {
    for (const route of [
      "/files/a%2F..%2Fb.md",
      "/files/..%2Fx.md",
      "/files/a%00.md",
      "/files/a%5Cb.md",
      "/files/",
      "/files/a//b.md",
      "/files/%2Fabs.md",
      "/files/bad%E0%A4%A.md",
    ]) {
      expect(await t.api("GET", route), route).toMatchObject({
        status: 400,
        body: { error: "invalid_path" },
      });
    }
    const long = `${"x".repeat(4097)}.md`;
    expect((await t.api("PUT", filePath(long), { body: { content: "x" } })).status).toBe(400);
    for (const bad of ["/abs.md", "../x.md", "a//b.md", "./a.md", "a\\b.md", "", "a/"]) {
      expect(
        await t.api("POST", "/rename", { body: { from: "a.md", to: bad } }),
        bad,
      ).toMatchObject({
        status: 400,
        body: { error: "invalid_path" },
      });
      expect(await t.api("POST", "/folders", { body: { path: bad } }), bad).toMatchObject({
        status: 400,
      });
    }
    expect((await t.api("GET", "/files", { query: { prefix: "../x" } })).status).toBe(400);
  });

  it("resolves raw dot segments before routing, so they can't reach another vault", async () => {
    await t.api("PUT", filePath("x.md"), { body: { content: "b's note" } }, t.b);
    const rawGet = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const { hostname, port } = new URL(t.url);
        const req = httpRequest({
          hostname,
          port,
          path,
          headers: { authorization: `Bearer ${t.a.token}` },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await rawGet(`/v1/vaults/${t.a.id}/files/../../${t.b.id}/files/x.md`)).toBe(401);
    expect(await rawGet(`/v1/vaults/${t.a.id}/files/../../../${t.b.id}/files/x.md`)).toBe(404);
    expect(await rawGet(`/v1/vaults/${t.a.id}/files/./x.md`)).toBe(404);
  });

  it("stores names with unusual characters exactly", async () => {
    for (const path of ["sp ace#%&?.md", "Café/日記 🎉.md", "line\nbreak.md", "tab\there.md"]) {
      expect((await t.api("PUT", filePath(path), { body: { content: path } })).status, path).toBe(
        201,
      );
      expect((await t.api("GET", filePath(path))).body.content).toBe(path);
    }
  });
});

describe("limits and malformed input", () => {
  it("refuses files over the size limit and oversized bodies", async () => {
    const small = await startTestServer({ maxFileBytes: 1_000 });
    try {
      expect(
        await small.api("PUT", filePath("a.md"), { body: { content: "x".repeat(1_000) } }),
      ).toMatchObject({
        status: 201,
      });
      expect(
        await small.api("PUT", filePath("a.md"), { body: { content: "é".repeat(501) } }),
      ).toMatchObject({
        status: 413,
        body: { error: "payload_too_large" },
      });
      const padded = `{"content":"x","pad":"${" ".repeat(80_000)}"}`;
      expect(await small.api("PUT", filePath("a.md"), { rawBody: padded })).toMatchObject({
        status: 413,
        body: { error: "payload_too_large" },
      });
    } finally {
      await small.close();
    }
  });

  it("enforces the vault quota", async () => {
    const tight = await startTestServer({ quotaBytes: 10 });
    try {
      expect(
        (await tight.api("PUT", filePath("a.md"), { body: { content: "12345" } })).status,
      ).toBe(201);
      expect(
        (await tight.api("PUT", filePath("b.md"), { body: { content: "12345" } })).status,
      ).toBe(201);
      expect(await tight.api("PUT", filePath("c.md"), { body: { content: "1" } })).toMatchObject({
        status: 413,
        body: { error: "quota_exceeded" },
      });
      expect((await tight.api("PUT", filePath("a.md"), { body: { content: "1" } })).status).toBe(
        200,
      );
      expect((await tight.api("PUT", filePath("c.md"), { body: { content: "1" } })).status).toBe(
        201,
      );
      expect(
        (await tight.api("PUT", filePath("b.md"), { body: { content: "x" } }, tight.b)).status,
      ).toBe(201);
    } finally {
      await tight.close();
    }
  });

  it("answers malformed bodies with 400s", async () => {
    const cases: Array<[string, string, { body?: unknown; rawBody?: string }, string]> = [
      ["PUT", filePath("a.md"), { rawBody: "{not json" }, "invalid_json"],
      ["PUT", filePath("a.md"), { body: {} }, "invalid_request"],
      ["PUT", filePath("a.md"), { body: { content: 42 } }, "invalid_request"],
      ["PUT", filePath("a.md"), { body: { content: "x", ifMatch: 7 } }, "invalid_request"],
      ["PUT", filePath("a.md"), { body: { content: "x", extra: true } }, "invalid_request"],
      ["PUT", filePath("a.md"), { body: [] }, "invalid_request"],
      ["POST", "/rename", { body: { from: "a.md" } }, "invalid_request"],
      ["POST", "/folders", { rawBody: "null" }, "invalid_request"],
    ];
    for (const [method, route, init, error] of cases) {
      expect(await t.api(method, route, init), `${method} ${route}`).toMatchObject({
        status: 400,
        body: { error },
      });
    }
  });

  it("slows a vault down with 429 and Retry-After, without affecting others", async () => {
    const limited = await startTestServer({ rateLimit: { perSecond: 1, burst: 3 } });
    try {
      for (let i = 0; i < 3; i++) expect((await limited.api("GET", "/files")).status).toBe(200);
      const refused = await limited.api("GET", "/files");
      expect(refused).toMatchObject({ status: 429, body: { error: "rate_limited" } });
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await limited.api("GET", "/files", {}, limited.b)).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("answers unknown routes with 404 after authentication", async () => {
    expect(await t.api("GET", "/nope")).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
    expect((await fetch(`${t.url}/nope`)).status).toBe(404);
    expect(await t.api("GET", "/stream")).toMatchObject({
      status: 426,
      body: { error: "upgrade_required" },
    });
  });
});
