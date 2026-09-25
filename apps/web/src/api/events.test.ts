/**
 * Differential tests of the zod-free event guards against the wire contract: every valid event is
 * accepted unchanged, and whatever the guards accept the UI's reducers can process.
 */

import { arb, invalidFor, withExtraKey } from "@ddl/contract/testing";
import { SERVER_EVENT_TYPES, ServerEventSchema } from "@ddl/contract/wire";
import { DEFAULT_SETTINGS, isHiddenPath, mergeSettings, type ServerEvent } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { shownHarness } from "../features/settings/agent-harness";
import { draftToCommit } from "../features/settings/draft";
import { initialAgentState, reduceAgentEvent } from "../state/agent-reducer";
import { parseServerEvent } from "./events";

/** What the UI does with an accepted event, minus the stores (see app/server-events.ts). */
function handleLikeTheUi(event: ServerEvent): void {
  switch (event.type) {
    case "vault.changed":
      for (const change of event.changes) {
        if (isHiddenPath(change.path) || change.path.startsWith(".")) continue;
        void /\.[^/]+$/.test(change.path);
      }
      return;
    case "settings.changed": {
      const { agent } = mergeSettings(DEFAULT_SETTINGS, event.settings);
      void [
        event.settings.editor.vimMode,
        event.settings.agent.watch.pastDays,
        shownHarness(agent),
      ];
      void [draftToCommit(agent.model, "", true), draftToCommit(agent.cursorModel, "", true)];
      return;
    }
    case "surface.frame":
      void `${event.threadId}:${event.surface}`;
      if (event.action) void { ...event.action, ts: event.ts };
      return;
    case "error":
      void event.message.length;
      return;
    case "hello":
      return;
    default: {
      const state = reduceAgentEvent(initialAgentState, event);
      reduceAgentEvent(state, event);
    }
  }
}

const AGENT_STATUS = {
  mode: "live",
  enabled: true,
  model: "m",
  running: 0,
  queued: 0,
  pendingApprovals: 0,
  connectors: [],
  execution: { provider: "local", capabilities: { shell: true, browser: true, computer: false } },
};

const junk = fc.oneof(
  fc.anything({ withNullPrototype: true, maxDepth: 4 }),
  fc
    .record({ type: fc.constantFrom(...SERVER_EVENT_TYPES) }, { noNullPrototype: true })
    .chain((base) =>
      fc
        .dictionary(fc.string(), fc.anything({ maxDepth: 3 }))
        .map((rest) => ({ ...rest, ...base })),
    ),
);

describe("parseServerEvent", () => {
  test.prop([arb.serverEvent()])("accepts every contract-valid event, unchanged", (event) => {
    expect(parseServerEvent(event)).toBe(event);
  });

  test.prop([arb.serverEvent()])("accepts unknown keys (newer daemons add fields)", (event) => {
    const extended = withExtraKey(event, "x_future");
    expect(ServerEventSchema.safeParse(extended).success).toBe(true);
    expect(parseServerEvent(extended)).toBe(extended);
  });

  test.prop([fc.oneof(junk, invalidFor(ServerEventSchema, arb.serverEvent()))])(
    "never throws, and whatever it accepts the UI can handle",
    (raw) => {
      const event = parseServerEvent(raw);
      if (event) expect(() => handleLikeTheUi(event)).not.toThrow();
    },
  );

  test.prop([
    fc.string().filter((type) => !(SERVER_EVENT_TYPES as readonly string[]).includes(type)),
  ])("ignores event types it doesn't know", (type) => {
    expect(parseServerEvent({ type, message: "hi", thread: {}, record: {} })).toBeNull();
  });

  it("ignores prototype keys as event types (regression: __proto__ used to throw)", () => {
    for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(parseServerEvent(JSON.parse(`{"type":"${type}","message":"x"}`)), type).toBeNull();
    }
  });

  it("rejects malformed events the UI would crash on", () => {
    const cases: unknown[] = [
      { type: "vault.changed", changes: [null], origin: "client" },
      { type: "vault.changed", changes: [{ path: 3, kind: "created" }], origin: "client" },
      { type: "task.records", notePath: "a.md", records: [{ taskId: "t" }] },
      { type: "task.record", record: { taskId: "t", notePath: "a.md", status: "zombie" } },
      { type: "thread.upsert", thread: { id: "t", title: "x", status: "done" } },
      { type: "thread.message", threadId: "t", message: { id: "m", kind: "image" } },
      { type: "approval.upsert", approval: { id: "a" } },
      { type: "agent.status", status: { mode: "mock", enabled: true } },
      {
        type: "agent.status",
        status: {
          mode: "live",
          enabled: true,
          model: "m",
          running: 0,
          queued: 0,
          pendingApprovals: 0,
          connectors: [],
          execution: {
            provider: "local",
            capabilities: { shell: true, browser: true, computer: true },
            computerAccess: { accessibility: "yes", screenRecording: false, appControl: true },
          },
        },
      },
      { type: "surface.frame", threadId: "t", surface: "screen", data: "", ts: 1 },
      { type: "settings.changed", settings: { theme: "dark" } },
      {
        type: "settings.changed",
        settings: { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, cursorModel: 5 } },
      },
      {
        type: "settings.changed",
        settings: {
          ...DEFAULT_SETTINGS,
          agent: { ...DEFAULT_SETTINGS.agent, approvalPolicy: true },
        },
      },
      {
        type: "settings.changed",
        settings: { ...DEFAULT_SETTINGS, remote: { alwaysOnMachine: "vm-name" } },
      },
      {
        type: "settings.changed",
        settings: { ...DEFAULT_SETTINGS, remote: { alwaysOnMachine: { name: "vm-name" } } },
      },
      {
        type: "agent.status",
        status: {
          ...AGENT_STATUS,
          placement: { placement: "this_device", runsOn: { deviceId: "d" }, relay: "off" },
        },
      },
      {
        type: "agent.status",
        status: {
          ...AGENT_STATUS,
          placement: { placement: "always_on_machine", heldHere: 1, runsOn: null, relay: "off" },
        },
      },
      {
        type: "agent.status",
        status: {
          ...AGENT_STATUS,
          readiness: {
            harness: { kind: "pi" },
            modelCredential: true,
            browser: true,
            computer: "available",
            connectors: { configured: 0, connected: 0 },
          },
        },
      },
      { type: "error" },
    ];
    for (const raw of cases) {
      expect(ServerEventSchema.safeParse(raw).success).toBe(false);
      expect(parseServerEvent(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("accepts settings from a daemon older than the harness setting", () => {
    const { harness: _harness, cursorModel: _cursorModel, ...older } = DEFAULT_SETTINGS.agent;
    const raw = { type: "settings.changed", settings: { ...DEFAULT_SETTINGS, agent: older } };
    const event = parseServerEvent(raw);
    expect(event).toBe(raw);
    expect(() => handleLikeTheUi(event!)).not.toThrow();
  });

  it("accepts settings and agent status from a daemon older than the always-on machine", () => {
    const { remote: _remote, ...settings } = DEFAULT_SETTINGS;
    for (const raw of [
      { type: "settings.changed", settings },
      { type: "agent.status", status: AGENT_STATUS },
    ]) {
      const event = parseServerEvent(raw);
      expect(event).toBe(raw);
      expect(() => handleLikeTheUi(event!)).not.toThrow();
    }
  });

  it("accepts settings from a daemon older than the approval policy", () => {
    const { approvalPolicy: _policy, ...older } = DEFAULT_SETTINGS.agent;
    const raw = { type: "settings.changed", settings: { ...DEFAULT_SETTINGS, agent: older } };
    const event = parseServerEvent(raw);
    expect(event).toBe(raw);
    expect(() => handleLikeTheUi(event!)).not.toThrow();
  });
});
