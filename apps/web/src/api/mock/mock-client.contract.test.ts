/**
 * MockDaemonClient fidelity: the in-browser mock must speak exactly the real protocol. A full
 * scenario (tasks, streaming, artifacts, frames, approvals approved and denied, cancel, retry,
 * settings) must emit only conformant events, and every REST-equivalent result or error body must
 * parse strictly with the schema the daemon's route declares.
 */

import {
  exact,
  SERVER_EVENT_TYPES,
  ServerEventSchema,
  WIRE_SCHEMAS,
  type WireSchemaName,
} from "@ddl/contract/wire";
import { type ServerEvent, type ServerEventOf, today, toISODate } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors";
import { MockDaemonClient } from "./mock-client";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function expectWire(name: WireSchemaName, value: unknown, label: string = name): void {
  const parsed = exact(WIRE_SCHEMAS[name]).safeParse(JSON.parse(JSON.stringify(value)));
  expect(parsed.error?.issues ?? [], `${label}: ${JSON.stringify(value).slice(0, 300)}`).toEqual(
    [],
  );
}

/** REST calls resolve on a timer (like a network round trip). */
async function call<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1);
  return promise;
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  const settled = promise.then(
    () => expect.unreachable("expected the call to fail"),
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1);
  const error = await settled;
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

function ofType<T extends ServerEvent["type"]>(events: ServerEvent[], type: T): ServerEventOf<T>[] {
  return events.filter((e): e is ServerEventOf<T> => e.type === type);
}

function create() {
  const client = new MockDaemonClient({ speed: 10, installHooks: false, persistSettings: false });
  const events: ServerEvent[] = [];
  client.onEvent((event) => events.push(event));
  // Watch every thread's surfaces as soon as it appears, like an open thread view would.
  client.onEvent((event) => {
    if (event.type !== "thread.upsert") return;
    for (const surface of ["browser", "computer"] as const) {
      client.send({ type: "surface.subscribe", threadId: event.thread.id, surface });
    }
  });
  client.connect();
  return { client, events };
}

async function writeToday(client: MockDaemonClient, lines: string[]) {
  const note = await call(client.getDailyNote(toISODate(today())));
  await call(client.writeNote(note.path, { content: lines.join("\n"), baseVersion: note.version }));
  return note.path;
}

async function checkQueries(client: MockDaemonClient, notePath: string) {
  expectWire("HealthResponse", await call(client.health()));
  expectWire("VaultTreeResponse", await call(client.getTree()));
  expectWire("SettingsResponse", await call(client.getSettings()));
  expectWire("AgentStatusResponse", await call(client.getAgentStatus()));
  expectWire("ConnectorsResponse", { connectors: await call(client.getConnectors()) });
  expectWire("TaskRecordsResponse", await call(client.getTaskRecords(notePath)));
  expectWire("ApprovalListResponse", await call(client.listApprovals()));
  const { threads } = await call(client.listThreads());
  expectWire("ThreadListResponse", { threads });
  for (const summary of threads) {
    const response = await call(client.getThread(summary.id));
    expectWire("ThreadResponse", response, `thread ${summary.id}`);
    for (const artifact of response.thread.artifacts) {
      const content = await call(client.getArtifact(summary.id, artifact.id));
      expect(content.mimeType).toBe(artifact.mimeType);
    }
  }
}

/**
 * Event types of flows the mock doesn't have yet. A stream adding a flow to the mock removes its
 * events here (the import from Obsidian comes with its web flow).
 */
const NOT_MOCKED_YET = new Set<string>(["import.progress"]);

describe("MockDaemonClient ⇄ wire contract", () => {
  it("runs a full scenario emitting only conformant events and results", async () => {
    const { client, events } = create();
    await vi.advanceTimersByTimeAsync(1);
    expect(events[0]).toMatchObject({ type: "hello" });

    const daily = await call(client.getDailyNote("today"));
    expectWire("DailyNoteResponse", daily);
    expectWire("DailyNoteResponse", await call(client.getDailyNote(daily.date, false)));
    // Yesterday's demo note has line-anchor records.
    const before = new Date();
    before.setDate(before.getDate() - 1);
    const yesterday = await call(client.getDailyNote(toISODate(today(before)), false));
    const demoRecords = await call(client.getTaskRecords(yesterday.path));
    expect(demoRecords.records.some((r) => r.anchor === "line")).toBe(true);
    expectWire("TaskRecordsResponse", demoRecords);
    expectWire("SearchResponse", await call(client.search("cedar")));
    const ideas = await call(client.readNote("Ideas.md"));
    expectWire("NoteResponse", ideas);
    expectWire(
      "WriteNoteResponse",
      await call(
        client.writeNote("Ideas.md", { content: `${ideas.content}\n`, baseVersion: ideas.version }),
      ),
    );
    await checkQueries(client, daily.path);

    const path = await writeToday(client, [
      "- [ ] Compare three robot vacuums",
      "- [ ] Order a new kettle",
      "- [ ] Email the landlord about the heater",
      "- [ ] Clean up the screenshots in my Downloads folder",
      "- [ ] Reserve a table for Friday",
    ]);
    client.send({ type: "editor.activity", notePath: path, line: 0 });
    await vi.advanceTimersByTimeAsync(3_000);

    const pending = ofType(events, "approval.upsert")
      .map((e) => e.approval)
      .filter((approval) => approval.status === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const [approve, deny] = pending;
    expectWire(
      "ApprovalRequest",
      await call(client.decideApproval(approve!.id, { decision: "approve", scope: "once" })),
    );
    await call(client.decideApproval(deny!.id, { decision: "deny", note: "I'll call instead" }));

    const reserve = ofType(events, "task.record").find((e) =>
      e.record.text.startsWith("Reserve"),
    )?.record;
    if (reserve?.threadId) {
      await call(client.cancelThread(reserve.threadId));
      await call(client.retryThread(reserve.threadId));
      await call(client.postMessage(reserve.threadId, "Somewhere quiet, please"));
      client.send({ type: "thread.read", threadId: reserve.threadId });
    }
    await vi.advanceTimersByTimeAsync(5_000);

    const routines = await call(client.listRoutines());
    expectWire("RoutineListResponse", routines);
    const template = routines.templates[0]!;
    const created = await call(
      client.createRoutine({
        name: template.name,
        schedule: template.schedule,
        instructions: template.instructions,
        notify: template.notify,
        uses: template.uses,
      }),
    );
    expectWire("RoutineResponse", created);
    expectWire("RoutineResponse", await call(client.getRoutine(created.routine.id)));
    const started = await call(client.runRoutine(created.routine.id));
    expectWire("RoutineRunResponse", started);
    await vi.advanceTimersByTimeAsync(3_000);
    expectWire(
      "ThreadListResponse",
      await call(client.listThreads({ routineId: created.routine.id })),
    );
    expectWire("RoutineResponse", await call(client.pauseRoutine(created.routine.id)));
    expectWire("RoutineResponse", await call(client.resumeRoutine(created.routine.id)));
    expectWire("RoutineListResponse", await call(client.listRoutines()));

    // Removing a task that has a record publishes the note's records snapshot.
    const current = await call(client.readNote(path));
    const kept = current.content.split("\n").filter((line) => !line.includes("robot vacuums"));
    await call(client.writeNote(path, { content: kept.join("\n"), baseVersion: current.version }));
    await vi.advanceTimersByTimeAsync(10);

    expectWire(
      "SettingsResponse",
      await call(client.updateSettings({ editor: { vimMode: true }, agent: { settleMs: 1000 } })),
    );
    expectWire(
      "SettingsResponse",
      await call(client.updateSettings({ agent: { harness: "cursor", cursorModel: " gpt-5.5 " } })),
    );
    expectWire("AgentStatusResponse", await call(client.setAgentEnabled(false)));
    await checkQueries(client, path);
    client.disconnect();

    for (const [i, event] of events.entries()) {
      const parsed = exact(ServerEventSchema).safeParse(JSON.parse(JSON.stringify(event)));
      expect(
        parsed.error?.issues ?? [],
        `event #${i} ${JSON.stringify(event).slice(0, 300)}`,
      ).toEqual([]);
    }
    const seen = new Set(events.map((event) => event.type));
    for (const type of SERVER_EVENT_TYPES.filter((t) => t !== "error" && !NOT_MOCKED_YET.has(t))) {
      expect(seen, `a ${type} event`).toContain(type);
    }
  });

  it("answers errors with the daemon's error bodies", async () => {
    const { client } = create();
    const cases: Array<[() => Promise<unknown>, number, WireSchemaName]> = [
      [() => client.readNote("missing.md"), 404, "ApiErrorBody"],
      [() => client.readNote(".obsidian/app.md"), 400, "ApiErrorBody"],
      [() => client.writeNote(".daily-do-list/x.md", { content: "x" }), 400, "ApiErrorBody"],
      [() => client.getDailyNote("2026-13-01"), 400, "ApiErrorBody"],
      [() => client.getDailyNote("2020-01-01", false), 404, "ApiErrorBody"],
      [() => client.renamePath("Ideas.md", "Welcome.md"), 409, "ApiErrorBody"],
      [() => client.deleteFolder("Nope"), 404, "ApiErrorBody"],
      [() => client.getThread("thr_missing"), 404, "ApiErrorBody"],
      [() => client.updateSettings({ agent: { cursorModel: " " } }), 400, "ApiErrorBody"],
      [
        () => client.writeNote("Ideas.md", { content: "x", baseVersion: "stale" }),
        409,
        "ConflictResponse",
      ],
      [
        () => client.writeNote("Ideas.md", { content: "x", baseVersion: null }),
        409,
        "ConflictResponse",
      ],
    ];
    for (const [run, status, schema] of cases) {
      const error = await failure(run());
      expect(error.status).toBe(status);
      expectWire(schema, error.body, `${status} body`);
    }
    expect((await failure(client.getThread("thr_missing"))).message).toBe("Thread not found");
  });

  it("keeps routines like the daemon: runs, notifications, the budget and its errors", async () => {
    const { client, events } = create();
    const request = {
      name: "Price check",
      schedule: "every 2 hours",
      instructions: "Check the kettle's price.",
      notify: "when_changed" as const,
    };
    const { routine } = await call(client.createRoutine(request));
    expect(routine).toMatchObject({
      path: "Routines/Price check.md",
      scheduleText: expect.any(String),
      paused: false,
      runCount: 0,
      extraRunsLeft: 5,
    });
    expect(routine.nextRunAt).toBeGreaterThan(Date.now());

    const first = await call(client.runRoutine(routine.id));
    expect(first.routine.lastRun).toMatchObject({ threadId: first.threadId, trigger: "manual" });
    const busy = await failure(client.runRoutine(routine.id));
    expect(busy.status).toBe(409);
    expect(busy.message).toBe("“Price check” is running right now.");
    expectWire("ApiErrorBody", busy.body);
    await vi.advanceTimersByTimeAsync(3_000);
    const done = (await call(client.getRoutine(routine.id))).routine;
    expect(done.lastRun).toMatchObject({ status: "done", changed: true, summary: "3 updates" });
    const thread = (await call(client.getThread(first.threadId))).thread;
    expect(thread).toMatchObject({ routineId: routine.id, notePath: routine.path });
    // The first run found something new; the second didn't, so "when changed" stays quiet.
    await call(client.runRoutine(routine.id));
    await vi.advanceTimersByTimeAsync(3_000);
    const notifications = ofType(events, "routine.notification");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.notification).toMatchObject({
      routineId: routine.id,
      title: "Price check",
      threadId: first.threadId,
      status: "done",
    });
    const runs = await call(client.listThreads({ routineId: routine.id }));
    expect(runs.threads.map((t) => t.routineId)).toEqual([routine.id, routine.id]);
    expect(ofType(events, "routines.changed").at(-1)!.routines[0]).toMatchObject({
      runCount: 2,
      extraRunsLeft: 3,
    });

    for (let i = 0; i < 3; i++) {
      await call(client.runRoutine(routine.id));
      await vi.advanceTimersByTimeAsync(3_000);
    }
    const spent = await failure(client.runRoutine(routine.id));
    expect(spent.status).toBe(409);
    expect(spent.message).toContain("already ran the most extra times allowed today");

    // Files written through the routes are the agent's writes, not the client's.
    expect(
      ofType(events, "vault.changed").find((e) => e.changes[0]?.path === routine.path),
    ).toEqual({
      type: "vault.changed",
      changes: [{ path: routine.path, kind: "created", version: expect.any(String) }],
      origin: "agent",
    });

    const paused = (await call(client.pauseRoutine(routine.id))).routine;
    expect(paused).toMatchObject({ paused: true });
    expect(paused.nextRunAt).toBeUndefined();
    expect((await call(client.readNote(routine.path))).content).toContain("paused: true");
    expect((await call(client.resumeRoutine(routine.id))).routine.paused).toBe(false);

    await call(client.setAgentEnabled(false));
    const off = await failure(client.runRoutine(routine.id));
    expect(off.status).toBe(503);
    expect(off.body).toMatchObject({ error: "agent_unavailable" });

    const cases: Array<[() => Promise<unknown>, number]> = [
      [() => client.createRoutine(request), 409],
      [() => client.createRoutine({ ...request, name: "Bad", schedule: "whenever" }), 400],
      [() => client.createRoutine({ ...request, name: "a/b" }), 400],
      [() => client.createRoutine({ ...request, name: "Empty", instructions: " " }), 400],
      [() => client.getRoutine("rtn_missing"), 404],
      [() => client.runRoutine("rtn_missing"), 404],
      [() => client.pauseRoutine("rtn_missing"), 404],
    ];
    for (const [run, status] of cases) {
      const error = await failure(run());
      expect(error.status).toBe(status);
      expectWire("ApiErrorBody", error.body, `${status} body`);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("reports a routine whose file has a problem, and refuses to run it", async () => {
    const { client, events } = create();
    await vi.advanceTimersByTimeAsync(1);
    await call(
      client.writeNote("Routines/Broken.md", {
        content: "---\nschedule: whenever I feel like it\n---\nDo things.",
        baseVersion: null,
      }),
    );
    const broken = ofType(events, "routines.changed").at(-1)!.routines[0]!;
    expect(broken.error).toBeTruthy();
    expect(broken.scheduleText).toBeUndefined();
    expect(broken.nextRunAt).toBeUndefined();
    const error = await failure(client.runRoutine(broken.id));
    expect(error.status).toBe(409);
    expect(error.message).toContain("“Broken” can't run");
  });

  it("refuses to decide an approval twice, with the daemon's 409 body", async () => {
    const { client, events } = create();
    await writeToday(client, ["- [ ] Order a new kettle"]);
    await vi.advanceTimersByTimeAsync(3_000);
    const approval = ofType(events, "approval.upsert").at(-1)!.approval;
    await call(client.decideApproval(approval.id, { decision: "deny" }));
    const error = await failure(client.decideApproval(approval.id, { decision: "approve" }));
    expect(error.status).toBe(409);
    expectWire("ApprovalConflictResponse", error.body);
    expect(error.body).toMatchObject({ approval: { id: approval.id, status: "denied" } });
  });

  it("simulates computer access: missing, then granted a moment after System Settings opens", async () => {
    const client = new MockDaemonClient({
      speed: 10,
      installHooks: false,
      persistSettings: false,
      computer: "missing",
    });
    const events: ServerEvent[] = [];
    client.onEvent((event) => events.push(event));
    client.connect();
    const before = await call(client.getAgentStatus());
    expectWire("AgentStatusResponse", before);
    expect(before.execution.computerAccess).toMatchObject({
      accessibility: false,
      screenRecording: false,
      hostApp: { name: "Daily Do List" },
    });
    await call(client.openComputerPermissions("accessibility"));
    await vi.advanceTimersByTimeAsync(1_300);
    const pushed = ofType(events, "agent.status").at(-1)!.status;
    expectWire("AgentStatusResponse", pushed);
    expect(pushed.execution.computerAccess).toMatchObject({
      accessibility: true,
      screenRecording: false,
    });

    const none = new MockDaemonClient({
      installHooks: false,
      persistSettings: false,
      computer: "none",
    });
    expect((await call(none.getAgentStatus())).execution.computerAccess).toBeUndefined();
    const error = await failure(none.openComputerPermissions("screenRecording"));
    expect(error.status).toBe(404);
    expectWire("ApiErrorBody", error.body);
  });
});
