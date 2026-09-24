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

describe("MockDaemonClient ⇄ wire contract", () => {
  it("runs a full scenario emitting only conformant events and results", async () => {
    const { client, events } = create();
    await vi.advanceTimersByTimeAsync(1);
    expect(events[0]).toMatchObject({ type: "hello" });

    const daily = await call(client.getDailyNote("today"));
    expectWire("DailyNoteResponse", daily);
    expectWire("DailyNoteResponse", await call(client.getDailyNote(daily.date, false)));
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
    for (const type of SERVER_EVENT_TYPES.filter((t) => t !== "error")) {
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
});
