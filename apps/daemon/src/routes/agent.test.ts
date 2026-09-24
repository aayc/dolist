import {
  type AgentStatusResponse,
  API_ROUTES,
  type ApprovalListResponse,
  type ApprovalRequest,
  type AppSettings,
  type SettingsResponse,
  type TaskAgentRecord,
  type ThreadListResponse,
  type ThreadResponse,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import { NullAgentRuntime } from "../null-runtime";
import { createTestApp, FakeAgentRuntime, makeApproval, makeThread } from "../test-helpers";

describe("settings routes", () => {
  it("merges a partial update, persists it and hands it to the runtime", async () => {
    const runtime = new FakeAgentRuntime();
    const { request, settings } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.settings, {
      method: "PUT",
      json: { editor: { vimMode: true }, agent: { settleMs: 1000 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsResponse;
    expect(body.settings.editor.vimMode).toBe(true);
    expect(body.settings.editor.livePreview).toBe(true);
    expect(body.settings.agent.settleMs).toBe(1000);
    expect(settings.get()).toEqual(body.settings);
    const [applied] = runtime.callsTo("updateSettings").at(-1) ?? [];
    expect((applied as AppSettings).agent.settleMs).toBe(1000);

    const get = (await (await request(API_ROUTES.settings)).json()) as SettingsResponse;
    expect(get.settings).toEqual(body.settings);
  });

  it("hands a harness switch to the runtime", async () => {
    const runtime = new FakeAgentRuntime();
    const { request } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.settings, {
      method: "PUT",
      json: { agent: { harness: "cursor", cursorModel: "gpt-5.5" } },
    });
    expect(res.status).toBe(200);
    const [applied] = runtime.callsTo("updateSettings").at(-1) ?? [];
    expect((applied as AppSettings).agent).toMatchObject({
      harness: "cursor",
      cursorModel: "gpt-5.5",
    });
  });

  it("rejects invalid values and unknown keys without applying anything", async () => {
    const runtime = new FakeAgentRuntime();
    const { request } = await createTestApp({ runtime });
    for (const json of [
      { theme: "neon" },
      { editor: { fontSize: 400 } },
      { agent: { nope: true } },
      { agent: { harness: "claude" } },
      { agent: { cursorModel: "" } },
      { dailyNotes: { folder: ".hidden" } },
    ]) {
      const res = await request(API_ROUTES.settings, { method: "PUT", json });
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(runtime.callsTo("updateSettings")).toEqual([]);
  });
});

describe("agent routes", () => {
  it("reports status and persists the enabled switch through settings", async () => {
    const runtime = new FakeAgentRuntime();
    const { request, settings } = await createTestApp({ runtime });
    expect(
      ((await (await request(API_ROUTES.agentStatus)).json()) as AgentStatusResponse).mode,
    ).toBe("mock");
    const res = await request(API_ROUTES.agentEnabled, { method: "PUT", json: { enabled: false } });
    expect(((await res.json()) as AgentStatusResponse).enabled).toBe(false);
    expect(settings.get().agent.enabled).toBe(false);
    expect(runtime.callsTo("updateSettings")).toHaveLength(1);
    expect(runtime.callsTo("setEnabled")).toEqual([]);
  });

  it("returns task records for a normalized note path", async () => {
    const runtime = new FakeAgentRuntime();
    const record: TaskAgentRecord = {
      taskId: "task_1",
      notePath: "Daily/2026-09-23.md",
      date: "2026-09-23",
      text: "Find a dentist",
      line: 0,
      status: "working",
      threadId: "thr_1",
      updatedAt: 1,
      unread: 0,
    };
    runtime.records.set("Daily/2026-09-23.md", [record]);
    const { request } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.tasks("Daily//2026-09-23.md"));
    expect(await res.json()).toEqual({ records: [record] });
    expect((await request("/api/tasks")).status).toBe(400);
    expect((await request(API_ROUTES.tasks(".daily-do-list/x.md"))).status).toBe(400);
  });

  it("lists, filters and fetches threads", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thr_1", makeThread("thr_1"));
    runtime.threads.set("thr_2", makeThread("thr_2", { notePath: "Other.md" }));
    runtime.approvals = [makeApproval("apr_1", { threadId: "thr_1" })];
    const { request } = await createTestApp({ runtime });

    const all = (await (await request(API_ROUTES.threads)).json()) as ThreadListResponse;
    expect(all.threads.map((t) => t.id)).toEqual(["thr_1", "thr_2"]);
    const filtered = (await (
      await request(`${API_ROUTES.threads}?notePath=Other.md`)
    ).json()) as ThreadListResponse;
    expect(filtered.threads.map((t) => t.id)).toEqual(["thr_2"]);

    const one = (await (await request(API_ROUTES.thread("thr_1"))).json()) as ThreadResponse;
    expect(one.thread.id).toBe("thr_1");
    expect(one.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    expect((await request(API_ROUTES.thread("missing"))).status).toBe(404);
    expect((await request("/api/threads/bad%20id")).status).toBe(400);
  });

  it("delegates thread actions and 404s unknown threads", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thr_1", makeThread("thr_1"));
    const { request } = await createTestApp({ runtime });

    const message = await request(API_ROUTES.threadMessages("thr_1"), {
      method: "POST",
      json: { text: "  Prefer mornings  " },
    });
    expect(await message.json()).toEqual({ ok: true });
    expect(runtime.callsTo("postUserMessage")).toEqual([["thr_1", "Prefer mornings"]]);

    expect((await request(API_ROUTES.threadCancel("thr_1"), { method: "POST" })).status).toBe(200);
    expect((await request(API_ROUTES.threadRetry("thr_1"), { method: "POST" })).status).toBe(200);
    expect(runtime.callsTo("cancelThread")).toEqual([["thr_1"]]);
    expect(runtime.callsTo("retryThread")).toEqual([["thr_1"]]);

    expect((await request(API_ROUTES.threadCancel("nope"), { method: "POST" })).status).toBe(404);
    const empty = await request(API_ROUTES.threadMessages("thr_1"), {
      method: "POST",
      json: { text: "   " },
    });
    expect(empty.status).toBe(400);
  });

  it("maps runtime refusals to 503 and unexpected failures to 500", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thr_1", makeThread("thr_1"));
    const { request } = await createTestApp({ runtime });

    const unavailable = new Error("OPENROUTER_API_KEY is not set");
    unavailable.name = "AgentUnavailableError";
    runtime.actionError = unavailable;
    const refused = await request(API_ROUTES.threadRetry("thr_1"), { method: "POST" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "agent_unavailable",
      message: "OPENROUTER_API_KEY is not set",
    });

    runtime.actionError = new Error("boom");
    const failed = await request(API_ROUTES.threadRetry("thr_1"), { method: "POST" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "agent_error", message: "boom" });
  });
});

describe("approval routes", () => {
  it("lists approvals with an optional status filter", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1"), makeApproval("apr_2", { status: "denied" })];
    const { request } = await createTestApp({ runtime });
    const all = (await (await request(API_ROUTES.approvals)).json()) as ApprovalListResponse;
    expect(all.approvals).toHaveLength(2);
    const pending = (await (
      await request(`${API_ROUTES.approvals}?status=pending`)
    ).json()) as ApprovalListResponse;
    expect(pending.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    expect((await request(`${API_ROUTES.approvals}?status=weird`)).status).toBe(400);
  });

  it("decides a pending approval via the runtime", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1")];
    const { request } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.approval("apr_1"), {
      method: "POST",
      json: { decision: "approve", scope: "task", note: "ok" },
    });
    expect(res.status).toBe(200);
    const { approval } = (await res.json()) as { approval: ApprovalRequest };
    expect(approval).toMatchObject({ id: "apr_1", status: "approved", scope: "task" });
    expect(runtime.callsTo("decideApproval")).toEqual([
      ["apr_1", { decision: "approve", scope: "task", note: "ok" }],
    ]);
  });

  it("returns 404 for unknown and 409 for already-decided approvals", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1", { status: "approved" })];
    const { request } = await createTestApp({ runtime });

    const unknown = await request(API_ROUTES.approval("apr_x"), {
      method: "POST",
      json: { decision: "deny" },
    });
    expect(unknown.status).toBe(404);

    const decided = await request(API_ROUTES.approval("apr_1"), {
      method: "POST",
      json: { decision: "deny" },
    });
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({
      error: "conflict",
      approval: { id: "apr_1", status: "approved" },
    });
    expect(runtime.callsTo("decideApproval")).toEqual([]);

    const invalid = await request(API_ROUTES.approval("apr_1"), {
      method: "POST",
      json: { decision: "maybe" },
    });
    expect(invalid.status).toBe(400);
  });

  it("reports 409 when the approval was decided while the request was in flight", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1")];
    runtime.decideApproval = async () => {
      runtime.approvals = [makeApproval("apr_1", { status: "expired" })];
      throw new Error("Approval apr_1 is no longer pending");
    };
    const { request } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.approval("apr_1"), {
      method: "POST",
      json: { decision: "approve" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ approval: { status: "expired" } });
  });
});

describe("artifact route", () => {
  const meta = (id: string, mimeType: string, title = "Report") => ({
    id,
    threadId: "thr_1",
    title,
    kind: "file" as const,
    mimeType,
    path: `.daily-do-list/artifacts/thr_1/${id}.bin`,
    size: 3,
    createdAt: 1,
  });

  it("serves bytes with the artifact's type, sandboxed and nosniff", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.artifacts.set("thr_1/art_md", {
      meta: { ...meta("art_md", "text/markdown", "Flights"), path: "x/art_md.md" },
      body: new TextEncoder().encode("# Flights"),
    });
    const { request } = await createTestApp({ runtime });
    const res = await request(API_ROUTES.artifact("thr_1", "art_md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"Flights.md\"; filename*=UTF-8''Flights.md",
    );
    expect(await res.text()).toBe("# Flights");
  });

  it("forces active content to download and sanitizes the declared type", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.artifacts.set("thr_1/art_html", {
      meta: meta("art_html", "text/html; charset=utf-8", 'Quote "draft" – v2'),
      body: new TextEncoder().encode("<script>alert(1)</script>"),
    });
    runtime.artifacts.set("thr_1/art_bad", {
      meta: meta("art_bad", "text/html\r\nX-Evil: 1"),
      body: new Uint8Array([1, 2, 3]),
    });
    const { request } = await createTestApp({ runtime });

    const html = await request(API_ROUTES.artifact("thr_1", "art_html"));
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Quote _draft_ _ v2\.bin"; filename\*=UTF-8''Quote%20%22draft%22%20%E2%80%93%20v2\.bin$/,
    );
    expect(html.headers.get("content-security-policy")).toContain("sandbox");

    const bad = await request(API_ROUTES.artifact("thr_1", "art_bad"));
    expect(bad.headers.get("content-type")).toBe("application/octet-stream");
    expect(bad.headers.get("x-evil")).toBeNull();

    const download = await request(`${API_ROUTES.artifact("thr_1", "art_bad")}?download=1`);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect((await request(API_ROUTES.artifact("thr_1", "missing"))).status).toBe(404);
  });
});

describe("with the null runtime", () => {
  it("serves empty agent data and explains why agents are unavailable", async () => {
    const runtime = new NullAgentRuntime({ problem: "The agent runtime failed to load" });
    const { request } = await createTestApp({ runtime });
    const status = (await (await request(API_ROUTES.agentStatus)).json()) as AgentStatusResponse;
    expect(status).toMatchObject({ mode: "off", problem: "The agent runtime failed to load" });
    expect(await (await request(API_ROUTES.threads)).json()).toEqual({ threads: [] });
    expect(await (await request(API_ROUTES.approvals)).json()).toEqual({ approvals: [] });
    expect(await (await request(API_ROUTES.connectors)).json()).toEqual({ connectors: [] });
    expect((await request(API_ROUTES.thread("thr_1"))).status).toBe(404);
    expect((await request(API_ROUTES.artifact("thr_1", "a"))).status).toBe(404);
    const toggled = await request(API_ROUTES.agentEnabled, {
      method: "POST",
      json: { enabled: false },
    });
    expect(((await toggled.json()) as AgentStatusResponse).enabled).toBe(false);
  });

  it("reports the model of the configured harness", async () => {
    const runtime = new NullAgentRuntime({ model: "vendor/model-a" });
    const { request } = await createTestApp({ runtime });
    const status = async () =>
      ((await (await request(API_ROUTES.agentStatus)).json()) as AgentStatusResponse).model;
    expect(await status()).toBe("vendor/model-a");
    const put = (agent: Record<string, string>) =>
      request(API_ROUTES.settings, { method: "PUT", json: { agent } });
    await put({ harness: "cursor", cursorModel: "gpt-5.5" });
    expect(await status()).toBe("gpt-5.5");
    await put({ harness: "pi", model: "vendor/model-b" });
    expect(await status()).toBe("vendor/model-b");
  });
});
