import type { SyncLeaseHolder } from "@ddl/core";
import { type LeaseAttempt, SyncServiceClient } from "@ddl/storage";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentLease,
  type AgentLeaseOptions,
  agentLeaseClient,
  type LeaseClient,
  type LeaseRequest,
  type LeaseTimings,
  LeaseWatcher,
} from "./agent-lease";
import { RecordingLogger } from "./security/harness";

const FAST: LeaseTimings = {
  ttlMs: 1_000,
  renewEveryMs: 200,
  retryEveryMs: 100,
  takeoverRetryMs: 30,
  maxBackoffMs: 200,
  marginMs: 200,
};

/** A lease the test controls: the next answers, and what was asked. */
class ScriptedClient implements LeaseClient {
  readonly requests: LeaseRequest[] = [];
  readonly released: string[] = [];
  answer: () => Promise<LeaseAttempt> = async () => ({
    granted: true,
    lease: this.holderNamed("Me"),
  });

  holderNamed(
    deviceName: string,
    device = `dev_${deviceName}`,
    extra: Partial<SyncLeaseHolder> = {},
  ): SyncLeaseHolder {
    return {
      device,
      deviceName,
      expiresAt: Date.now() + 60_000,
      epoch: 1,
      priority: "interactive",
      ...extra,
    };
  }

  acquire(request: LeaseRequest): Promise<LeaseAttempt> {
    this.requests.push(request);
    return this.answer();
  }

  async release(session: string): Promise<void> {
    this.released.push(session);
  }

  async holder(): Promise<SyncLeaseHolder | null> {
    return null;
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
    expect(lease.state).toMatchObject({ kind: "held", lease: { deviceName: "Me", epoch: 1 } });
    expect(lease.heldEpoch).toBe(1);
    expect(new Set(client.requests.map((r) => r.session))).toEqual(new Set([lease.session]));
    expect(client.requests[0]).toEqual({
      deviceName: "Me",
      session: lease.session,
      ttlMs: 1_000,
      priority: "interactive",
    });
  });

  it("says who runs the agent, and takes over when that device lets go", async () => {
    const client = new ScriptedClient();
    const desktop = client.holderNamed("Desktop");
    client.answer = async () => ({ granted: false, holder: desktop });
    const { lease, events } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(3));
    expect(events).toEqual(["unavailable: The agent is running on Desktop."]);
    expect(lease.state).toEqual({ kind: "elsewhere", holder: desktop, takeoverPending: false });
    expect(lease.heldEpoch).toBeNull();

    client.answer = async () => ({ granted: true, lease: client.holderNamed("Me") });
    await vi.waitFor(() => expect(events).toContain("acquired"));
  });

  it("recognizes an earlier run of the same device", async () => {
    const client = new ScriptedClient();
    client.answer = async () => ({ granted: false, holder: client.holderNamed("Me", "dev_me") });
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

    client.answer = async () => ({ granted: true, lease: client.holderNamed("Me") });
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
        grant = () => resolve({ granted: true, lease: client.holderNamed("Me") });
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
    client.answer = async () => ({ granted: false, holder: client.holderNamed("Desktop") });
    const { lease } = track({ client });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(1));
    await lease.stop();
    expect(client.released).toEqual([]);
  });

  it("asks often while its takeover is pending, and withdraws it when stopped", async () => {
    const client = new ScriptedClient();
    const vm = client.holderNamed("vm-1", "dev_vm", { priority: "host", yieldRequested: true });
    client.answer = async () => ({ granted: false, holder: vm, takeoverPending: true });
    const changes: string[] = [];
    const { lease } = track({ client, onChange: () => changes.push(lease.state.kind) });
    lease.start();
    await vi.waitFor(() => expect(client.requests.length).toBeGreaterThanOrEqual(5));
    // Every 30 ms, not the 100 ms retry interval.
    expect(client.requests.length).toBeLessThan(20);
    expect(lease.state).toEqual({ kind: "elsewhere", holder: vm, takeoverPending: true });
    expect(changes).toEqual(["elsewhere"]);
    await lease.stop();
    expect(client.released).toEqual([lease.session]);
  });

  it("asks with the priority it's given, and at once when it changes while waiting", async () => {
    const client = new ScriptedClient();
    client.answer = async () => ({ granted: false, holder: client.holderNamed("Desktop") });
    const { lease } = track({
      client,
      priority: "host",
      timings: { ...FAST, retryEveryMs: 5_000 },
    });
    lease.start();
    await vi.waitFor(() => expect(client.requests).toHaveLength(1));
    expect(client.requests[0]?.priority).toBe("host");
    lease.setPriority("interactive");
    await vi.waitFor(() => expect(client.requests).toHaveLength(2));
    expect(client.requests[1]?.priority).toBe("interactive");
    expect(lease.priority).toBe("interactive");
  });

  it("yields when asked: winds the agent down, releases, and asks again later", async () => {
    const client = new ScriptedClient();
    client.answer = async () => ({
      granted: true,
      lease: client.holderNamed("Me", "dev_me", { epoch: 4 }),
    });
    const order: string[] = [];
    const { lease, events } = track({
      client,
      priority: "host",
      windDown: async (problem) => {
        order.push(`wind down (epoch ${lease.heldEpoch}): ${problem}`);
      },
    });
    const release = client.release.bind(client);
    client.release = async (session) => {
      order.push("released");
      await release(session);
    };
    lease.start();
    await vi.waitFor(() => expect(events).toEqual(["acquired"]));
    let asked = false;
    client.answer = async () => {
      if (asked) return { granted: false, holder: client.holderNamed("Laptop") };
      asked = true;
      return {
        granted: true,
        lease: client.holderNamed("Me", "dev_me", { epoch: 4, yieldRequested: true }),
      };
    };
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual([
      "wind down (epoch 4): Another device is taking the agent over.",
      "released",
    ]);
    expect(lease.heldEpoch).toBeNull();
    await vi.waitFor(() =>
      expect(lease.state).toMatchObject({ kind: "elsewhere", holder: { deviceName: "Laptop" } }),
    );
    expect(events.at(-1)).toBe("unavailable: The agent is running on Laptop.");
  });
});

describe("LeaseWatcher", () => {
  it("reports who holds the lease, and only changes", async () => {
    const client = new ScriptedClient();
    let holder: SyncLeaseHolder | null = null;
    client.holder = async () => holder;
    let changes = 0;
    const watcher = new LeaseWatcher({
      client,
      everyMs: 20,
      onChange: () => changes++,
      logger: new RecordingLogger(),
    });
    watcher.start();
    try {
      await vi.waitFor(() => expect(changes).toBe(1));
      expect(watcher.holder).toBeNull();
      holder = client.holderNamed("vm-1", "dev_vm", { priority: "host" });
      await vi.waitFor(() => expect(changes).toBe(2));
      expect(watcher.holder).toMatchObject({ deviceName: "vm-1", priority: "host" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes).toBe(2);
    } finally {
      watcher.stop();
    }
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

  const device = (
    id: string,
    name: string,
    timings: Partial<LeaseTimings> = SERVER,
    extra: Partial<AgentLeaseOptions> = {},
  ) => {
    const client = new SyncServiceClient({
      url: server.url,
      vault: vault.id,
      token: vault.token,
      deviceId: id,
    });
    return track({ client: agentLeaseClient(client), device: { id, name }, timings, ...extra });
  };

  it("hands the agent from the always-on machine to an interactive device, and back", async () => {
    const vm = device("dev_vm", "vm-1", SERVER, { priority: "host" });
    vm.lease.start();
    await vi.waitFor(() => expect(vm.events).toEqual(["acquired"]));
    expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({ priority: "host" });

    const laptop = device("dev_laptop", "Laptop");
    laptop.lease.start();
    await vi.waitFor(() => expect(laptop.events.at(-1)).toBe("acquired"));
    expect(laptop.events).toEqual(["unavailable: The agent is running on vm-1.", "acquired"]);
    await vi.waitFor(() =>
      expect(vm.events).toEqual([
        "acquired",
        "unavailable: Another device is taking the agent over.",
        "unavailable: The agent is running on Laptop.",
      ]),
    );
    expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({
      device: "dev_laptop",
      epoch: 2,
    });
    expect(laptop.lease.heldEpoch).toBe(2);
    expect(vm.lease.heldEpoch).toBeNull();

    await laptop.lease.stop();
    await vi.waitFor(() => expect(vm.events.at(-1)).toBe("acquired"));
    expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({
      device: "dev_vm",
      epoch: 3,
    });
  });

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
