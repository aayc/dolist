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
import { HttpError, NetworkError } from "../errors";
import { MockDaemonClient } from "./mock-client";
import { MockPairing } from "./mock-pairing";

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
 * events here.
 */
const NOT_MOCKED_YET = new Set<string>();

/** Imports the mock's Obsidian vault to the end, switches to it, and updates it from Obsidian. */
async function importAndSwitch(client: MockDaemonClient) {
  expectWire("SyncStatusResponse", await call(client.getSyncStatus()));
  expectWire("DeviceVaultResponse", await call(client.getVault()));
  expectWire("ObsidianImportStatusResponse", await call(client.getObsidianImport()));
  expectWire("ObsidianImportPreview", await call(client.previewObsidianImport("~/Plain notes")));
  const preview = await call(client.previewObsidianImport("~/Obsidian Notebook"));
  expectWire("ObsidianImportPreview", preview);
  const cancelled = await call(client.startObsidianImport({ source: preview.source }));
  expectWire("ObsidianImportJobResponse", cancelled);
  await vi.advanceTimersByTimeAsync(1_000);
  expectWire("ObsidianImportJobResponse", await call(client.cancelObsidianImport()));
  expectWire(
    "ObsidianImportJobResponse",
    await call(
      client.startObsidianImport({ source: preview.source, destination: "~/Obsidian import" }),
    ),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  const { job } = await call(client.getObsidianImport());
  expectWire("ObsidianImportStatusResponse", { job });
  expect(job).toMatchObject({ state: "done", destination: "/Users/me/Obsidian import" });
  const switched = await call(client.switchVault(job!.destination));
  expectWire("DeviceVaultResponse", switched);
  await vi.advanceTimersByTimeAsync(2_000);
  const status = await call(client.getObsidianImport());
  expectWire("ObsidianImportStatusResponse", status);
  expect(status.imported).toMatchObject({ source: preview.source });
  expectWire("ObsidianImportJobResponse", await call(client.updateFromObsidian()));
  await vi.advanceTimersByTimeAsync(2_000);
  expectWire("ObsidianImportStatusResponse", await call(client.getObsidianImport()));
}

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
      "Find a plumber for Saturday",
      "Is the pharmacy open on Sunday?",
      "TODO: water the ferns",
    ]);
    await checkQueries(client, path);
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
    await importAndSwitch(client);
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

  it("keeps this device's settings, sync, pairing and the machine like the daemon", async () => {
    const { client, events } = create();
    await vi.advanceTimersByTimeAsync(1);
    const status = await call(client.getAgentStatus());
    expectWire("AgentStatusResponse", status);
    expect(status.placement).toMatchObject({
      placement: "this_device",
      heldHere: "no_sync",
      relay: "off",
      runsOn: { thisDevice: true },
    });
    expect(status.readiness).toMatchObject({ modelCredential: true, computer: "available" });

    const device = await call(client.getDevice());
    expectWire("DeviceSettingsResponse", device);
    expect(device).toMatchObject({ remoteHosts: [], sync: { url: null, hasToken: false } });
    expectWire("SyncStatusResponse", await call(client.getSyncStatus()));

    const synced = await call(
      client.setupSync({
        url: "https://sync.example.com",
        vault: "vault_1",
        token: "t0ken-t0ken",
      }),
    );
    expectWire("DeviceSettingsResponse", synced);
    expect(synced.sync).toEqual({
      url: "https://sync.example.com",
      vault: "vault_1",
      hasToken: true,
    });
    const syncStatus = await call(client.getSyncStatus());
    expectWire("SyncStatusResponse", syncStatus);
    expect(syncStatus).toMatchObject({
      state: "idle",
      target: "remote",
      remoteHost: "sync.example.com",
    });
    expect((await call(client.getAgentStatus())).placement?.heldHere).toBe("no_machine");

    const machine = await call(
      client.pairMachine({ url: "HTTPS://VM-2.tailnet-name.ts.net/", code: "abcd-efgh" }),
    );
    expectWire("MachineStatusResponse", machine);
    expect(machine).toMatchObject({
      machine: { name: "vm-2", url: "https://vm-2.tailnet-name.ts.net" },
      paired: true,
      reachable: true,
      readiness: { computer: "unsupported" },
    });
    expect(ofType(events, "settings.changed").at(-1)?.settings.remote.alwaysOnMachine).toEqual(
      machine.machine,
    );
    expectWire("MachineStatusResponse", await call(client.checkMachine()));
    expect((await call(client.getAgentStatus())).placement?.heldHere).toBeUndefined();

    // Handing the agent to the machine shows a note, then the machine runs it, relayed here.
    expectWire(
      "DeviceSettingsResponse",
      await call(client.updateDevice({ placement: "always_on_machine" })),
    );
    await vi.advanceTimersByTimeAsync(1);
    const handing = ofType(events, "agent.status").at(-1)?.status;
    expect(handing?.placement).toMatchObject({
      placement: "always_on_machine",
      note: "Handing the agent to vm-2…",
      relay: "connecting",
    });
    // Requests are already forwarded while the relay connects.
    expect(handing?.problem).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    const relayed = ofType(events, "agent.status").at(-1)!.status;
    expect(relayed.placement).toMatchObject({
      relay: "connected",
      runsOn: { name: "vm-2", thisDevice: false, alwaysOnMachine: true },
    });
    expect(relayed.placement?.note).toBeUndefined();
    expect(relayed.problem).toBeUndefined();

    // The machine revokes this device: not paired, and it says so.
    client.testHooks().setMachineRejects(true);
    await vi.advanceTimersByTimeAsync(1);
    const rejected = ofType(events, "agent.status").at(-1)!.status;
    expect(rejected.placement?.relay).toBe("not_paired");
    expect(rejected.problem).toBe(
      "The always-on machine no longer accepts this device. Pair it again.",
    );
    const machineNow = await call(client.getMachine());
    expectWire("MachineStatusResponse", machineNow);
    expect(machineNow).toMatchObject({ paired: true, reachable: true });
    expect(machineNow.error).toContain("no longer accepts this device's credential");
    client.testHooks().setMachineRejects(false);
    await vi.advanceTimersByTimeAsync(1);

    // Once it can't be reached, agent actions answer 503 with why, and the status says so too.
    client.testHooks().setMachineReachable(false);
    await vi.advanceTimersByTimeAsync(1);
    const down = ofType(events, "agent.status").at(-1)!.status;
    expectWire("AgentStatusResponse", down);
    expect(down.placement?.relay).toBe("unreachable");
    expect(down.problem).toBe("The always-on machine can't be reached.");
    const refused = await failure(client.postMessage("orchestrator", "hi"));
    expect(refused.status).toBe(503);
    expectWire("ApiErrorBody", refused.body);
    expect(refused.body).toMatchObject({ error: "agent_unavailable" });

    // Taking it back: a note while the machine hands it over, then it runs here.
    await call(client.updateDevice({ placement: "this_device" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(ofType(events, "agent.status").at(-1)?.status.placement?.note).toBe(
      "Taking over from vm-2…",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "agent.status").at(-1)?.status.placement).toMatchObject({
      relay: "off",
      runsOn: { thisDevice: true },
    });

    const hosts = await call(
      client.updateDevice({ remoteHosts: [" Laptop.Tailnet-Name.ts.net "] }),
    );
    expect(hosts.remoteHosts).toEqual(["laptop.tailnet-name.ts.net"]);
    const code = await call(client.createPairingCode({ name: "Phone" }));
    expectWire("PairingCodeResponse", code);
    expect(code.url).toBe("https://laptop.tailnet-name.ts.net");
    const devices = await call(client.listDevices());
    expectWire("PairedDevicesResponse", devices);
    const [first] = devices.devices;
    await call(client.revokeDevice(first!.id));
    expect((await call(client.listDevices())).devices).toHaveLength(devices.devices.length - 1);

    expectWire("MachineStatusResponse", await call(client.forgetMachine()));
    expectWire("DeviceSettingsResponse", await call(client.removeSync()));
    expect((await call(client.getAgentStatus())).placement?.heldHere).toBe("no_sync");
    client.disconnect();
    for (const event of events) {
      expect(exact(ServerEventSchema).safeParse(JSON.parse(JSON.stringify(event))).error).toBe(
        undefined,
      );
    }
  });

  it("answers the device routes' errors with the daemon's codes and bodies", async () => {
    const { client } = create();
    const cases: Array<[() => Promise<unknown>, number, string]> = [
      [() => client.updateDevice({ remoteHosts: ["https://vm.example"] }), 400, "invalid_request"],
      [() => client.updateDevice({ remoteHosts: ["100.64.0.1"] }), 400, "invalid_request"],
      [
        () => client.updateDevice({ remoteHosts: ["a.example", "A.example"] }),
        400,
        "invalid_request",
      ],
      [() => client.updateDevice({ name: " " }), 400, "invalid_request"],
      [
        () => client.setupSync({ url: "http://sync.example.com", vault: "v" }),
        400,
        "invalid_request",
      ],
      [
        () => client.setupSync({ url: "https://sync.example.com", vault: "v" }),
        400,
        "invalid_request",
      ],
      [
        () => client.setupSync({ url: "https://sync.example.com", vault: "a b", token: "t" }),
        400,
        "invalid_request",
      ],
      [() => client.revokeDevice(".."), 400, "invalid_request"],
      [() => client.revokeDevice("pdv_missing"), 404, "not_found"],
      [
        () => client.pairMachine({ url: "https://vm.example/path", code: "ABCDEFGH" }),
        400,
        "invalid_request",
      ],
      [
        () => client.pairMachine({ url: "https://vm.example", code: "XXXX-XXXX" }),
        401,
        "pairing_rejected",
      ],
      [
        () => client.pairMachine({ url: "https://vm.example", code: "YYYYYYYY" }),
        429,
        "rate_limited",
      ],
      [
        () => client.pairMachine({ url: "https://offline.example", code: "ABCDEFGH" }),
        502,
        "machine_unreachable",
      ],
    ];
    for (const [run, status, code] of cases) {
      const error = await failure(run());
      expect([error.status, (error.body as { error: string }).error]).toEqual([status, code]);
      expectWire("ApiErrorBody", error.body, `${status} body`);
    }
    for (let i = 0; i < 3; i++) await call(client.createPairingCode());
    const tooMany = await failure(client.createPairingCode());
    expect(tooMany.status).toBe(429);
    expectWire("ApiErrorBody", tooMany.body);

    const locked = new MockDaemonClient({
      installHooks: false,
      persistSettings: false,
      remote: "locked",
    });
    for (const run of [
      () => locked.updateDevice({ placement: "always_on_machine" }),
      () => locked.updateDevice({ remoteHosts: [] }),
      () => locked.setupSync({ url: "https://sync.example.com", vault: "v", token: "t" }),
      () => locked.removeSync(),
    ]) {
      const error = await failure(run());
      expect(error.status).toBe(409);
      expect(error.body).toMatchObject({ error: "locked_by_env" });
      expectWire("ApiErrorBody", error.body);
    }
    expect((await call(locked.updateDevice({ name: "Renamed" }))).device.name).toBe("Renamed");
  });

  it("serves the scenarios' placements, and 503s agent actions while another device runs it", async () => {
    for (const [scenario, expected] of [
      ["relayed", { relay: "connected", runsOn: { alwaysOnMachine: true, thisDevice: false } }],
      ["not_paired", { relay: "not_paired" }],
      ["rejected", { relay: "not_paired" }],
      ["unreachable", { relay: "unreachable" }],
      ["elsewhere", { relay: "off", runsOn: { name: "Work laptop", thisDevice: false } }],
      [
        "host",
        { placement: "always_on_host", runsOn: { thisDevice: true, alwaysOnMachine: true } },
      ],
    ] as const) {
      const client = new MockDaemonClient({
        installHooks: false,
        persistSettings: false,
        remote: scenario,
      });
      const status = await call(client.getAgentStatus());
      expectWire("AgentStatusResponse", status, scenario);
      expect(status.placement, scenario).toMatchObject(expected);
      expectWire("MachineStatusResponse", await call(client.getMachine()), scenario);
      const refusal = {
        elsewhere: "The agent is running on Work laptop.",
        not_paired: "This device isn't paired with the always-on machine.",
        rejected: "The always-on machine no longer accepts this device. Pair it again.",
        unreachable: "The always-on machine can't be reached.",
      }[scenario as string];
      if (refusal) {
        expect(status.problem, scenario).toBe(refusal);
        const error = await failure(client.retryThread("orchestrator"));
        expect(error.message, scenario).toBe(refusal);
      }
    }
  });

  it("answers 401 once this browser's device is revoked, and says so once", async () => {
    const setup = new MockDaemonClient({ installHooks: false, persistSettings: false });
    const { code } = await call(setup.createPairingCode());
    expect(code).toHaveLength(8);
    const onUnauthorized = vi.fn();
    const pairing = new MockPairing({ persist: false });
    const issued = pairing.issue();
    const { device } = pairing.pair({
      code: issued.code,
      name: "Chrome on macOS",
      kind: "browser",
    });
    expect(() => pairing.pair({ code: issued.code, name: "Again", kind: "browser" })).toThrow(
      "Wrong, expired or already used pairing code",
    );
    const client = new MockDaemonClient({
      installHooks: false,
      persistSettings: false,
      pairing,
      deviceId: device.id,
      onUnauthorized,
    });
    const { devices } = await call(client.listDevices());
    expect(devices.find((d) => d.current)?.id).toBe(device.id);
    await call(client.revokeDevice(device.id));
    await vi.advanceTimersByTimeAsync(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const error = await failure(client.getDevice());
    expect(error.status).toBe(401);
    expectWire("ApiErrorBody", error.body);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
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

describe("MockDaemonClient: importing from Obsidian and switching vaults", () => {
  function hooked(options: { importStepMs?: number } = {}) {
    const client = new MockDaemonClient({
      installHooks: false,
      persistSettings: false,
      ...options,
    });
    const events: ServerEvent[] = [];
    const states: Array<[string, boolean]> = [];
    client.onEvent((event) => events.push(event));
    client.onConnectionChange(({ state, reconnected }) => states.push([state, reconnected]));
    client.connect();
    return { client, events, states };
  }

  it("runs an import through its phases with progress events, one job at a time", async () => {
    const { client, events } = hooked();
    const source = "/Users/me/Obsidian Notebook";
    const preview = await call(client.previewObsidianImport(`${source}/`));
    expect(preview).toMatchObject({
      source,
      defaultDestination: "/Users/me/Obsidian Notebook (Daily Do List)",
      isObsidianVault: true,
      carryOver: { vault: "/Users/me/Demo Vault", dailyNotesFrom: "obsidian" },
    });
    expect(preview.carryOver.daily.merged).toBe(1);
    expect(preview.carryOver.collisions.items).toContainEqual({
      from: "Ideas.md",
      to: "Ideas (Daily Do List).md",
    });
    const { job } = await call(client.startObsidianImport({ source }));
    expect(job).toMatchObject({ state: "running", phase: "checking" });
    const busy = await failure(client.startObsidianImport({ source }));
    expect([busy.status, busy.body]).toMatchObject([409, { error: "conflict" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    const phases = ofType(events, "import.progress").map((e) => e.job.phase);
    expect([...new Set(phases)]).toEqual(["checking", "copying", "carrying_over", "finishing"]);
    const done = ofType(events, "import.progress").at(-1)!.job;
    expect(done).toMatchObject({ state: "done", result: { copied: { files: 64 } } });
    const again = await failure(
      client.startObsidianImport({ source, destination: done.destination }),
    );
    expect(again.message).toBe(`${done.destination} isn't empty`);
    expect((await call(client.previewObsidianImport(source))).defaultDestination).toBe(
      "/Users/me/Obsidian Notebook (Daily Do List 2)",
    );
  });

  it("cancels a running job, and says when nothing runs", async () => {
    const { client } = hooked();
    const idle = await failure(client.cancelObsidianImport());
    expect(idle.status).toBe(404);
    expectWire("ApiErrorBody", idle.body);
    await call(client.startObsidianImport({ source: "~/Obsidian Notebook" }));
    await vi.advanceTimersByTimeAsync(1_000);
    const { job } = await call(client.cancelObsidianImport());
    expect(job.state).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call(client.getObsidianImport())).job?.state).toBe("cancelled");
  });

  it("switches by restarting: nothing answers until the daemon is back on the new vault", async () => {
    const { client, states } = hooked({ importStepMs: 10 });
    await call(client.startObsidianImport({ source: "~/Obsidian Notebook" }));
    await vi.advanceTimersByTimeAsync(1_000);
    const { job } = await call(client.getObsidianImport());
    const switched = await call(client.switchVault(job!.destination));
    expect(switched).toEqual({ path: job!.destination, lockedByEnv: false, restart: "supervisor" });
    const away = client.health().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(await away).toBeInstanceOf(NetworkError);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(states.slice(-2)).toEqual([
      ["reconnecting", false],
      ["online", true],
    ]);
    expect((await call(client.health())).vaultName).toBe("Obsidian Notebook (Daily Do List)");
    expect(await call(client.getObsidianImport())).toEqual({
      job: null,
      imported: {
        source: "/Users/me/Obsidian Notebook",
        importedAt: job!.startedAt,
        previousVault: "/Users/me/Demo Vault",
      },
    });
    expect(await call(client.switchVault(job!.destination))).toEqual({
      path: job!.destination,
      lockedByEnv: false,
    });
  });

  it("updates an imported vault, and only an imported one", async () => {
    const { client, events } = hooked({ importStepMs: 10 });
    const never = await failure(client.updateFromObsidian());
    expect([never.status, never.message]).toEqual([
      404,
      "This vault wasn't imported from Obsidian",
    ]);
    await call(client.startObsidianImport({ source: "~/Obsidian Notebook" }));
    await vi.advanceTimersByTimeAsync(1_000);
    const { job } = await call(client.getObsidianImport());
    await call(client.switchVault(job!.destination));
    await vi.advanceTimersByTimeAsync(2_000);
    const update = (await call(client.updateFromObsidian())).job;
    expect(update).toMatchObject({ kind: "update", destination: job!.destination });
    await vi.advanceTimersByTimeAsync(1_000);
    const done = (await call(client.getObsidianImport())).job!;
    expect(done.update?.added.paths).toEqual(["Journal/Phone notes.md"]);
    expect(
      ofType(events, "vault.changed").some(
        (e) => e.origin === "external" && e.changes[0]?.path === "Journal/Phone notes.md",
      ),
    ).toBe(true);
    expect((await call(client.getObsidianImport())).imported?.updatedAt).toEqual(
      expect.any(Number),
    );
  });

  it("answers the daemon's errors: sources, destinations, paired devices, DDL_VAULT and sync", async () => {
    const client = new MockDaemonClient({ installHooks: false, persistSettings: false });
    client.connect();
    const hooks = client.testHooks();
    const cases: Array<[() => Promise<unknown>, number, string, RegExp]> = [
      [() => client.previewObsidianImport("Notes"), 400, "invalid_request", /absolute path/],
      [() => client.previewObsidianImport("/Users/me/Nope"), 400, "invalid_request", /no folder/],
      [
        () => client.previewObsidianImport("~/.daily-do-list"),
        400,
        "invalid_request",
        /own folder/,
      ],
      [() => client.previewObsidianImport("~/Demo Vault"), 400, "invalid_request", /current/],
      [
        () =>
          client.startObsidianImport({
            source: "~/Obsidian Notebook",
            destination: "~/Obsidian Notebook/New",
          }),
        400,
        "invalid_request",
        /inside the Obsidian vault/,
      ],
      [
        () => client.startObsidianImport({ source: "~/Plain notes", destination: "/nowhere/New" }),
        400,
        "invalid_request",
        /doesn't exist/,
      ],
      [() => client.switchVault("~/Nope"), 400, "invalid_request", /no folder/],
    ];
    hooks.setSyncing(true);
    cases.push([() => client.switchVault("~/Plain notes"), 409, "conflict", /turn sync off/]);
    for (const [run, status, code, message] of cases) {
      const error = await failure(run());
      expect([error.status, (error.body as { error: string }).error]).toEqual([status, code]);
      expect(error.message).toMatch(message);
      expectWire("ApiErrorBody", error.body);
    }
    expect((await call(client.getSyncStatus())).target).toBe("remote");
    expect((await call(client.previewObsidianImport("~/Plain notes"))).warnings).toContainEqual(
      expect.stringMatching(/turn sync off/),
    );
    hooks.setSyncing(false);
    hooks.setVaultLockedByEnv(true);
    expect((await call(client.getVault())).lockedByEnv).toBe(true);
    const locked = await failure(client.switchVault("~/Plain notes"));
    expect([locked.status, locked.body]).toMatchObject([409, { error: "locked_by_env" }]);
    hooks.setPairedDevice(true);
    for (const run of [
      () => client.getVault(),
      () => client.getObsidianImport(),
      () => client.previewObsidianImport("~/Obsidian Notebook"),
      () => client.startObsidianImport({ source: "~/Obsidian Notebook" }),
      () => client.updateFromObsidian(),
    ]) {
      const error = await failure(run());
      expect([error.status, error.body]).toMatchObject([403, { error: "forbidden_device" }]);
      expectWire("ApiErrorBody", error.body);
    }
  });
});
