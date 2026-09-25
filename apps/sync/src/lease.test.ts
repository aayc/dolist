import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncStore } from "./store";
import { startTestServer, type TestServer } from "./test-helpers";

let clock = 1_000_000;
let t: TestServer;

beforeEach(async () => {
  clock = 1_000_000;
  t = await startTestServer({ now: () => clock });
});

afterEach(async () => {
  await t.close();
});

const laptop = { device: "dev_laptop", deviceName: "Laptop", session: "s_laptop_1", ttlMs: 60_000 };
const desktop = {
  device: "dev_desktop",
  deviceName: "Desktop",
  session: "s_desktop_1",
  ttlMs: 60_000,
};

const acquire = (request: typeof laptop) =>
  t.api("POST", "/leases/agent", { body: request, device: request.device });
const release = (request: typeof laptop) =>
  t.api("DELETE", "/leases/agent", {
    query: { device: request.device, session: request.session },
    device: request.device,
  });

describe("agent lease", () => {
  it("is granted when free and renewed by its holder", async () => {
    expect((await t.api("GET", "/leases/agent")).body).toEqual({ holder: null });
    expect(await acquire(laptop)).toMatchObject({
      status: 200,
      body: { lease: { device: "dev_laptop", deviceName: "Laptop", expiresAt: clock + 60_000 } },
    });
    clock += 20_000;
    expect((await acquire(laptop)).body.lease.expiresAt).toBe(clock + 60_000);
    expect((await t.api("GET", "/leases/agent")).body).toEqual({
      holder: {
        device: "dev_laptop",
        deviceName: "Laptop",
        expiresAt: clock + 60_000,
        epoch: 1,
        priority: "interactive",
      },
    });
  });

  it("numbers its grants: a renewal keeps the epoch, every new grant takes the next", async () => {
    const epoch = async (request: typeof laptop) => (await acquire(request)).body.lease.epoch;
    expect(await epoch(laptop)).toBe(1);
    clock += 20_000;
    expect(await epoch(laptop)).toBe(1);
    expect((await acquire(desktop)).body).toMatchObject({ holder: { epoch: 1 } });
    await release(laptop);
    expect((await t.api("GET", "/leases/agent")).body).toEqual({ holder: null });
    expect(await epoch(desktop)).toBe(2);
    clock += 60_000;
    expect(await epoch(desktop)).toBe(3);
    clock += 60_000;
    expect(await epoch({ ...laptop, session: "s_laptop_2" })).toBe(4);
    expect((await release(desktop)).status).toBe(409);
    const inB = await t.api("POST", "/leases/agent", { body: laptop, device: laptop.device }, t.b);
    expect(inB.body.lease.epoch).toBe(1);
  });

  it("reports the priority its holder asked with (interactive when absent)", async () => {
    expect((await acquire(laptop)).body.lease.priority).toBe("interactive");
    await release(laptop);
    const host = { ...desktop, priority: "host" };
    expect((await acquire(host)).body.lease).toMatchObject({
      device: "dev_desktop",
      priority: "host",
    });
    expect((await t.api("GET", "/leases/agent")).body.holder.priority).toBe("host");
    expect((await acquire(laptop)).body).toMatchObject({
      error: "lease_held",
      holder: { device: "dev_desktop", priority: "host" },
    });
  });

  it("can't be taken while another device holds it, nor by another session of the holder", async () => {
    const held = (await acquire(laptop)).body.lease;
    const stolen = await acquire(desktop);
    expect(stolen).toMatchObject({
      status: 409,
      body: { error: "lease_held", holder: held },
    });
    const clone = await acquire({ ...laptop, session: "s_laptop_2" });
    expect(clone).toMatchObject({ status: 409, body: { holder: held } });
    expect(await release(desktop)).toMatchObject({ status: 409, body: { holder: held } });
    expect((await t.api("GET", "/leases/agent")).body.holder).toEqual(held);
  });

  it("passes to another device once it expires", async () => {
    await acquire(laptop);
    clock += 59_999;
    expect((await acquire(desktop)).status).toBe(409);
    clock += 1;
    expect((await t.api("GET", "/leases/agent")).body).toEqual({ holder: null });
    expect(await acquire(desktop)).toMatchObject({
      status: 200,
      body: { lease: { device: "dev_desktop" } },
    });
    expect((await acquire(laptop)).status).toBe(409);
  });

  it("is free again as soon as its holder releases it", async () => {
    await acquire(laptop);
    expect((await release(laptop)).status).toBe(204);
    expect((await t.api("GET", "/leases/agent")).body).toEqual({ holder: null });
    expect((await release(laptop)).status).toBe(204);
    expect((await acquire(desktop)).status).toBe(200);
  });

  it("is per vault", async () => {
    await acquire(laptop);
    const inB = await t.api(
      "POST",
      "/leases/agent",
      { body: desktop, device: desktop.device },
      t.b,
    );
    expect(inB.status).toBe(200);
  });

  it("validates requests", async () => {
    const bad = [
      { ...laptop, ttlMs: 4_999 },
      { ...laptop, ttlMs: 600_001 },
      { ...laptop, deviceName: "" },
      { ...laptop, deviceName: "bad\u0007name" },
      { ...laptop, session: "has space" },
      { ...laptop, extra: 1 },
      { ...laptop, priority: "urgent" },
      { ...laptop, priority: null },
    ];
    for (const body of bad) {
      expect((await t.api("POST", "/leases/agent", { body, device: laptop.device })).status).toBe(
        400,
      );
    }
    const mismatch = await t.api("POST", "/leases/agent", { body: laptop, device: "dev_other" });
    expect(mismatch).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(
      (await t.api("POST", "/leases/nope", { body: laptop, device: laptop.device })).status,
    ).toBe(404);
    expect((await t.api("DELETE", "/leases/agent", { device: laptop.device })).status).toBe(400);
  });
});

describe.each([
  [1, "priorities", ["epoch", "priority"]],
  [2, "epochs", ["epoch"]],
] as const)("the lease in a database from before %s (schema %i)", (version, _before, dropped) => {
  it("keeps the lease held during the upgrade as interactive grant 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ddl-sync-lease-"));
    try {
      const db = join(dir, "sync.db");
      const created = new SyncStore(db, { now: () => clock });
      const { vault } = created.createVault("Personal");
      created.close();
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const old = new DatabaseSync(db);
      for (const column of dropped) old.exec(`ALTER TABLE leases DROP COLUMN ${column}`);
      old
        .prepare(
          `INSERT INTO leases (vault, name, device, device_name, session, expires_at)
           VALUES (?, 'agent', 'dev_laptop', 'Laptop', 's_laptop_1', ?)`,
        )
        .run(vault.id, clock + 60_000);
      old.exec(`PRAGMA user_version = ${version}`);
      old.close();

      const store = new SyncStore(db, { now: () => clock });
      try {
        expect(store.leaseHolder(vault.id, "agent")).toEqual({
          device: "dev_laptop",
          deviceName: "Laptop",
          expiresAt: clock + 60_000,
          epoch: 1,
          priority: "interactive",
        });
        expect(store.acquireLease(vault.id, "agent", laptop)).toMatchObject({
          ok: true,
          holder: { epoch: 1 },
        });
        clock += 60_000;
        expect(
          store.acquireLease(vault.id, "agent", { ...desktop, priority: "host" }),
        ).toMatchObject({
          ok: true,
          holder: { device: "dev_desktop", priority: "host", epoch: 2 },
        });
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
