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

type LeaseAsk = typeof laptop & { priority?: string };

const acquire = (request: LeaseAsk) =>
  t.api("POST", "/leases/agent", { body: request, device: request.device });
const release = (request: LeaseAsk) =>
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
});

describe("agent lease priorities", () => {
  const vm = { ...desktop, device: "dev_vm", deviceName: "vm-1", session: "s_vm_1" };
  const host = { ...vm, priority: "host" };
  const interactive = { ...laptop, priority: "interactive" };
  const lease = async () => (await t.api("GET", "/leases/agent")).body.holder;

  it("asks a host holder to yield to an interactive request, then keeps it for that device", async () => {
    expect((await acquire(host)).body.lease).toMatchObject({ priority: "host", epoch: 1 });
    const asked = await acquire(interactive);
    expect(asked).toMatchObject({
      status: 409,
      body: {
        error: "lease_held",
        takeoverPending: true,
        holder: { device: "dev_vm", priority: "host", yieldRequested: true },
      },
    });
    clock += 3_000;
    expect((await acquire(interactive)).body.takeoverPending).toBe(true);
    clock += 17_000;
    expect((await acquire(host)).body.lease).toMatchObject({ epoch: 1, yieldRequested: true });
    expect(await lease()).toMatchObject({ device: "dev_vm", yieldRequested: true });

    expect((await release(host)).status).toBe(204);
    expect(await lease()).toBeNull();
    // Kept for the laptop: neither the host nor another host-priority device may take it.
    expect((await acquire(host)).body).toMatchObject({
      error: "lease_held",
      holder: { device: "dev_laptop", deviceName: "Laptop", priority: "interactive", epoch: 2 },
    });
    const otherHost = { ...host, device: "dev_vm2", session: "s_vm2" };
    expect((await acquire(otherHost)).status).toBe(409);
    clock += 3_000;
    const taken = await acquire(interactive);
    expect(taken).toMatchObject({
      status: 200,
      body: { lease: { device: "dev_laptop", epoch: 2 } },
    });
    expect(taken.body.lease.yieldRequested).toBeUndefined();
    expect((await acquire(host)).body).toMatchObject({
      holder: { device: "dev_laptop", priority: "interactive" },
    });
    expect((await acquire(host)).body.takeoverPending).toBeUndefined();

    // The laptop leaves: the host takes the agent back at once.
    expect((await release(interactive)).status).toBe(204);
    expect((await acquire(host)).body.lease).toMatchObject({ device: "dev_vm", epoch: 3 });
  });

  it("keeps first come, first served among equal priorities", async () => {
    await acquire(interactive);
    const other = { ...desktop, priority: "interactive" };
    expect((await acquire(other)).body).toMatchObject({ error: "lease_held" });
    expect((await acquire(other)).body.takeoverPending).toBeUndefined();
    expect((await acquire(host)).body.takeoverPending).toBeUndefined();
    expect((await acquire(interactive)).body.lease.yieldRequested).toBeUndefined();

    await release(interactive);
    await acquire(host);
    expect((await acquire(interactive)).body.takeoverPending).toBe(true);
    // The first request keeps the pending slot; an equal priority may still take a released lease.
    expect((await acquire(other)).body.takeoverPending).toBeUndefined();
    await release(host);
    expect((await acquire(other)).body.lease).toMatchObject({ device: "dev_desktop" });
    expect((await acquire(interactive)).body.takeoverPending).toBeUndefined();
  });

  it("gives the lease to anyone once the grace period after a release is over", async () => {
    await acquire(host);
    await acquire(interactive);
    await release(host);
    clock += 29_999;
    expect((await acquire(host)).status).toBe(409);
    clock += 1;
    expect((await acquire(host)).body.lease).toMatchObject({ device: "dev_vm", epoch: 2 });
  });

  it("drops a takeover whose requester stopped asking", async () => {
    await acquire(host);
    await acquire(interactive);
    for (let i = 0; i < 2; i++) {
      clock += 20_000;
      expect((await acquire(host)).body.lease.yieldRequested).toBe(true);
    }
    clock += 20_000;
    expect((await acquire(host)).body.lease.yieldRequested).toBeUndefined();
    expect((await lease()).yieldRequested).toBeUndefined();
  });

  it("keeps a crashed holder's lease for the requester that asked to take over", async () => {
    await acquire(host);
    clock += 50_000;
    await acquire(interactive);
    clock += 10_000;
    expect(await lease()).toBeNull();
    const restarted = { ...host, session: "s_vm_2" };
    expect((await acquire(restarted)).status).toBe(409);
    clock += 2_000;
    expect((await acquire(interactive)).body.lease).toMatchObject({ device: "dev_laptop" });
  });

  it("lets the requester withdraw its takeover", async () => {
    await acquire(host);
    await acquire(interactive);
    expect((await release(interactive)).status).toBe(204);
    expect((await acquire(host)).body.lease.yieldRequested).toBeUndefined();
    await release(host);
    expect((await acquire(host)).status).toBe(200);
  });

  it("follows the priority its holder renews with", async () => {
    await acquire(host);
    await acquire(interactive);
    expect((await acquire({ ...vm, priority: "interactive" })).body.lease).toMatchObject({
      priority: "interactive",
      epoch: 1,
    });
    expect((await lease()).yieldRequested).toBeUndefined();
    expect((await acquire(interactive)).body.takeoverPending).toBeUndefined();
  });
});

describe("agent lease requests", () => {
  it("are validated", async () => {
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

const PENDING_COLUMNS = [
  "pending_device",
  "pending_device_name",
  "pending_priority",
  "pending_asked_at",
];

describe.each([
  [1, "priorities", ["epoch", "priority", ...PENDING_COLUMNS]],
  [2, "epochs", ["epoch", ...PENDING_COLUMNS]],
  [3, "takeovers", PENDING_COLUMNS],
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
