import {
  API_ROUTES,
  type RoutineListResponse,
  type RoutineResponse,
  type ServerEventOf,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it, vi } from "vitest";
import { NullAgentRuntime } from "../null-runtime";
import { createTestApp, FakeAgentRuntime } from "../test-helpers";

const BRIEFING = {
  name: "Morning briefing",
  schedule: "every weekday at 7:30",
  instructions: "Brief me for the day.",
};

async function agentOff(storage = new MemoryStorageProvider()) {
  const runtime = new NullAgentRuntime({
    problem: "The agent is off (DDL_AGENT_MODE=off).",
    storage,
  });
  await runtime.start();
  return { ...(await createTestApp({ storage, runtime })), runtime };
}

describe("routine routes with the agent off", () => {
  it("create, list, pause and resume the routine files", async () => {
    const { request, storage, runtime } = await agentOff();
    const changed: Array<ServerEventOf<"routines.changed">["routines"]> = [];
    runtime.on("routines.changed", (routines) => changed.push(routines));

    const created = await request(API_ROUTES.routines, { method: "POST", json: BRIEFING });
    expect(created.status).toBe(201);
    const { routine } = (await created.json()) as RoutineResponse;
    expect(routine).toMatchObject({
      path: "Routines/Morning briefing.md",
      scheduleText: "Every weekday at 7:30 AM",
      paused: false,
    });
    expect(await storage.read("Routines/Morning briefing.md")).not.toBeNull();

    const list = (await (await request(API_ROUTES.routines)).json()) as RoutineListResponse;
    expect(list.routines.map((r) => r.id)).toEqual([routine.id]);

    const pause = await request(API_ROUTES.routinePause(routine.id), { method: "POST" });
    expect(((await pause.json()) as RoutineResponse).routine.paused).toBe(true);
    expect((await storage.read(routine.path))?.content).toContain("paused: true");
    const resume = await request(API_ROUTES.routineResume(routine.id), { method: "POST" });
    expect(((await resume.json()) as RoutineResponse).routine.paused).toBe(false);
    await vi.waitFor(() => expect(changed.at(-1)?.[0]?.paused).toBe(false));
  });

  it("follow files edited elsewhere and report the ones that can't run", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Routines/Broken.md", "---\nschedule: whenever\n---\nDo things.\n");
    const { request } = await agentOff(storage);
    const list = (await (await request(API_ROUTES.routines)).json()) as RoutineListResponse;
    expect(list.routines).toEqual([
      expect.objectContaining({ name: "Broken", error: expect.any(String) }),
    ]);
    expect(list.routines[0]!.nextRunAt).toBeUndefined();

    storage.simulateExternalChange(
      "Routines/Watch.md",
      "---\nschedule: every 2 hours\nnotify: when changed\n---\nCheck the kettle price.\n",
    );
    await vi.waitFor(async () => {
      const again = (await (await request(API_ROUTES.routines)).json()) as RoutineListResponse;
      expect(again.routines.map((r) => [r.name, r.notify])).toEqual([
        ["Broken", "always"],
        ["Watch", "when_changed"],
      ]);
    });
  });

  it("refuse to run a routine (503), after checking it exists (404)", async () => {
    const { request } = await agentOff();
    const { routine } = (await (
      await request(API_ROUTES.routines, { method: "POST", json: BRIEFING })
    ).json()) as RoutineResponse;
    const run = await request(API_ROUTES.routineRun(routine.id), { method: "POST" });
    expect(run.status).toBe(503);
    expect(await run.json()).toEqual({
      error: "agent_unavailable",
      message: "The agent is off (DDL_AGENT_MODE=off).",
    });
    expect((await request(API_ROUTES.routineRun("rtn_missing"), { method: "POST" })).status).toBe(
      404,
    );
  });

  it("are unavailable without a vault", async () => {
    const runtime = new NullAgentRuntime({ problem: "The agent runtime failed to load" });
    const { request } = await createTestApp({ runtime });
    expect(
      ((await (await request(API_ROUTES.routines)).json()) as RoutineListResponse).routines,
    ).toEqual([]);
    const created = await request(API_ROUTES.routines, { method: "POST", json: BRIEFING });
    expect(created.status).toBe(503);
  });
});

describe("routine routes with the agent on", () => {
  it("run a routine now and list its run under it", async () => {
    const runtime = new FakeAgentRuntime();
    const { request } = await createTestApp({ runtime });
    const { routine } = (await (
      await request(API_ROUTES.routines, { method: "POST", json: BRIEFING })
    ).json()) as RoutineResponse;
    const run = await request(API_ROUTES.routineRun(routine.id), { method: "POST" });
    expect(run.status).toBe(200);
    const { threadId } = (await run.json()) as { threadId: string };
    expect(runtime.callsTo("runRoutine")).toEqual([[routine.id]]);
    const threads = await request(`${API_ROUTES.threads}?routineId=${routine.id}`);
    expect(await threads.json()).toEqual({
      threads: [expect.objectContaining({ id: threadId, routineId: routine.id })],
    });
    expect(runtime.callsTo("listThreads").at(-1)).toEqual([{ routineId: routine.id }]);
  });
});
