import { createAgentRuntime, type ExecutionProvider } from "@ddl/agent";
import {
  type AgentPlacementStatus,
  type AgentStatusResponse,
  type AppSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  type Routine,
  type RoutineNotification,
  silentLogger,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeasedAgentRuntime } from "./leased-runtime";
import { NullExecutionProvider } from "./null-execution";
import { FakeAgentRuntime, makeThread, tempDir } from "./test-helpers";
import type { AgentStack } from "./wiring";

function setup(settings: AppSettings = DEFAULT_SETTINGS, storage = new MemoryStorageProvider()) {
  const created: Array<{
    runtime: FakeAgentRuntime;
    execution: { dispose: ReturnType<typeof vi.fn> };
  }> = [];
  const leased = new LeasedAgentRuntime({
    mode: "live",
    settings,
    problem: "Checking with the sync server which device runs the agent…",
    createStack: async (current) => {
      const runtime = new FakeAgentRuntime({ storage });
      runtime.updateSettings(current);
      runtime.threads.set("thr_1", makeThread("thr_1"));
      const execution = { dispose: vi.fn(async () => {}) };
      created.push({ runtime, execution });
      return { runtime, execution: execution as unknown as ExecutionProvider } satisfies AgentStack;
    },
    storage,
    logger: silentLogger,
  });
  const statuses: AgentStatusResponse[] = [];
  leased.on("status", (status) => statuses.push(status));
  const routineLists: Routine[][] = [];
  leased.on("routines.changed", (routines) => routineLists.push(routines));
  return { leased, created, statuses, routineLists, storage };
}

const WATCH = {
  name: "Price watch",
  schedule: "every day at 11:00",
  instructions: "Check the price of the blue kettle.",
} as const;

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

  it("keeps routine files editable while the agent runs elsewhere, but can't run them", async () => {
    const { leased, created, routineLists, storage } = setup();
    await leased.start();
    await leased.deactivate("The agent is running on Desktop.");
    const routine = await leased.createRoutine({ ...WATCH, notify: "when_changed" });
    expect(routine).toMatchObject({ name: "Price watch", notify: "when_changed", paused: false });
    expect((await storage.read("Routines/Price watch.md"))?.content).toContain(
      "schedule: every day at 11:00",
    );
    expect(leased.listRoutines().map((r) => r.id)).toEqual([routine.id]);
    expect((await leased.setRoutinePaused(routine.id, true)).paused).toBe(true);
    expect(leased.getRoutine(routine.id)?.paused).toBe(true);
    await vi.waitFor(() => expect(routineLists.at(-1)?.[0]?.paused).toBe(true));
    await expect(leased.runRoutine(routine.id)).rejects.toMatchObject({
      name: "AgentUnavailableError",
      message: "The agent is running on Desktop.",
    });
    expect(created).toHaveLength(0);
    // Nothing of the scheduler's is written where no agent runs.
    expect(await storage.list({ prefix: ".daily-do-list" })).toEqual([]);
  });

  it("announces the routines of whichever runtime takes over", async () => {
    const { leased, created, routineLists } = setup();
    await leased.start();
    await leased.createRoutine(WATCH);
    await leased.activate();
    const real = created[0]!.runtime;
    expect(routineLists.at(-1)?.map((r) => r.name)).toEqual(["Price watch"]);
    const run = await leased.runRoutine(leased.listRoutines()[0]!.id);
    expect(real.callsTo("runRoutine")).toHaveLength(1);
    expect(leased.listThreads({ routineId: run.routine.id }).map((t) => t.id)).toEqual([
      run.threadId,
    ]);
    const before = routineLists.length;
    await leased.deactivate("The agent is running on Desktop.");
    expect(routineLists.length).toBe(before + 1);
    expect(routineLists.at(-1)?.map((r) => r.name)).toEqual(["Price watch"]);
  });
});

describe("LeasedAgentRuntime with the real agent runtime", () => {
  const dirs: Array<{ cleanup: () => void }> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) dir.cleanup();
  });

  /** A leased runtime whose stacks are real mock-mode runtimes on `clock`, over one vault. */
  function realSetup(clock: { now: number }) {
    const home = tempDir("ddl-leased-routines-");
    dirs.push(home);
    const storage = new MemoryStorageProvider();
    let runtimes = 0;
    const leased = new LeasedAgentRuntime({
      mode: "mock",
      settings: DEFAULT_SETTINGS,
      problem: "The agent is running on Desktop.",
      storage,
      logger: silentLogger,
      createStack: async (settings) => {
        runtimes++;
        const execution = new NullExecutionProvider(home.path);
        const runtime = await createAgentRuntime({
          mode: "mock",
          storage,
          settings,
          home: home.path,
          execution,
          now: () => clock.now,
        });
        return { runtime, execution };
      },
    });
    const notifications: RoutineNotification[] = [];
    leased.on("routine.notification", (notification) => notifications.push(notification));
    return { leased, storage, notifications, runtimes: () => runtimes };
  }

  it("schedules routines only while this device holds the lease and the agent is enabled", async () => {
    const at = (day: number, hour: number, minute = 0) =>
      new Date(2026, 8, day, hour, minute).getTime();
    const clock = { now: at(23, 10) };
    const { leased, storage, notifications, runtimes } = realSetup(clock);
    // Browser runs can't happen with no execution provider: each run fails at once, so its
    // outcome is known without waiting on an agent.
    await storage.write(
      "Routines/Price watch.md",
      "---\nschedule: every day at 11:00\nuses: [browser]\n---\nCheck the price of the blue kettle.\n",
    );
    await leased.start();
    const [routine] = leased.listRoutines();
    expect(routine).toMatchObject({ name: "Price watch", uses: ["browser"] });
    const id = routine!.id;

    // This device takes the lease at 10:00 and plans the 11:00 run, then hands the agent over.
    await leased.activate();
    expect(leased.getRoutine(id)?.nextRunAt).toBe(at(23, 11));
    await leased.deactivate("The agent is running on Desktop.");

    // 11:00 goes by while the agent runs elsewhere: nothing runs here.
    clock.now = at(23, 11, 30);
    await leased.createRoutine({ ...WATCH, name: "Other watch" });
    expect(leased.getRoutine(id)?.lastRun).toBeUndefined();
    await expect(leased.runRoutine(id)).rejects.toMatchObject({ name: "AgentUnavailableError" });
    expect(runtimes()).toBe(1);

    // Taking the lease back catches the missed run up, once.
    await leased.activate();
    const runs = leased.listThreads({ routineId: id });
    expect(runs).toHaveLength(1);
    expect(leased.getRoutine(id)).toMatchObject({
      nextRunAt: at(24, 11),
      lastRun: { threadId: runs[0]!.id, trigger: "catch_up", status: "failed" },
    });
    await vi.waitFor(() => expect(notifications.map((n) => n.threadId)).toEqual([runs[0]!.id]));
    await leased.deactivate("The agent is running on Desktop.");
    await vi.waitFor(() =>
      expect(leased.getRoutine(id)?.lastRun).toMatchObject({ trigger: "catch_up" }),
    );

    // With the agent switched off, holding the lease runs nothing, even a missed slot.
    clock.now = at(24, 11, 30);
    leased.updateSettings(mergeSettings(DEFAULT_SETTINGS, { agent: { enabled: false } }));
    await leased.activate();
    expect(runtimes()).toBe(3);
    expect(leased.listThreads({ routineId: id })).toHaveLength(1);
    // Switching it back on starts again from the next slot instead of catching up.
    await leased.setEnabled(true);
    expect(leased.listThreads({ routineId: id })).toHaveLength(1);
    await leased.stop();
    const saved = JSON.parse((await storage.read(".daily-do-list/state/routines.json"))!.content);
    expect(saved.routines[id]).toMatchObject({ nextRunAt: at(25, 11), runs: [runs[0]!.id] });
  });
});
