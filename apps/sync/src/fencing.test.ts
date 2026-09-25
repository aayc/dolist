import { LEASE_EPOCH_HEADER } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePath, startTestServer, type TestServer } from "./test-helpers";

let clock = 1_000_000;
let t: TestServer;

beforeEach(async () => {
  clock = 1_000_000;
  t = await startTestServer({ now: () => clock });
});

afterEach(async () => {
  await t.close();
});

const THREAD = ".daily-do-list/threads/thr_1.json";
const lease = (device: string, session = `s_${device}`) =>
  t.api("POST", "/leases/agent", {
    body: { device, deviceName: device, session, ttlMs: 60_000 },
    device,
  });
const epochHeader = (epoch: number | string) => ({ [LEASE_EPOCH_HEADER]: String(epoch) });
const put = (path: string, device: string, epoch?: number | string) =>
  t.api("PUT", filePath(path), {
    body: { content: `{"by":"${device}"}` },
    device,
    ...(epoch === undefined ? {} : { headers: epochHeader(epoch) }),
  });

describe("fencing of the agent's files", () => {
  it("lets only the lease holder change them, with its current grant's epoch", async () => {
    expect((await lease("dev_laptop")).body.lease.epoch).toBe(1);
    expect((await put(THREAD, "dev_laptop", 1)).status).toBe(201);
    for (const [device, epoch] of [
      ["dev_laptop", undefined],
      ["dev_laptop", 2],
      ["dev_desktop", 1],
    ] as const) {
      const refused = await put(THREAD, device, epoch);
      expect(refused).toMatchObject({
        status: 409,
        body: {
          error: "stale_lease",
          currentEpoch: 1,
          holder: { device: "dev_laptop", epoch: 1 },
        },
      });
      expect(Object.keys(refused.body).sort()).toEqual([
        "currentEpoch",
        "error",
        "holder",
        "message",
      ]);
    }
    expect(t.server.store.read(t.a.id, THREAD)?.content).toBe('{"by":"dev_laptop"}');
    expect(t.server.store.latestSeq(t.a.id)).toBe(1);
  });

  it("refuses a former holder once another device took over", async () => {
    await lease("dev_laptop");
    await put(THREAD, "dev_laptop", 1);
    clock += 60_000;
    expect((await lease("dev_vm")).body.lease.epoch).toBe(2);
    expect((await put(THREAD, "dev_vm", 2)).status).toBe(200);
    const stale = await put(THREAD, "dev_laptop", 1);
    expect(stale.body).toMatchObject({ error: "stale_lease", currentEpoch: 2 });
    expect(t.server.store.read(t.a.id, THREAD)?.content).toBe('{"by":"dev_vm"}');
  });

  it("refuses every change while nobody holds the lease", async () => {
    const refused = await put(THREAD, "dev_laptop", 1);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: "stale_lease", currentEpoch: null, holder: null },
    });
    await lease("dev_laptop");
    await put(THREAD, "dev_laptop", 1);
    clock += 60_000;
    expect((await put(THREAD, "dev_laptop", 1)).body).toMatchObject({ currentEpoch: null });
  });

  it("fences deletes, renames in or out, and deleting folders that hold them", async () => {
    await lease("dev_laptop");
    await put(THREAD, "dev_laptop", 1);
    await put("Notes/a.md", "dev_desktop");
    const asDesktop = { device: "dev_desktop" };
    const asHolder = { device: "dev_laptop", headers: epochHeader(1) };
    expect((await t.api("DELETE", filePath(THREAD), asDesktop)).status).toBe(409);
    const into = { from: "Notes/a.md", to: ".daily-do-list/state/a.md" };
    expect((await t.api("POST", "/rename", { body: into, ...asDesktop })).status).toBe(409);
    const out = { from: THREAD, to: "Notes/thread.json" };
    expect((await t.api("POST", "/rename", { body: out, ...asDesktop })).status).toBe(409);
    for (const path of [".daily-do-list/threads", ".daily-do-list", ""]) {
      const response = await t.api("DELETE", "/folders", { query: { path }, ...asDesktop });
      expect(response.status, path).toBe(path === "" ? 400 : 409);
    }
    expect(t.server.store.read(t.a.id, THREAD)).not.toBeNull();

    expect((await t.api("POST", "/rename", { body: into, ...asHolder })).status).toBe(200);
    expect((await t.api("DELETE", filePath(THREAD), asHolder)).status).toBe(204);
    expect(
      (await t.api("DELETE", "/folders", { query: { path: ".daily-do-list" }, ...asHolder })).body,
    ).toEqual({ deleted: [".daily-do-list/state/a.md"] });
  });

  it("leaves settings and notes to every device", async () => {
    await lease("dev_laptop");
    expect((await put(".daily-do-list/settings.json", "dev_desktop")).status).toBe(201);
    expect((await put("Daily/2026-09-25.md", "dev_desktop")).status).toBe(201);
    expect((await put(".daily-do-list/settings.json", "dev_vm")).status).toBe(200);
    await put("Notes/b.md", "dev_desktop");
    const rename = { from: "Notes/b.md", to: "Notes/c.md" };
    expect((await t.api("POST", "/rename", { body: rename, device: "dev_vm" })).status).toBe(200);
    expect(
      (await t.api("DELETE", "/folders", { query: { path: "Notes" }, device: "dev_vm" })).status,
    ).toBe(200);
    expect(
      (await t.api("POST", "/folders", { body: { path: ".daily-do-list/threads/x" } })).status,
    ).toBe(201);
  });

  it("rejects a malformed epoch", async () => {
    await lease("dev_laptop");
    for (const epoch of ["0", "-1", "1.5", "one", "1".repeat(16)]) {
      expect((await put(THREAD, "dev_laptop", epoch)).body, epoch).toMatchObject({
        error: "invalid_request",
      });
      expect((await put("Notes/a.md", "dev_laptop", epoch)).status, epoch).toBe(400);
    }
  });
});
