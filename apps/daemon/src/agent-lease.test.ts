import type { SyncLeaseHolder } from "@ddl/core";
import { type LeaseAttempt, SyncServiceClient } from "@ddl/storage";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentLease,
  type AgentLeaseOptions,
  agentLeaseClient,
  type LeaseClient,
  type LeaseTimings,
} from "./agent-lease";
import { RecordingLogger } from "./security/harness";

const FAST: LeaseTimings = {
  ttlMs: 1_000,
  renewEveryMs: 200,
  retryEveryMs: 100,
  maxBackoffMs: 200,
  marginMs: 200,
};

/** A lease the test controls: the next answers, and what was asked. */
class ScriptedClient implements LeaseClient {
  readonly requests: Array<{ deviceName: string; session: string; ttlMs: number }> = [];
  readonly released: string[] = [];
  answer: () => Promise<LeaseAttempt> = async () => ({ granted: true, lease: this.holder("Me") });

  holder(deviceName: string, device = `dev_${deviceName}`): SyncLeaseHolder {
    return { device, deviceName, expiresAt: Date.now() + 60_000, priority: "interactive" };
  }

  acquire(request: { deviceName: string; session: string; ttlMs: number }): Promise<LeaseAttempt> {
    this.requests.push(request);
    return this.answer();
  }

  async release(session: string): Promise<void> {
    this.released.push(session);
  }
}

interface Recorded {
  lease: AgentLease;
  events: string[];
}

const leases: AgentLease[] = [];

function track(options: Partial<AgentLeaseOptions> & Pick<AgentLeaseOptions, "client">): Recorded {
  const events: string[] = [];
  const lease = new AgentLease({
    device: { id: "dev_me", name: "Me" },
    timings: FAST,
    onAcquired: async () => {
      events.push("acquired");
    },
    onUnavailable: async (problem) => {
      events.push(`unavailable: ${problem}`);
    },
    logger: new RecordingLogger(),
    ...options,
  });
  leases.push(lease);
  return { lease, events };
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.stop()));
});

describe("AgentLease", () => {
  it("acquires the lease, then keeps renewing it with the same session", async () => {
    const client = new ScriptedClient();
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(3));
    expect(events).toEqual(["acquired"]);
    expect(lease.state).toEqual({ kind: "held" });
    expect(new Set(client.requests.map((r) => r.session))).toEqual(new Set([lease.session]));
    expect(client.requests[0]).toEqual({ deviceName: "Me", session: lease.session, ttlMs: 1_000 });
  });

  it("says who runs the agent, and takes over when that device lets go", async () => {
    const client = new ScriptedClient();
    const desktop = client.holder("Desktop");
    client.answer = async () => ({ granted: false, holder: desktop });
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(3));
    expect(events).toEqual(["unavailable: The agent is running on Desktop."]);
    expect(lease.state).toEqual({ kind: "elsewhere", holder: desktop });

    client.answer = async () => ({ granted: true, lease: client.holder("Me") });
    await vi.waitFor(() => expect(events).toContain("acquired"));
  });

  it("recognizes an earlier run of the same device", async () => {
    const client = new ScriptedClient();
    client.answer = async () => ({ granted: false, holder: client.holder("Me", "dev_me") });
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatch(/earlier run of this device/);
  });

  it("keeps the agent through brief outages, and stops it before the lease can run out", async () => {
    const client = new ScriptedClient();
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(events).toEqual(["acquired"]));
    client.answer = async () => {
      throw new Error("connection refused");
    };
    const failingSince = performance.now();
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 5_000 });
    // Stopped before the server-side grant (1 s from the last success) could have lapsed.
    expect(performance.now() - failingSince).toBeLessThan(FAST.ttlMs);
    expect(events[1]).toMatch(/stopped here because the sync server stopped answering/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toHaveLength(2);

    client.answer = async () => ({ granted: true, lease: client.holder("Me") });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events[2]).toBe("acquired");
  });

  it("doesn't start the agent while the server can't be reached", async () => {
    const client = new ScriptedClient();
    client.answer = async () => {
      throw new Error("ENOTFOUND sync.example.com");
    };
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(3));
    expect(events).toEqual([
      "unavailable: The agent stays off here until the sync server confirms that no other device runs it (ENOTFOUND sync.example.com).",
    ]);
    expect(lease.state).toMatchObject({ kind: "unreachable" });
  });

  it("winds down, then releases, when stopped while holding", async () => {
    const client = new ScriptedClient();
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(events).toEqual(["acquired"]));
    const order: string[] = [];
    const release = client.release.bind(client);
    client.release = async (session) => {
      order.push("released");
      await release(session);
    };
    await lease.stop(async () => {
      order.push("wound down");
    });
    expect(order).toEqual(["wound down", "released"]);
    expect(client.released).toEqual([lease.session]);
    const asked = client.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.requests.length).toBe(asked);
  });

  it("releases a grant that arrives while it is stopping, without starting the agent", async () => {
    const client = new ScriptedClient();
    let grant!: () => void;
    client.answer = () =>
      new Promise((resolve) => {
        grant = () => resolve({ granted: true, lease: client.holder("Me") });
      });
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests).toHaveLength(1));
    const stopped = lease.stop();
    grant();
    await stopped;
    expect(events).toEqual([]);
    expect(client.released).toEqual([lease.session]);
  });

  it("doesn't release what it never held", async () => {
    const client = new ScriptedClient();
    client.answer = async () => ({ granted: false, holder: client.holder("Desktop") });
    const { lease } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(1));
    await lease.stop();
    expect(client.released).toEqual([]);
  });
});

describe("AgentLease against a sync server", () => {
  let clock: number;
  let server: RunningSyncServer;
  let vault: { id: string; token: string };

  beforeEach(async () => {
    clock = 1_000_000;
    server = await createSyncServer({ db: ":memory:", port: 0, now: () => clock });
    const created = server.store.createVault("Shared");
    vault = { id: created.vault.id, token: created.token };
  });

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.stop()));
    await server.close();
  });

  /** The server's shortest TTL; expiry is driven by its clock, so nothing waits for it. */
  const SERVER: LeaseTimings = { ...FAST, ttlMs: 5_000, marginMs: 1_000 };

  const device = (id: string, name: string, timings: Partial<LeaseTimings> = SERVER) => {
    const client = new SyncServiceClient({
      url: server.url,
      vault: vault.id,
      token: vault.token,
      deviceId: id,
    });
    return track({ client: agentLeaseClient(client), device: { id, name }, timings });
  };

  it("lets exactly one device run the agent; the other takes over after a release", async () => {
    const laptop = device("dev_laptop", "Laptop");
    laptop.lease.start();
    await vi.waitFor(() => expect(laptop.events).toEqual(["acquired"]));
    const desktop = device("dev_desktop", "Desktop");
    desktop.lease.start();
    await vi.waitFor(() =>
      expect(desktop.events).toEqual(["unavailable: The agent is running on Laptop."]),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(laptop.events).toEqual(["acquired"]);

    await laptop.lease.stop();
    expect(server.store.leaseHolder(vault.id, "agent")).toBeNull();
    await vi.waitFor(() => expect(desktop.events.at(-1)).toBe("acquired"));
    expect(server.store.leaseHolder(vault.id, "agent")?.deviceName).toBe("Desktop");
  });

  it("takes over once a silent holder's lease runs out", async () => {
    const crashed = new SyncServiceClient({
      url: server.url,
      vault: vault.id,
      token: vault.token,
      deviceId: "dev_crashed",
    });
    const grant = await crashed.acquireLease("agent", {
      deviceName: "Crashed laptop",
      session: "s_gone",
      ttlMs: 60_000,
    });
    expect(grant.granted).toBe(true);
    const desktop = device("dev_desktop", "Desktop");
    desktop.lease.start();
    await vi.waitFor(() =>
      expect(desktop.events).toEqual(["unavailable: The agent is running on Crashed laptop."]),
    );
    clock += 60_000;
    await vi.waitFor(() => expect(desktop.events.at(-1)).toBe("acquired"));
  });

  it("won't run the agent twice for a copied device id", async () => {
    const original = device("dev_same", "Laptop");
    original.lease.start();
    await vi.waitFor(() => expect(original.events).toEqual(["acquired"]));
    const copy = device("dev_same", "Laptop");
    copy.lease.start();
    await vi.waitFor(() => expect(copy.events).toHaveLength(1));
    expect(copy.events[0]).toMatch(/earlier run of this device/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(original.events).toEqual(["acquired"]);
  });
});
