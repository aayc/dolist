import { WIRE_LIMITS } from "@ddl/contract/wire";
import {
  type AgentHarnessKind,
  type ServerEvent,
  type ServerEventOf,
  today,
  toISODate,
} from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../errors";
import { MockDaemonClient } from "./mock-client";

function create() {
  const client = new MockDaemonClient({ speed: 10, installHooks: false, persistSettings: false });
  const events: ServerEvent[] = [];
  client.onEvent((event) => events.push(event));
  client.connect();
  return { client, events };
}

/** REST calls resolve on a timer (like a network round trip). */
async function call<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1);
  return promise;
}

function ofType<T extends ServerEvent["type"]>(events: ServerEvent[], type: T): ServerEventOf<T>[] {
  return events.filter((e): e is ServerEventOf<T> => e.type === type);
}

async function writeTodayTask(client: MockDaemonClient, text: string) {
  const note = await call(client.getDailyNote(toISODate(today())));
  await call(client.writeNote(note.path, { content: `- [ ] ${text}`, baseVersion: note.version }));
  return note.path;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MockDaemonClient vault", () => {
  it("seeds a synthetic vault with today's note from the template", async () => {
    const { client } = create();
    const tree = await call(client.getTree());
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain("Templates/Daily.md");
    expect(paths).toContain("Ideas.md");
    expect(paths).toContain("Projects");
    const daily = await call(client.getDailyNote(toISODate(today())));
    expect(daily.content).toBe("- [ ] ");
    expect(daily.created).toBe(false);
  });

  it("creates missing daily notes from the template", async () => {
    const { client, events } = create();
    const future = new Date();
    future.setDate(future.getDate() + 3);
    const note = await call(client.getDailyNote(toISODate(today(future))));
    expect(note.created).toBe(true);
    expect(note.content).toBe("- [ ] ");
    await vi.advanceTimersByTimeAsync(1);
    const change = ofType(events, "vault.changed").at(-1);
    expect(change?.clientId).toBe(client.clientId);
    expect(change?.changes[0]).toMatchObject({ path: note.path, kind: "created" });
  });

  it("enforces optimistic concurrency", async () => {
    const { client } = create();
    const note = await call(client.readNote("Ideas.md"));
    await call(client.writeNote("Ideas.md", { content: "v2", baseVersion: note.version }));
    const stale = expect(
      client.writeNote("Ideas.md", { content: "v3", baseVersion: note.version }),
    ).rejects.toBeInstanceOf(ConflictError);
    const duplicate = expect(
      client.writeNote("Ideas.md", { content: "new", baseVersion: null }),
    ).rejects.toBeInstanceOf(ConflictError);
    await vi.advanceTimersByTimeAsync(1);
    await stale;
    await duplicate;
  });

  it("searches note contents", async () => {
    const { client } = create();
    const { hits } = await call(client.search("cedar"));
    expect(hits[0]).toMatchObject({ path: "Projects/Garden Redesign.md" });
  });
});

describe("MockDaemonClient settings", () => {
  it("switches the harness, trims model ids and reports the harness's model", async () => {
    const { client, events } = create();
    const { settings } = await call(
      client.updateSettings({ agent: { harness: "cursor", cursorModel: "  gpt-5.5  " } }),
    );
    expect(settings.agent).toMatchObject({
      harness: "cursor",
      cursorModel: "gpt-5.5",
      model: "mock/scripted-agent",
    });
    expect((await call(client.getAgentStatus())).model).toBe("gpt-5.5");
    await vi.advanceTimersByTimeAsync(1);
    expect(ofType(events, "settings.changed").at(-1)?.settings.agent.harness).toBe("cursor");

    await call(client.updateSettings({ agent: { harness: "pi" } }));
    expect((await call(client.getAgentStatus())).model).toBe("mock/scripted-agent");
    expect((await call(client.getSettings())).settings.agent.cursorModel).toBe("gpt-5.5");
  });

  it("rejects what the daemon rejects, changing nothing", async () => {
    const { client } = create();
    const before = await call(client.getSettings());
    for (const patch of [
      { agent: { cursorModel: "   " } },
      { agent: { model: "m".repeat(WIRE_LIMITS.modelIdLength + 1) } },
      { agent: { harness: "claude" as AgentHarnessKind } },
    ]) {
      const rejected = client.updateSettings(patch).then(
        () => expect.unreachable(JSON.stringify(patch)),
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(await rejected).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await call(client.getSettings())).toEqual(before);
    const longest = "m".repeat(WIRE_LIMITS.modelIdLength);
    const { settings } = await call(client.updateSettings({ agent: { cursorModel: longest } }));
    expect(settings.agent.cursorModel).toBe(longest);
  });
});

describe("MockDaemonClient agent simulation", () => {
  it("runs a risky task through triage, streaming, approval and completion", async () => {
    const { client, events } = create();
    const path = await writeTodayTask(client, "Order a new kettle");

    await vi.advanceTimersByTimeAsync(119);
    expect(ofType(events, "task.record")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(ofType(events, "task.record")[0]?.record).toMatchObject({
      status: "triaging",
      notePath: path,
    });

    await vi.advanceTimersByTimeAsync(2000);
    const statuses = ofType(events, "task.record").map((e) => e.record.status);
    expect(statuses).toContain("working");
    expect(statuses.at(-1)).toBe("waiting_approval");
    expect(ofType(events, "thread.delta").length).toBeGreaterThan(5);
    const approval = ofType(events, "approval.upsert").at(-1)?.approval;
    expect(approval).toMatchObject({ status: "pending", risk: "high", toolName: "browser_click" });
    expect(approval?.categories).toContain("payment");

    const { thread } = await call(client.getThread(approval!.threadId!));
    expect(thread.messages.some((m) => m.kind === "approval")).toBe(true);
    expect(thread.messages.some((m) => m.kind === "tool_call" && m.status === "ok")).toBe(true);
    const streamed = thread.messages.find((m) => m.kind === "text");
    expect(streamed?.kind === "text" && streamed.streaming).toBe(false);

    await call(client.decideApproval(approval!.id, { decision: "approve", scope: "once" }));
    await vi.advanceTimersByTimeAsync(2000);
    const final = ofType(events, "task.record").at(-1)?.record;
    expect(final).toMatchObject({ status: "done", summary: "Ordered · arrives in 2 days" });
    const records = await call(client.getTaskRecords(path));
    expect(records.records).toHaveLength(1);
  });

  it("denied approvals block the tool call and finish with the note", async () => {
    const { client, events } = create();
    await writeTodayTask(client, "Email the landlord about the heater");
    await vi.advanceTimersByTimeAsync(3000);
    const approval = ofType(events, "approval.upsert").at(-1)!.approval;
    expect(approval.categories).toContain("communication");
    await call(client.decideApproval(approval.id, { decision: "deny", note: "I'll call instead" }));
    await vi.advanceTimersByTimeAsync(2000);
    const { thread } = await call(client.getThread(approval.threadId!));
    const blocked = thread.messages.find((m) => m.kind === "tool_call" && m.status === "blocked");
    expect(blocked).toBeDefined();
    const last = thread.messages.filter((m) => m.kind === "text").at(-1);
    expect(last?.kind === "text" && last.text).toContain("I'll call instead");
    expect(ofType(events, "task.record").at(-1)?.record.status).toBe("done");
  });

  it("research tasks produce an artifact and browser frames while subscribed", async () => {
    const { client, events } = create();
    await writeTodayTask(client, "Compare three robot vacuums");
    await vi.advanceTimersByTimeAsync(300);
    const threadId = ofType(events, "thread.upsert").at(-1)!.thread.id;
    client.send({ type: "surface.subscribe", threadId, surface: "browser" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(ofType(events, "surface.frame").length).toBeGreaterThan(0);
    const { thread } = await call(client.getThread(threadId));
    expect(thread.surfaces).toContain("browser");
    const artifact = thread.artifacts[0]!;
    const content = await (async () => {
      const promise = client.getArtifact(threadId, artifact.id);
      await vi.advanceTimersByTimeAsync(1);
      return promise;
    })();
    expect(content.mimeType).toBe("text/markdown");
    expect(await content.blob.text()).toContain("| Option |");
    expect(ofType(events, "task.record").at(-1)?.record).toMatchObject({
      status: "done",
      summary: "3 options",
    });
  });

  it("does not act on blank tasks, non-daily notes or while disabled", async () => {
    const { client, events } = create();
    const note = await call(client.readNote("Ideas.md"));
    await call(
      client.writeNote("Ideas.md", { content: "- [ ] Buy a lamp", baseVersion: note.version }),
    );
    await writeTodayTask(client, "");
    await vi.advanceTimersByTimeAsync(2000);
    expect(ofType(events, "task.record")).toHaveLength(0);

    await call(client.setAgentEnabled(false));
    await writeTodayTask(client, "Find a plumber");
    await vi.advanceTimersByTimeAsync(2000);
    expect(ofType(events, "task.record")).toHaveLength(0);
  });

  it("waits while the user is still typing on the task's line", async () => {
    const { client, events } = create();
    const path = await writeTodayTask(client, "Plan a picnic");
    for (let i = 0; i < 5; i++) {
      client.send({ type: "editor.activity", notePath: path, line: 0 });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ofType(events, "task.record")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(ofType(events, "task.record").length).toBeGreaterThan(0);
  });

  it("cancel stops a running task and marks it cancelled", async () => {
    const { client, events } = create();
    await writeTodayTask(client, "Research standing desks");
    await vi.advanceTimersByTimeAsync(250);
    const threadId = ofType(events, "thread.upsert").at(-1)!.thread.id;
    await call(client.cancelThread(threadId));
    await vi.advanceTimersByTimeAsync(2000);
    expect(ofType(events, "task.record").at(-1)?.record.status).toBe("cancelled");
    const { thread } = await call(client.getThread(threadId));
    expect(thread.status).toBe("cancelled");
  });
});
