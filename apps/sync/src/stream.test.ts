import { SYNC_STREAM_CLOSE_CODES } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filePath,
  StreamClient,
  startTestServer,
  type TestServer,
  upgradeStatus,
} from "./test-helpers";

let t: TestServer | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("change stream", () => {
  it("starts with the vault's latest seq and pushes every change with its device", async () => {
    t = await startTestServer({ heartbeatMs: 60_000 });
    await t.api("PUT", filePath("before.md"), { body: { content: "x" } });
    const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
    expect(await stream.next("ready")).toEqual({ type: "ready", seq: 1, heartbeatMs: 60_000 });

    const put = (
      await t.api("PUT", filePath("Notes/a.md"), { body: { content: "1" }, device: "dev_b" })
    ).body;
    await t.api("PUT", filePath("Notes/a.md"), { body: { content: "2" }, device: "dev_c" });
    await t.api("POST", "/rename", { body: { from: "Notes/a.md", to: "b.md" }, device: "dev_b" });
    await t.api("DELETE", filePath("b.md"), { device: "dev_c" });

    const frames = [];
    for (let i = 0; i < 5; i++) frames.push(await stream.next("change"));
    expect(frames).toEqual([
      {
        type: "change",
        seq: 2,
        path: "Notes/a.md",
        rev: put.rev,
        deleted: false,
        created: true,
        device: "dev_b",
        at: expect.any(Number),
      },
      {
        type: "change",
        seq: 3,
        path: "Notes/a.md",
        rev: "r3",
        deleted: false,
        created: false,
        device: "dev_c",
        at: expect.any(Number),
      },
      {
        type: "change",
        seq: 4,
        path: "Notes/a.md",
        rev: null,
        deleted: true,
        created: false,
        device: "dev_b",
        at: expect.any(Number),
      },
      {
        type: "change",
        seq: 5,
        path: "b.md",
        rev: "r3",
        deleted: false,
        created: true,
        device: "dev_b",
        at: expect.any(Number),
      },
      {
        type: "change",
        seq: 6,
        path: "b.md",
        rev: null,
        deleted: true,
        created: false,
        device: "dev_c",
        at: expect.any(Number),
      },
    ]);
    stream.ws.close();
  });

  it("sends each vault's changes to that vault's streams only", async () => {
    t = await startTestServer();
    const inA = await StreamClient.open(t.url, t.a.id, t.a.token);
    const alsoA = await StreamClient.open(t.url, t.a.id, t.a.token);
    const inB = await StreamClient.open(t.url, t.b.id, t.b.token);
    await t.api("PUT", filePath("only-a.md"), { body: { content: "a" } });
    await t.api("PUT", filePath("only-b.md"), { body: { content: "b" } }, t.b);
    expect((await inA.next("change")).path).toBe("only-a.md");
    expect((await alsoA.next("change")).path).toBe("only-a.md");
    expect((await inB.next("change")).path).toBe("only-b.md");
    expect(inB.frames.filter((f) => f.type === "change")).toHaveLength(1);
    for (const s of [inA, alsoA, inB]) s.ws.close();
  });

  it("sends heartbeats with the latest seq", async () => {
    t = await startTestServer({ heartbeatMs: 50 });
    const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
    await t.api("PUT", filePath("a.md"), { body: { content: "x" } });
    await vi.waitFor(() =>
      expect(stream.frames.some((f) => f.type === "heartbeat" && f.seq === 1)).toBe(true),
    );
    stream.ws.close();
  });

  it("closes a vault's streams when its token is rotated", async () => {
    // Long enough for pongs to come back between beats even on a loaded machine.
    t = await startTestServer({ heartbeatMs: 400 });
    const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
    const other = await StreamClient.open(t.url, t.b.id, t.b.token);
    t.server.store.rotateToken(t.a.id);
    expect(await stream.closed()).toBe(SYNC_STREAM_CLOSE_CODES.tokenRevoked);
    await vi.waitFor(
      () => expect(other.frames.filter((f) => f.type === "heartbeat").length).toBeGreaterThan(1),
      { timeout: 3_000 },
    );
    expect(other.closeCode).toBeUndefined();
    expect(
      await upgradeStatus(t.url, `/v1/vaults/${t.a.id}/stream`, {
        authorization: `Bearer ${t.a.token}`,
      }),
    ).toBe(401);
    other.ws.close();
  });

  it("refuses streams beyond the per-vault limit", async () => {
    t = await startTestServer({ maxStreamsPerVault: 2 });
    const open = [
      await StreamClient.open(t.url, t.a.id, t.a.token),
      await StreamClient.open(t.url, t.a.id, t.a.token),
    ];
    const headers = { authorization: `Bearer ${t.a.token}` };
    expect(await upgradeStatus(t.url, `/v1/vaults/${t.a.id}/stream`, headers)).toBe(429);
    for (const s of open) s.ws.close();
    await vi.waitFor(() => expect(t!.server.hub.count(t!.a.id)).toBe(0));
    expect(await upgradeStatus(t.url, `/v1/vaults/${t.a.id}/stream`, headers)).toBe(101);
  });

  it("closes streams with 1001 when the server shuts down", async () => {
    t = await startTestServer();
    const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
    await stream.next("ready");
    await t.close();
    t = undefined;
    expect(await stream.closed()).toBe(SYNC_STREAM_CLOSE_CODES.shuttingDown);
  });
});
