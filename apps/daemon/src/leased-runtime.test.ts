import type { ExecutionProvider } from "@ddl/agent";
import {
  type AgentPlacementStatus,
  type AgentStatusResponse,
  type AppSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  silentLogger,
} from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import { LeasedAgentRuntime } from "./leased-runtime";
import { FakeAgentRuntime, makeThread } from "./test-helpers";
import type { AgentStack } from "./wiring";

function setup(settings: AppSettings = DEFAULT_SETTINGS) {
  const created: Array<{
    runtime: FakeAgentRuntime;
    execution: { dispose: ReturnType<typeof vi.fn> };
  }> = [];
  const leased = new LeasedAgentRuntime({
    mode: "live",
    settings,
    problem: "Checking with the sync server which device runs the agent…",
    createStack: async (current) => {
      const runtime = new FakeAgentRuntime();
      runtime.updateSettings(current);
      runtime.threads.set("thr_1", makeThread("thr_1"));
      const execution = { dispose: vi.fn(async () => {}) };
      created.push({ runtime, execution });
      return { runtime, execution: execution as unknown as ExecutionProvider } satisfies AgentStack;
    },
    logger: silentLogger,
  });
  const statuses: AgentStatusResponse[] = [];
  leased.on("status", (status) => statuses.push(status));
  return { leased, created, statuses };
}

describe("LeasedAgentRuntime", () => {
  it("runs no agent until activated, and says why", async () => {
    const { leased, created } = setup();
    await leased.start();
    expect(created).toHaveLength(0);
    expect(leased.active).toBe(false);
    expect(leased.status()).toMatchObject({
      mode: "live",
      enabled: true,
      running: 0,
      problem: "Checking with the sync server which device runs the agent…",
    });
    expect(leased.listThreads()).toEqual([]);
    await leased.deactivate("The agent is running on Desktop.");
    await expect(leased.postUserMessage("thr_1", "hi")).rejects.toMatchObject({
      name: "AgentUnavailableError",
      message: "The agent is running on Desktop.",
    });
    await expect(leased.retryThread("thr_1")).rejects.toMatchObject({
      message: "The agent is running on Desktop.",
    });
  });

  it("creates the real runtime on activation, starts it and routes everything to it", async () => {
    const { leased, created, statuses } = setup();
    await leased.start();
    await leased.activate();
    expect(created).toHaveLength(1);
    const real = created[0]!.runtime;
    expect(real.callsTo("start")).toHaveLength(1);
    expect(leased.status().problem).toBeUndefined();
    expect(statuses.at(-1)).toEqual(real.status());
    expect(leased.listThreads().map((t) => t.id)).toEqual(["thr_1"]);
    await leased.postUserMessage("thr_1", "prefer mornings");
    expect(real.callsTo("postUserMessage")).toEqual([["thr_1", "prefer mornings"]]);

    const upserts: string[] = [];
    leased.on("thread.upsert", (thread) => upserts.push(thread.id));
    real.emit("thread.upsert", { ...leased.listThreads()[0]!, id: "thr_2" });
    expect(upserts).toEqual(["thr_2"]);
    await leased.activate();
    expect(created).toHaveLength(1);
  });

  it("stops the real runtime when deactivated, and listeners follow the swap", async () => {
    const { leased, created, statuses } = setup();
    await leased.start();
    const upserts: string[] = [];
    leased.on("thread.upsert", (thread) => upserts.push(thread.id));
    await leased.activate();
    const first = created[0]!;
    await leased.deactivate("The agent is running on Desktop.");
    expect(first.runtime.callsTo("stop")).toHaveLength(1);
    expect(first.execution.dispose).toHaveBeenCalledOnce();
    expect(statuses.at(-1)?.problem).toBe("The agent is running on Desktop.");
    first.runtime.emit("thread.upsert", {
      ...first.runtime.listThreads()[0]!,
      id: "from-the-old-one",
    });
    expect(upserts).toEqual([]);

    await leased.activate();
    const second = created[1]!;
    second.runtime.emit("thread.upsert", {
      ...second.runtime.listThreads()[0]!,
      id: "from-the-new-one",
    });
    expect(upserts).toEqual(["from-the-new-one"]);
  });

  it("creates each runtime with the latest settings and keeps both sides informed", async () => {
    const { leased, created } = setup();
    const paused = mergeSettings(DEFAULT_SETTINGS, { agent: { enabled: false } });
    leased.updateSettings(paused);
    expect(leased.status().enabled).toBe(false);
    await leased.activate();
    expect(created[0]!.runtime.enabled).toBe(false);
    leased.updateSettings(DEFAULT_SETTINGS);
    expect(created[0]!.runtime.callsTo("updateSettings").at(-1)).toEqual([DEFAULT_SETTINGS]);
    await leased.deactivate("elsewhere");
    expect(leased.status().enabled).toBe(true);
  });

  it("starts a runtime activated before start() only when started", async () => {
    const { leased, created } = setup();
    await leased.activate();
    expect(created[0]!.runtime.callsTo("start")).toHaveLength(0);
    await leased.start();
    expect(created[0]!.runtime.callsTo("start")).toHaveLength(1);
  });

  it("never activates after stop(), and stop() disposes a running runtime", async () => {
    const { leased, created } = setup();
    await leased.start();
    await leased.activate();
    await leased.stop();
    expect(created[0]!.runtime.callsTo("stop")).toHaveLength(1);
    expect(created[0]!.execution.dispose).toHaveBeenCalledOnce();
    await leased.activate();
    expect(created).toHaveLength(1);
  });

  it("adds the placement to every status and status event, the runtime's own included", async () => {
    let placement: AgentPlacementStatus = { placement: "this_device", runsOn: null, relay: "off" };
    const runtime = new FakeAgentRuntime();
    const leased = new LeasedAgentRuntime({
      mode: "live",
      settings: DEFAULT_SETTINGS,
      problem: "Checking…",
      createStack: async () => ({ runtime, execution: null }),
      statusExtras: () => ({ placement }),
      logger: silentLogger,
    });
    const statuses: AgentStatusResponse[] = [];
    leased.on("status", (status) => statuses.push(status));
    expect(leased.status().placement).toEqual(placement);
    placement = { ...placement, note: "Taking over from vm-1…" };
    leased.refreshStatus();
    expect(statuses.at(-1)?.placement?.note).toBe("Taking over from vm-1…");

    await leased.activate();
    expect(leased.status()).toMatchObject({ execution: { provider: "fake" }, placement });
    statuses.length = 0;
    runtime.emit("status", runtime.status());
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ execution: { provider: "fake" }, placement });
  });
});
