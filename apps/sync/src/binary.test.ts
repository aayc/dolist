import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_EPOCH_HEADER, SYNC_ROUTES, type SyncWriteResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncStore } from "./store";
import { filePath, StreamClient, startTestServer, type TestServer } from "./test-helpers";

let t: TestServer;
const bytes = Uint8Array.from([0, 255, 254, 128, 10, 13, 137, 80, 78, 71]);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  t = await startTestServer();
});
afterEach(async () => {
  await t.close();
});

function binaryURL(path: string, query: Record<string, string> = {}): URL {
  const url = new URL(SYNC_ROUTES.binaryFile(t.a.id, path), t.url);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function put(
  path: string,
  content = bytes,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(binaryURL(path, query), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${t.a.token}`,
      "x-ddl-device": "dev_a",
      "content-type": "application/octet-stream",
      ...headers,
    },
    body: new Uint8Array(content),
  });
}

function get(path: string, token = t.a.token): Promise<Response> {
  return fetch(binaryURL(path), { headers: { authorization: `Bearer ${token}` } });
}

describe("binary HTTP transport", () => {
  it("round trips arbitrary bytes with metadata, conditional retries and one live change", async () => {
    const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
    try {
      await stream.next("ready");
      const path = "Attachments/100% # café.png";
      const response = await put(path, bytes, { ifAbsent: "1" });
      expect(response.status).toBe(201);
      const first = (await response.json()) as SyncWriteResponse;
      expect(first).toMatchObject({
        path,
        binary: true,
        size: bytes.length,
        hash: hash(bytes),
        created: true,
        seq: 1,
      });
      expect(await stream.next("change")).toMatchObject({ path, rev: first.rev, seq: 1 });
      const raw = await get(path);
      expect(raw.headers.get("content-type")).toBe("application/octet-stream");
      expect(raw.headers.get("content-length")).toBe(String(bytes.length));
      expect(raw.headers.get("x-ddl-file-rev")).toBe(first.rev);
      expect(raw.headers.get("x-ddl-file-hash")).toBe(first.hash);
      expect(raw.headers.get("x-ddl-file-mtime")).toBe(String(first.mtime));
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
      expect((await t.api("GET", filePath(path), { query: { meta: "1" } })).body).toMatchObject({
        binary: true,
        hash: first.hash,
      });
      expect((await t.api("GET", "/files")).body.files).toHaveLength(1);
      const retry = await put(path, bytes, { ifMatch: first.rev });
      expect(await retry.json()).toMatchObject({ rev: first.rev, seq: null, created: false });
      expect((await t.api("GET", "/changes")).body.changes).toHaveLength(1);
      expect(await (await put(path, bytes, { ifAbsent: "1" })).json()).toMatchObject({
        error: "conflict",
        currentRev: first.rev,
      });
      expect((await put(path, bytes, { ifMatch: "stale" })).status).toBe(409);
      expect((await put("empty.bin", new Uint8Array())).status).toBe(201);
      const empty = await get("empty.bin");
      expect(empty.headers.get("content-length")).toBe("0");
      expect((await empty.arrayBuffer()).byteLength).toBe(0);
    } finally {
      stream.ws.close();
      await stream.closed();
    }
  });

  it("refuses binary text access and preserves file type through rename and folder deletion", async () => {
    const first = (await (await put("Attachments/one.bin")).json()) as SyncWriteResponse;
    expect(await t.api("GET", filePath("Attachments/one.bin"))).toMatchObject({
      status: 415,
      body: { error: "unsupported_media_type" },
    });
    expect(
      await t.api("PUT", filePath("Attachments/one.bin"), {
        body: { content: "would corrupt it", ifMatch: first.rev },
      }),
    ).toMatchObject({ status: 415, body: { error: "unsupported_media_type" } });
    const renamed = await t.api("POST", "/rename", {
      body: { from: "Attachments/one.bin", to: "Moved/two.bin" },
    });
    expect(renamed.body).toMatchObject({ rev: first.rev, binary: true, hash: first.hash });
    expect((await get("Attachments/one.bin")).status).toBe(404);
    expect(new Uint8Array(await (await get("Moved/two.bin")).arrayBuffer())).toEqual(bytes);
    expect(await t.api("DELETE", "/folders", { query: { path: "Moved" } })).toMatchObject({
      status: 200,
      body: { deleted: ["Moved/two.bin"] },
    });
    expect((await get("Moved/two.bin")).status).toBe(404);
  });

  it("never leaks another vault and requires the current lease for binary agent artifacts", async () => {
    await put("visible.bin");
    expect((await get("visible.bin", t.b.token)).status).toBe(401);
    expect(
      (await put("other.bin", bytes, {}, { authorization: `Bearer ${t.b.token}` })).status,
    ).toBe(401);
    expect((await put("other.bin", bytes, {}, { "x-ddl-device": "" })).status).toBe(400);
    const path = ".daily-do-list/artifacts/image.png";
    expect(await (await put(path)).json()).toMatchObject({ error: "stale_lease" });
    const lease = await t.api("POST", "/leases/agent", {
      body: { device: "dev_a", deviceName: "Synthetic device", session: "session", ttlMs: 5_000 },
    });
    const epoch = String(lease.body.lease.epoch);
    expect((await put(path, bytes, {}, { [LEASE_EPOCH_HEADER]: epoch })).status).toBe(201);
    expect(
      (
        await put(
          path,
          new Uint8Array([1]),
          {},
          { [LEASE_EPOCH_HEADER]: String(Number(epoch) + 1) },
        )
      ).status,
    ).toBe(409);
    expect(new Uint8Array(await (await get(path)).arrayBuffer())).toEqual(bytes);
  });

  it("bounds upload and download bytes and rejects ambiguous write preconditions", async () => {
    await t.close();
    t = await startTestServer({ maxFileBytes: 4, quotaBytes: 6 });
    expect((await put("too-big.bin", bytes)).status).toBe(413);
    expect((await get("too-big.bin")).status).toBe(404);
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        binaryURL("streamed.bin"),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${t.a.token}`,
            "x-ddl-device": "dev_a",
            "content-type": "application/octet-stream",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.write(new Uint8Array([1, 2, 3]));
      request.end(new Uint8Array([4, 5]));
    });
    expect(streamedStatus).toBe(413);
    expect((await get("streamed.bin")).status).toBe(404);
    expect((await put("a.bin", new Uint8Array([1, 2, 3, 4]))).status).toBe(201);
    expect((await put("b.bin", new Uint8Array([1, 2, 3]))).status).toBe(413);
    const invalidQueries: Record<string, string>[] = [
      { ifMatch: "r1", ifAbsent: "1" },
      { ifAbsent: "true" },
      { extra: "unexpected" },
    ];
    for (const query of invalidQueries) {
      expect((await put("a.bin", new Uint8Array([1]), query)).status).toBe(400);
    }
    expect(
      (await put("a.bin", new Uint8Array([1]), {}, { "content-type": "application/json" })).status,
    ).toBe(415);
    const duplicate = binaryURL("a.bin", { ifMatch: "r1" });
    duplicate.searchParams.append("ifMatch", "r2");
    expect(
      (
        await fetch(duplicate, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${t.a.token}`,
            "x-ddl-device": "dev_a",
            "content-type": "application/octet-stream",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(400);
    // A server restarted with a lower configured file limit must also bound old downloads.
    t.server.store.writeBinary(t.b.id, "old-large.bin", bytes.subarray(0, 5), undefined, "dev_a");
    const old = new URL(SYNC_ROUTES.binaryFile(t.b.id, "old-large.bin"), t.url);
    expect((await fetch(old, { headers: { authorization: `Bearer ${t.b.token}` } })).status).toBe(
      413,
    );
  });

  it("reads text as exact raw UTF-8 and makes an explicit binary conversion a new revision", async () => {
    const text = "\uFEFFA synthetic note 🌿\0";
    const original = await t.api("PUT", filePath("text.md"), { body: { content: text } });
    expect((await t.api("GET", filePath("text.md"))).body.content).toBe(text);
    expect(new Uint8Array(await (await get("text.md")).arrayBuffer())).toEqual(
      new TextEncoder().encode(text),
    );
    const converted = (await (
      await put("text.md", new TextEncoder().encode(text), { ifMatch: original.body.rev })
    ).json()) as SyncWriteResponse;
    expect(converted.binary).toBe(true);
    expect(converted.rev).not.toBe(original.body.rev);
    expect((await t.api("GET", filePath("text.md"))).status).toBe(415);
  });
});

describe("binary blob persistence", () => {
  it("deduplicates per vault, collects only unreferenced blobs and survives restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddl-sync-binary-"));
    const path = join(directory, "sync.sqlite");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    let store = new SyncStore(path, { quotaBytes: bytes.length * 2 });
    const inspect = new DatabaseSync(path);
    try {
      const { vault } = store.createVault("Synthetic");
      const one = store.writeBinary(vault.id, "a.bin", bytes, null, "dev");
      store.writeBinary(vault.id, "b.bin", bytes, null, "dev");
      expect(inspect.prepare("SELECT COUNT(*) AS count FROM blobs").get()?.count).toBe(1);
      expect(store.listVaults()[0]?.bytes).toBe(bytes.length * 2);
      expect(() => store.writeBinary(vault.id, "c.bin", bytes, null, "dev")).toThrow("quota");
      store.delete(vault.id, "a.bin", one.entry.rev, "dev");
      expect(inspect.prepare("SELECT COUNT(*) AS count FROM blobs").get()?.count).toBe(1);
      store.close();
      store = new SyncStore(path);
      expect(store.readBinary(vault.id, "b.bin")?.content).toEqual(bytes);
      store.writeBinary(vault.id, "b.bin", new Uint8Array([9]), undefined, "dev");
      expect(inspect.prepare("SELECT COUNT(*) AS count FROM blobs").get()?.count).toBe(1);
      store.delete(vault.id, "b.bin", undefined, "dev");
      expect(inspect.prepare("SELECT COUNT(*) AS count FROM blobs").get()?.count).toBe(0);
    } finally {
      store.close();
      inspect.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back blob, file, quota and sequence if publishing the change fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddl-sync-binary-"));
    const path = join(directory, "sync.sqlite");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const store = new SyncStore(path);
    const inspect = new DatabaseSync(path);
    try {
      const { vault } = store.createVault("Synthetic");
      inspect.exec(
        "CREATE TRIGGER fail_change BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Injected interruption'); END",
      );
      expect(() => store.writeBinary(vault.id, "a.bin", bytes, null, "dev")).toThrow(
        "Injected interruption",
      );
      expect(store.stat(vault.id, "a.bin")).toBeNull();
      expect(store.latestSeq(vault.id)).toBe(0);
      expect(inspect.prepare("SELECT COUNT(*) AS count FROM blobs").get()?.count).toBe(0);
      expect(store.listVaults()[0]?.bytes).toBe(0);
    } finally {
      store.close();
      inspect.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates schema four without changing text revisions and fails closed on corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddl-sync-binary-"));
    const path = join(directory, "sync.sqlite");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    let store = new SyncStore(path);
    const { vault } = store.createVault("Synthetic");
    const text = store.write(vault.id, "note.md", "Original", null, "dev");
    store.close();
    const inspect = new DatabaseSync(path);
    try {
      inspect.exec(
        "DROP INDEX files_blob_references; DROP TABLE blobs; ALTER TABLE files DROP COLUMN blob_hash; PRAGMA user_version=4",
      );
      store = new SyncStore(path);
      expect(store.read(vault.id, "note.md")).toMatchObject({ ...text.entry, content: "Original" });
      const file = store.writeBinary(vault.id, "a.bin", bytes, null, "dev");
      inspect
        .prepare("UPDATE blobs SET content=? WHERE vault=? AND hash=?")
        .run(new Uint8Array([1]), vault.id, file.entry.hash);
      expect(() => store.readBinary(vault.id, "a.bin")).toThrow("integrity");
      expect(() => store.writeBinary(vault.id, "a.bin", bytes, file.entry.rev, "dev")).toThrow(
        "integrity",
      );
      inspect.exec("UPDATE files SET content=CAST(x'ff' AS TEXT) WHERE path='note.md'");
      expect(() => store.read(vault.id, "note.md")).toThrow("UTF-8");
    } finally {
      store.close();
      inspect.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
