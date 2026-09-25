/**
 * Daemon ⇄ contract conformance: every operation of `API_CONTRACT` is exercised through the real
 * app, every declared status is reached, and every answer parses (strictly) with the schema the
 * contract declares for that status.
 */
import { API_CONTRACT, listOperations } from "@ddl/contract";
import {
  type ApiRouteName,
  type AppSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  silentLogger,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it, vi } from "vitest";
import {
  type ContractClient,
  contractClient,
  type Observed,
  operationKey,
  routePath,
} from "./contract-test-helpers";
import { memoryDeviceSettings } from "./device-settings";
import { createRemoteHosts } from "./remote-hosts";
import type { SettingsStore } from "./settings-store";
import {
  createTestApp,
  FakeAgentRuntime,
  FakeSystemSettings,
  makeApproval,
  makeThread,
  type TestAppOptions,
} from "./test-helpers";

const TOO_BIG = JSON.stringify({ content: "x".repeat(5 * 1024 * 1024 + 16) });

interface Env {
  api: ContractClient;
  storage: MemoryStorageProvider;
  runtime: FakeAgentRuntime;
}

async function setup(observed: Observed, options: TestAppOptions = {}): Promise<Env> {
  const runtime = (options.runtime as FakeAgentRuntime | undefined) ?? new FakeAgentRuntime();
  const app = await createTestApp({ ...options, runtime });
  return { api: contractClient(app, observed), storage: app.storage, runtime };
}

function unavailable(message = "OPENROUTER_API_KEY is not set"): Error {
  const error = new Error(message);
  error.name = "AgentUnavailableError";
  return error;
}

/** Runs a thread action whose runtime work outlives the 3 s grace period. */
async function slowAction(
  api: ContractClient,
  runtime: FakeAgentRuntime,
  run: () => Promise<unknown>,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    runtime.actionDelayMs = 60_000;
    const pending = run();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
  } finally {
    runtime.actionDelayMs = 0;
    vi.useRealTimers();
  }
  void api;
}

async function threadAction(
  observed: Observed,
  name: "threadCancel" | "threadRetry" | "threadMessages",
) {
  const runtime = new FakeAgentRuntime();
  runtime.threads.set("thr_1", makeThread("thr_1"));
  const { api } = await setup(observed, { runtime });
  const body = name === "threadMessages" ? { json: { text: "  Prefer mornings  " } } : {};
  const call = (id = "thr_1", init = {}) =>
    api.call(name, "POST", { params: { id }, ...body, ...init });
  expect((await call()).status).toBe(200);
  await slowAction(api, runtime, async () => expect((await call()).status).toBe(202));
  expect((await call("bad id")).status).toBe(400);
  expect((await call("thr_missing")).status).toBe(404);
  runtime.actionError = new Error("boom");
  expect((await call()).body).toEqual({ error: "agent_error", message: "boom" });
  runtime.actionError = unavailable();
  expect((await call()).status).toBe(503);
  runtime.actionError = undefined;
  if (name === "threadMessages") {
    expect((await call("thr_1", { json: { text: "   " } })).status).toBe(400);
    expect((await call("thr_1", { json: undefined, body: "{" })).status).toBe(400);
    expect((await call("thr_1", { json: undefined, body: TOO_BIG })).status).toBe(413);
  }
}

function hiddenDailyFolderSettings(): SettingsStore {
  const settings: AppSettings = mergeSettings(DEFAULT_SETTINGS, {
    dailyNotes: { folder: ".hidden" },
  });
  return {
    get: () => settings,
    update: async () => settings,
    reload: async () => null,
    onChange: () => () => {},
  };
}

type Scenario = (observed: Observed) => Promise<void>;

const scenarios: Record<string, Scenario> = {
  "GET health": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("health", "GET")).body).toMatchObject({ ok: true, agentMode: "mock" });
  },

  "GET tree": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("Daily/2026-09-23.md", "- [ ] a");
    await storage.write(".daily-do-list/state/x.json", "{}");
    await storage.createFolder("Empty");
    const { body } = await api.call("tree", "GET");
    expect(
      (body as { entries: Array<{ path: string }> }).entries.map((e) => e.path).sort(),
    ).toEqual(["Daily", "Daily/2026-09-23.md", "Empty"]);
  },

  "GET note": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("Daily/Sept notes #1.md", "- [ ] Café ☕");
    expect(
      (await api.call("note", "GET", { params: { path: "Daily/Sept notes #1.md" } })).status,
    ).toBe(200);
    expect((await api.call("note", "GET", { params: { path: ".obsidian/app.md" } })).status).toBe(
      400,
    );
    expect((await api.call("note", "GET", { params: { path: "photo.png" } })).status).toBe(400);
    expect((await api.call("note", "GET", { params: { path: "missing.md" } })).status).toBe(404);
    // `/api/notes` itself is the note route with an empty path.
    expect((await api.call("note", "GET", { params: { path: "" } })).body).toMatchObject({
      error: "invalid_path",
    });
  },

  "PUT note": async (observed) => {
    const { api } = await setup(observed);
    const put = (path: string, init: Parameters<ContractClient["call"]>[2] = {}) =>
      api.call("note", "PUT", { params: { path }, ...init });
    const created = await put("New.md", { json: { content: "a", baseVersion: null } });
    expect(created.status).toBe(201);
    expect((await put("New.md", { json: { content: "b" } })).status).toBe(200);
    expect((await put("New.md", { json: { content: "c", baseVersion: "stale" } })).status).toBe(
      409,
    );
    expect((await put("New.md", { json: { content: "c", baseVersion: null } })).status).toBe(409);
    expect((await put("New.md", { body: "{nope" })).body).toMatchObject({ error: "invalid_json" });
    expect((await put("New.md", { json: { content: "x", sneaky: 1 } })).body).toMatchObject({
      error: "invalid_request",
    });
    expect((await put(".hidden/x.md", { json: { content: "x" } })).body).toMatchObject({
      error: "invalid_path",
    });
    expect((await put("Big.md", { body: TOO_BIG })).status).toBe(413);
  },

  "DELETE note": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("Old.md", "bye");
    expect((await api.call("note", "DELETE", { params: { path: "Old.md" } })).body).toEqual({
      ok: true,
      trashedTo: ".trash/Old.md",
    });
    expect((await api.call("note", "DELETE", { params: { path: "a.png" } })).status).toBe(400);
    expect((await api.call("note", "DELETE", { params: { path: "Old.md" } })).status).toBe(404);
  },

  "POST rename": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("a.md", "a");
    await storage.write("taken.md", "t");
    await storage.write("Folder/x.md", "x");
    await storage.write("Other/y.md", "y");
    const rename = (json: unknown, init = {}) => api.call("rename", "POST", { json, ...init });
    expect((await rename({ from: "a.md", to: "b.md" })).body).toMatchObject({ path: "b.md" });
    expect((await rename({ from: "Folder", to: "Moved" })).body).toEqual({
      path: "Moved",
      moved: 1,
    });
    expect((await rename(undefined, { body: "{" })).status).toBe(400);
    expect((await rename({ from: "b.md", to: "b.md" })).body).toMatchObject({
      error: "invalid_request",
    });
    expect((await rename({ from: "b.md", to: ".hidden.md" })).body).toMatchObject({
      error: "invalid_path",
    });
    expect((await rename({ from: "nope.md", to: "c.md" })).status).toBe(404);
    const noteConflict = await rename({ from: "b.md", to: "taken.md" });
    expect(noteConflict.body).toMatchObject({ error: "conflict", current: { path: "taken.md" } });
    // Regression: renaming onto an existing folder used to merge the two folders.
    expect((await rename({ from: "Moved", to: "Other" })).body).toMatchObject({
      error: "conflict",
    });
    expect(await storage.read("Moved/x.md")).not.toBeNull();
    expect((await rename(undefined, { body: TOO_BIG })).status).toBe(413);
  },

  "POST folders": async (observed) => {
    const { api } = await setup(observed);
    const create = (json: unknown, init = {}) => api.call("folders", "POST", { json, ...init });
    expect((await create({ path: "Projects//New/" })).body).toEqual({ path: "Projects/New" });
    expect((await create(undefined, { body: "[" })).status).toBe(400);
    expect((await create({ path: ".hidden" })).body).toMatchObject({ error: "invalid_path" });
    expect((await create(undefined, { body: TOO_BIG })).status).toBe(413);
  },

  "DELETE folders": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("Projects/Kyoto/plan.md", "x");
    await storage.createFolder("Empty");
    const remove = (query?: Record<string, string>) => api.call("folders", "DELETE", { query });
    expect((await remove({ path: "Projects/Kyoto" })).body).toEqual({
      ok: true,
      trashedTo: ".trash/Projects/Kyoto",
    });
    // Regression: an empty folder used to report `trashedTo: ""`.
    expect((await remove({ path: "Empty" })).body).toEqual({ ok: true, trashedTo: ".trash/Empty" });
    expect((await remove()).body).toMatchObject({ error: "invalid_request" });
    expect((await remove({ path: ".daily-do-list" })).body).toMatchObject({
      error: "invalid_path",
    });
    expect((await remove({ path: "Nope" })).status).toBe(404);
  },

  "GET daily": async (observed) => {
    const now = () => new Date(2026, 8, 23, 10);
    const { api, storage } = await setup(observed, { now });
    await storage.write("Daily/2026-09-23.md", "- [ ] today");
    const daily = (date: string, query?: Record<string, string>) =>
      api.call("daily", "GET", { params: { date }, query });
    expect((await daily("today")).body).toMatchObject({ date: "2026-09-23", created: false });
    expect((await daily("2024-02-29", { create: "1" })).body).toMatchObject({
      path: "Daily/2024-02-29.md",
      created: true,
    });
    expect((await daily("2026-09-24")).status).toBe(404);
    expect((await daily("2026-13-01")).status).toBe(400);
    expect((await daily("2023-02-29")).status).toBe(400);
    const hidden = await setup(observed, { settings: hiddenDailyFolderSettings() });
    expect(
      (await hidden.api.call("daily", "GET", { params: { date: "today" } })).body,
    ).toMatchObject({
      error: "invalid_settings",
    });
  },

  "GET search": async (observed) => {
    const { api, storage } = await setup(observed);
    await storage.write("Dentist.md", "- [ ] Book the dentist");
    const search = (query: Record<string, string>) => api.call("search", "GET", { query });
    expect(
      ((await search({ q: "dentist" })).body as { hits: unknown[] }).hits.length,
    ).toBeGreaterThan(0);
    expect((await search({ q: "   " })).body).toEqual({ hits: [] });
    expect((await search({ q: "dentist", limit: "100000" })).status).toBe(200);
    expect((await search({ q: "x".repeat(501) })).status).toBe(400);
    expect((await search({ q: "x", limit: "0" })).status).toBe(400);
    expect((await search({ q: "x", limit: "1.5" })).status).toBe(400);
  },

  "GET settings": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("settings", "GET")).body).toEqual({ settings: DEFAULT_SETTINGS });
  },

  "PUT settings": (observed) => settingsPatch(observed, "PUT"),
  "PATCH settings": (observed) => settingsPatch(observed, "PATCH"),

  "GET agentStatus": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("agentStatus", "GET")).status).toBe(200);
  },

  "PUT agentEnabled": (observed) => agentEnabled(observed, "PUT"),
  "POST agentEnabled": (observed) => agentEnabled(observed, "POST"),

  "GET tasks": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.records.set("Daily/2026-09-23.md", [
      {
        taskId: "tsk_1",
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
        text: "Find a dentist",
        line: 0,
        status: "working",
        threadId: "thr_1",
        updatedAt: 1,
        unread: 0,
      },
    ]);
    const { api } = await setup(observed, { runtime });
    const tasks = (query?: Record<string, string>) => api.call("tasks", "GET", { query });
    expect((await tasks({ notePath: "Daily//2026-09-23.md" })).body).toMatchObject({
      records: [{ taskId: "tsk_1" }],
    });
    expect((await tasks()).body).toMatchObject({ error: "invalid_request" });
    expect((await tasks({ notePath: ".daily-do-list/x.md" })).body).toMatchObject({
      error: "invalid_path",
    });
  },

  "GET threads": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thr_1", makeThread("thr_1"));
    const { api } = await setup(observed, { runtime });
    const threads = (query?: Record<string, string>) => api.call("threads", "GET", { query });
    expect((await threads()).body).toMatchObject({ threads: [{ id: "thr_1" }] });
    expect((await threads({ notePath: "", taskId: "" })).status).toBe(200);
    expect((await threads({ notePath: ".hidden/x.md" })).body).toMatchObject({
      error: "invalid_path",
    });
    expect((await threads({ taskId: "t".repeat(201) })).body).toMatchObject({
      error: "invalid_request",
    });
  },

  "GET thread": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.threads.set("thr_1", makeThread("thr_1"));
    runtime.approvals = [makeApproval("apr_1", { threadId: "thr_1" })];
    const { api } = await setup(observed, { runtime });
    const get = (id: string) => api.call("thread", "GET", { params: { id } });
    expect((await get("thr_1")).body).toMatchObject({
      thread: { id: "thr_1" },
      approvals: [{ id: "apr_1" }],
    });
    expect((await get("bad id")).status).toBe(400);
    expect((await get("thr_missing")).status).toBe(404);
  },

  "POST threadMessages": (observed) => threadAction(observed, "threadMessages"),
  "POST threadCancel": (observed) => threadAction(observed, "threadCancel"),
  "POST threadRetry": (observed) => threadAction(observed, "threadRetry"),

  "GET approvals": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1"), makeApproval("apr_2", { status: "denied" })];
    const { api } = await setup(observed, { runtime });
    const list = (query?: Record<string, string>) => api.call("approvals", "GET", { query });
    expect(((await list()).body as { approvals: unknown[] }).approvals).toHaveLength(2);
    expect((await list({ status: "pending" })).body).toMatchObject({
      approvals: [{ id: "apr_1" }],
    });
    expect((await list({ status: "weird" })).status).toBe(400);
  },

  "GET approval": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1")];
    const { api } = await setup(observed, { runtime });
    const get = (id: string) => api.call("approval", "GET", { params: { id } });
    expect((await get("apr_1")).body).toMatchObject({ approval: { id: "apr_1" } });
    expect((await get("apr/1")).status).toBe(400);
    expect((await get("apr_missing")).status).toBe(404);
  },

  "POST approval": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.approvals = [makeApproval("apr_1"), makeApproval("apr_2"), makeApproval("apr_3")];
    const { api } = await setup(observed, { runtime });
    const decide = (id: string, json: unknown, init = {}) =>
      api.call("approval", "POST", { params: { id }, json, ...init });
    expect((await decide("apr_1", { decision: "approve", scope: "task" })).body).toMatchObject({
      approval: { id: "apr_1", status: "approved", scope: "task" },
    });
    expect((await decide("apr_1", { decision: "deny" })).body).toMatchObject({
      error: "conflict",
      approval: { status: "approved" },
    });
    expect((await decide("apr_2", { decision: "maybe" })).status).toBe(400);
    expect((await decide("apr_2", undefined, { body: "{" })).status).toBe(400);
    expect((await decide("apr_missing", { decision: "deny" })).status).toBe(404);
    expect((await decide("apr_2", undefined, { body: TOO_BIG })).status).toBe(413);
    const decideApproval = runtime.decideApproval.bind(runtime);
    runtime.decideApproval = async () => {
      throw new Error("store offline");
    };
    expect((await decide("apr_2", { decision: "approve" })).body).toEqual({
      error: "agent_error",
      message: "store offline",
    });
    runtime.decideApproval = async () => {
      throw unavailable("The approval system failed to start");
    };
    expect((await decide("apr_3", { decision: "approve" })).status).toBe(503);
    runtime.decideApproval = decideApproval;
  },

  "GET artifact": async (observed) => {
    const runtime = new FakeAgentRuntime();
    runtime.artifacts.set("thr_1/art_1", {
      meta: {
        id: "art_1",
        threadId: "thr_1",
        title: "Report",
        kind: "markdown",
        mimeType: "text/markdown",
        path: ".daily-do-list/artifacts/thr_1/art_1.md",
        size: 3,
        createdAt: 1,
      },
      body: new TextEncoder().encode("# R"),
    });
    const { api } = await setup(observed, { runtime });
    const get = (threadId: string, artifactId: string) =>
      api.call("artifact", "GET", { params: { threadId, artifactId } });
    const ok = await get("thr_1", "art_1");
    expect(ok.status).toBe(200);
    expect(new TextDecoder().decode(ok.body as ArrayBuffer)).toBe("# R");
    expect((await get("thr_1", "art 1")).status).toBe(400);
    expect((await get("thr_1", "art_missing")).status).toBe(404);
  },

  "GET connectors": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("connectors", "GET")).body).toEqual({ connectors: [] });
  },

  "GET syncStatus": async (observed) => {
    const off = await setup(observed);
    expect((await off.api.call("syncStatus", "GET")).body).toEqual({
      state: "disabled",
      target: "none",
      lastSyncedAt: null,
      pendingChanges: 0,
      conflicts: [],
    });
    const remote = await setup(observed, {
      syncStatus: () => ({
        state: "error",
        target: "remote",
        lastSyncedAt: 1_790_213_400_000,
        pendingChanges: 2,
        conflicts: ["Daily/2026-09-24 (conflict 2026-09-24 0915).md"],
        lastError: "Could not reach the sync server at sync.example.com: timed out",
        remoteHost: "sync.example.com",
        deviceName: "Laptop",
      }),
    });
    expect((await remote.api.call("syncStatus", "GET")).body).toMatchObject({
      target: "remote",
      remoteHost: "sync.example.com",
      deviceName: "Laptop",
    });
  },

  "GET device": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("device", "GET")).body).toEqual({
      device: { id: "dev_this_device", name: "This device" },
      placement: "this_device",
      remoteHosts: [],
      sync: { url: null, vault: null, hasToken: false },
      lockedByEnv: [],
    });
    const synced = await setup(observed, {
      device: memoryDeviceSettings({
        placement: "always_on_host",
        sync: { kind: "remote", url: "https://sync.example.com", vault: "v_1" },
        hasToken: true,
        lockedByEnv: ["placement", "sync"],
        remoteHosts: createRemoteHosts(["vm-name.tailnet-name.ts.net"]),
      }),
    });
    expect((await synced.api.call("device", "GET")).body).toEqual({
      device: { id: "dev_this_device", name: "This device" },
      placement: "always_on_host",
      remoteHosts: ["vm-name.tailnet-name.ts.net"],
      sync: { url: "https://sync.example.com", vault: "v_1", hasToken: true },
      lockedByEnv: ["placement", "sync"],
    });
  },

  "PATCH device": async (observed) => {
    const remoteHosts = createRemoteHosts();
    const { api } = await setup(observed, { device: memoryDeviceSettings({ remoteHosts }) });
    const patch = (json: unknown, init = {}) => api.call("device", "PATCH", { json, ...init });
    expect(
      (
        await patch({
          name: "  Work laptop ",
          placement: "always_on_machine",
          remoteHosts: [" VM-Name.Tailnet-Name.ts.net "],
        })
      ).body,
    ).toMatchObject({
      device: { name: "Work laptop" },
      placement: "always_on_machine",
      remoteHosts: ["vm-name.tailnet-name.ts.net"],
    });
    expect(remoteHosts.list()).toEqual(["vm-name.tailnet-name.ts.net"]);
    for (const bad of [
      { name: "" },
      { name: "n".repeat(65) },
      { placement: "somewhere" },
      { remoteHosts: ["100.64.0.1"] },
      { remoteHosts: ["https://vm-name.tailnet-name.ts.net"] },
      { remoteHosts: ["a.example", "a.example"] },
      { remoteHosts: Array.from({ length: 9 }, (_, i) => `h${i}.example`) },
      { sync: { url: "https://sync.example.com" } },
    ]) {
      expect((await patch(bad)).body).toMatchObject({ error: "invalid_request" });
    }
    expect((await patch(undefined, { body: "{" })).body).toMatchObject({ error: "invalid_json" });
    expect((await patch(undefined, { body: TOO_BIG })).status).toBe(413);

    const locked = await setup(observed, {
      device: memoryDeviceSettings({ lockedByEnv: ["placement", "remoteHosts"] }),
    });
    const lockedPatch = (json: unknown) => locked.api.call("device", "PATCH", { json });
    expect((await lockedPatch({ placement: "always_on_host" })).body).toMatchObject({
      error: "locked_by_env",
    });
    expect((await lockedPatch({ remoteHosts: [] })).status).toBe(409);
    expect((await lockedPatch({ name: "Renamed" })).body).toMatchObject({
      device: { name: "Renamed" },
      placement: "this_device",
    });
  },

  "PUT deviceSync": async (observed) => {
    const applied: unknown[] = [];
    const device = memoryDeviceSettings({ applySync: async (sync) => void applied.push(sync) });
    const { api } = await setup(observed, { device });
    const put = (json: unknown, init = {}) => api.call("deviceSync", "PUT", { json, ...init });
    const token = "t".repeat(43);
    const saved = await put({ url: "https://sync.example.com", vault: "v_1", token: ` ${token} ` });
    expect(saved.body).toMatchObject({
      sync: { url: "https://sync.example.com", vault: "v_1", hasToken: true },
    });
    expect(JSON.stringify(saved.body)).not.toContain(token);
    expect(applied).toEqual([{ kind: "remote", url: "https://sync.example.com", vault: "v_1" }]);
    expect((await put({ url: "http://127.0.0.1:7332", vault: "v_2" })).body).toMatchObject({
      sync: { url: "http://127.0.0.1:7332", vault: "v_2", hasToken: true },
    });
    for (const bad of [
      { url: "http://sync.example.com", vault: "v_1" },
      { url: "https://user:pw@sync.example.com", vault: "v_1" },
      { url: "https://sync.example.com", vault: "not a vault" },
      { url: "https://sync.example.com", vault: "v_1", token: "two words" },
      { url: "https://sync.example.com", vault: "v_1", extra: true },
    ]) {
      expect((await put(bad)).body).toMatchObject({ error: "invalid_request" });
    }
    const fresh = await setup(observed);
    expect(
      (
        await fresh.api.call("deviceSync", "PUT", {
          json: { url: "https://s.example", vault: "v" },
        })
      ).body,
    ).toMatchObject({ error: "invalid_request", message: expect.stringMatching(/token/) });
    expect((await put(undefined, { body: "{" })).body).toMatchObject({ error: "invalid_json" });
    expect((await put(undefined, { body: TOO_BIG })).status).toBe(413);
    const locked = await setup(observed, {
      device: memoryDeviceSettings({ lockedByEnv: ["sync"] }),
    });
    expect(
      (
        await locked.api.call("deviceSync", "PUT", {
          json: { url: "https://sync.example.com", vault: "v_1", token },
        })
      ).body,
    ).toMatchObject({ error: "locked_by_env" });
    expect(applied).toHaveLength(2);
  },

  "DELETE deviceSync": async (observed) => {
    const applied: unknown[] = [];
    const device = memoryDeviceSettings({
      sync: { kind: "remote", url: "https://sync.example.com", vault: "v_1" },
      hasToken: true,
      applySync: async (sync) => void applied.push(sync),
    });
    const { api } = await setup(observed, { device });
    expect((await api.call("deviceSync", "DELETE")).body).toMatchObject({
      sync: { url: null, vault: null, hasToken: false },
    });
    expect(applied).toEqual([{ kind: "none" }]);
    const locked = await setup(observed, {
      device: memoryDeviceSettings({ lockedByEnv: ["sync"] }),
    });
    expect((await locked.api.call("deviceSync", "DELETE")).body).toMatchObject({
      error: "locked_by_env",
    });
  },

  "GET ws": async (observed) => {
    const { api } = await setup(observed);
    expect((await api.call("ws", "GET")).status).toBe(426);
    expect((await api.call("ws", "GET", { host: "evil.example:7331" })).status).toBe(403);
  },

  "POST computerPermissionsOpen": async (observed) => {
    const systemSettings = new FakeSystemSettings();
    const { api } = await setup(observed, { systemSettings });
    const open = (json: unknown, init = {}) =>
      api.call("computerPermissionsOpen", "POST", { json, ...init });
    expect((await open({ pane: "accessibility" })).body).toEqual({ ok: true });
    expect((await open({ pane: "screenRecording" })).status).toBe(200);
    expect(systemSettings.opened).toEqual(["accessibility", "screenRecording"]);
    expect((await open({ pane: "fullDiskAccess" })).body).toMatchObject({
      error: "invalid_request",
    });
    expect((await open({ pane: "accessibility", url: "file:///etc/passwd" })).status).toBe(400);
    expect((await open(undefined, { body: "{" })).body).toMatchObject({ error: "invalid_json" });
    expect((await open(undefined, { body: TOO_BIG })).status).toBe(413);
    systemSettings.outcome = "unsupported";
    expect((await open({ pane: "accessibility" })).body).toMatchObject({ error: "not_found" });
    systemSettings.outcome = new Error("open failed");
    expect((await open({ pane: "accessibility" })).body).toEqual({
      error: "internal_error",
      message: "System Settings didn't open",
    });
    expect(systemSettings.opened).toHaveLength(2);
  },
};

async function settingsPatch(observed: Observed, method: "PUT" | "PATCH") {
  const { api } = await setup(observed);
  const patch = (json: unknown, init = {}) => api.call("settings", method, { json, ...init });
  expect(
    (await patch({ editor: { vimMode: true }, agent: { model: "  mock  " } })).body,
  ).toMatchObject({
    settings: { editor: { vimMode: true }, agent: { model: "mock" } },
  });
  expect(
    (await patch({ agent: { harness: "cursor", cursorModel: " gpt-5.5[reasoning=high] " } })).body,
  ).toMatchObject({
    settings: {
      agent: { harness: "cursor", model: "mock", cursorModel: "gpt-5.5[reasoning=high]" },
    },
  });
  expect((await patch({ agent: { harness: "claude" } })).body).toMatchObject({
    error: "invalid_request",
  });
  expect((await patch({ agent: { cursorModel: "  " } })).body).toMatchObject({
    error: "invalid_request",
  });
  const machine = { name: "vm-name", url: "https://vm-name.tailnet-name.ts.net" };
  expect(
    (await patch({ remote: { alwaysOnMachine: { ...machine, name: " vm-name " } } })).body,
  ).toMatchObject({ settings: { remote: { alwaysOnMachine: machine } } });
  for (const url of [
    "http://vm-name.tailnet-name.ts.net",
    "https://vm-name.tailnet-name.ts.net/app",
    "https://vm-name.tailnet-name.ts.net?x=1",
    "https://user:secret@vm-name.tailnet-name.ts.net",
  ]) {
    expect((await patch({ remote: { alwaysOnMachine: { ...machine, url } } })).body).toMatchObject({
      error: "invalid_request",
    });
  }
  expect(
    (await patch({ remote: { alwaysOnMachine: { ...machine, name: "n".repeat(65) } } })).body,
  ).toMatchObject({ error: "invalid_request" });
  expect((await patch({ remote: { alwaysOnMachine: null } })).body).toMatchObject({
    settings: { remote: { alwaysOnMachine: null } },
  });
  expect((await patch({ theme: "neon" })).body).toMatchObject({ error: "invalid_request" });
  expect((await patch({ dailyNotes: { folder: ".hidden" } })).body).toMatchObject({
    error: "invalid_request",
  });
  expect((await patch(undefined, { body: "nope" })).body).toMatchObject({ error: "invalid_json" });
  expect((await patch(undefined, { body: TOO_BIG })).status).toBe(413);
}

async function agentEnabled(observed: Observed, method: "PUT" | "POST") {
  const { api } = await setup(observed);
  expect((await api.call("agentEnabled", method, { json: { enabled: false } })).body).toMatchObject(
    {
      enabled: false,
    },
  );
  expect((await api.call("agentEnabled", method, { json: { enabled: "no" } })).status).toBe(400);
  expect((await api.call("agentEnabled", method, { body: TOO_BIG })).status).toBe(413);
}

/**
 * Operations the contract declares that the daemon doesn't serve yet: they answer 404 like any
 * unknown route. Remote access and pairing (S1) and device settings with the machine link (S2)
 * replace each entry with a scenario.
 */
const NOT_SERVED_YET = new Set([
  "POST pairingCodes",
  "POST pair",
  "GET devices",
  "DELETE pairedDevice",
  "GET machine",
  "POST machinePair",
  "POST machineCheck",
  "DELETE machinePairing",
]);

const operations = listOperations();
const served = operations.filter((op) => !NOT_SERVED_YET.has(operationKey(op.name, op.method)));

describe("every contract operation", () => {
  it("has a scenario (and nothing stale)", () => {
    expect(Object.keys(scenarios).sort()).toEqual(
      served.map(({ name, method }) => operationKey(name, method)).sort(),
    );
    const keys = new Set(operations.map(({ name, method }) => operationKey(name, method)));
    for (const key of NOT_SERVED_YET) expect(keys.has(key), key).toBe(true);
  });

  it.each([...NOT_SERVED_YET])("%s is not served yet (404)", async (key) => {
    const op = operations.find(({ name, method }) => operationKey(name, method) === key)!;
    const app = await createTestApp();
    const res = await app.request(routePath(op.name, { id: "x" }), { method: op.method });
    expect(res.status).toBe(404);
  });

  it.each(served.map((op) => [operationKey(op.name, op.method), op] as const))(
    "%s reaches every declared status and answers each as declared",
    async (key, { operation }) => {
      const observed: Observed = new Map();
      await scenarios[key]!(observed);
      const declared = Object.keys(operation.responses).map(Number).sort();
      expect([...(observed.get(key) ?? [])].sort()).toEqual(declared);
    },
  );
});

describe("common errors", () => {
  it.each(operations.map((op) => [operationKey(op.name, op.method), op] as const))(
    "%s refuses foreign hosts, origins and missing tokens as declared",
    async (_key, { name, method, route }) => {
      const observed: Observed = new Map();
      const { api } = await setup(observed);
      const params = { path: "a.md", id: "x", date: "today", threadId: "t", artifactId: "a" };
      const host = await api.call(name, method, { params, host: "evil.example:7331" });
      expect(host.body).toMatchObject({ error: "forbidden_host" });
      if (route.auth !== "bearer") return;
      const token = await api.call(name, method, { params, token: null });
      expect(token.status).toBe(401);
      const origin = await api.call(name, method, { params, origin: "http://evil.example" });
      expect(origin.body).toMatchObject({ error: "forbidden_origin" });
    },
  );

  it("answers unexpected failures with 500 internal_error", async () => {
    const observed: Observed = new Map();
    const storage = new MemoryStorageProvider();
    storage.list = async () => {
      throw new Error("disk on fire");
    };
    const runtime = new FakeAgentRuntime();
    runtime.status = () => {
      throw new Error("status exploded");
    };
    const { api } = await setup(observed, { storage, runtime, logger: silentLogger });
    expect((await api.call("tree", "GET")).body).toEqual({
      error: "internal_error",
      message: "Internal server error",
    });
    expect((await api.call("agentStatus", "GET")).status).toBe(500);
  });
});

describe("settings edge cases", () => {
  it("serves conformant settings when the Obsidian import is out of range", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write(
      ".obsidian/daily-notes.json",
      JSON.stringify({
        folder: "f".repeat(600),
        format: "Y".repeat(200),
        template: "t".repeat(600),
      }),
    );
    await storage.write(".obsidian/app.json", JSON.stringify({ vimMode: true }));
    const { api } = await setup(new Map(), { storage });
    const { body } = await api.call("settings", "GET");
    expect(body).toMatchObject({ settings: { editor: { vimMode: true } } });
  });
});

describe("unknown routes", () => {
  it.each([
    ["GET", "/api/nope"],
    ["GET", "/api"],
    ["GET", "/api/threads/a/b/c"],
    ["DELETE", "/api/health"],
    ["POST", "/api/vault/tree"],
    ["PUT", "/api/agent/status"],
  ])("%s %s answers 404 not_found", async (method, path) => {
    const app = await createTestApp();
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: "not_found" });
    expect(Object.keys(body as object).sort()).toEqual(["error", "message"]);
  });

  it("builds every route path the way API_ROUTES does", () => {
    const samples: Partial<Record<ApiRouteName, [Record<string, string>, string]>> = {
      note: [{ path: "Daily/Sept notes #1.md" }, "/api/notes/Daily/Sept%20notes%20%231.md"],
      thread: [{ id: "thr_1" }, "/api/threads/thr_1"],
      artifact: [{ threadId: "t 1", artifactId: "a/b" }, "/api/artifacts/t%201/a%2Fb"],
      daily: [{ date: "2026-09-23" }, "/api/daily/2026-09-23"],
    };
    for (const [name, [params, expected]] of Object.entries(samples)) {
      expect(routePath(name as ApiRouteName, params)).toBe(expected);
    }
    expect(API_CONTRACT.ws.path).toBe("/ws");
  });
});
