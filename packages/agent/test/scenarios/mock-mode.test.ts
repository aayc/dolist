/**
 * `DDL_AGENT_MODE=mock` as shipped: the runtime builds its own harness (the sandboxed fake brain).
 * Guarantees: deterministic, no network, risky verbs exercise approvals via
 * `mock_irreversible_action`, chores are ignored, streaming is visible, and nothing with real-world
 * reach is ever used even when available.
 */
import type { Thread, ThreadMessage } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { createFakeBrain } from "../../src/testing";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

const NOTE = [
  "- [ ] Research best standing desks under $500",
  "- [ ] Go to the gym",
  "- [ ] Book dentist appointment next week",
  "  - prefer mornings",
  "- [ ] What's the capital of Australia?",
  "- [ ] Figure out the thing",
  "- [x] Paid rent",
  "- [ ] ",
  "",
  "Notes: https://example.com/ideas",
];

describe("mock mode (the runtime's built-in brain script)", () => {
  it("runs a realistic note end to end", async () => {
    const t = await fakeRuntime({ runtimeHarness: true, overrides: { mockWordDelayMs: 1 } });
    await t.writeDailyNote(NOTE);
    await t.waitForStatus("Research best standing desks under $500", "done");
    await t.waitForStatus("Go to the gym", "ignored");
    await t.waitForStatus("What's the capital of Australia?", "done");
    await t.waitForStatus("Figure out the thing", "waiting_user");
    await t.waitForStatus("Book dentist appointment next week", "waiting_approval");
    const [approval] = t.pendingApprovals();
    expect(approval).toMatchObject({
      toolName: "mock_irreversible_action",
      categories: ["booking"],
    });
    await t.approveNext();
    await t.waitForStatus("Book dentist appointment next week", "done");

    expect(t.records().map((r) => r.text)).toEqual(
      NOTE.slice(0, 6)
        .filter((l) => l.startsWith("- [ ]"))
        .map((l) => l.slice(6)),
    );
    expect(t.runtime.status()).toMatchObject({ mode: "mock", model: "mock" });
    const deltas = t.events.filter((e) => e.type === "thread.delta");
    expect(deltas.length).toBeGreaterThan(10);
    expectAllGated(t);
  });

  it("never touches the browser, shell or connectors, even when they're available", async () => {
    const t = await fakeRuntime({
      runtimeHarness: true,
      execution: { browser: true, shell: true },
      connectors: true,
    });
    await t.writeDailyNote([
      "- [ ] Order printer ink (HP 63XL)",
      "- [ ] Email landlord about the leaky faucet",
    ]);
    await t.waitForStatus("Order printer ink (HP 63XL)", "waiting_approval");
    await t.waitForStatus("Email landlord about the leaky faucet", "waiting_approval");
    expect(t.pendingApprovals().map((a) => a.toolName)).toEqual([
      "mock_irreversible_action",
      "mock_irreversible_action",
    ]);
    for (const spawn of t.audit.gate.filter((g) => g.toolName === "spawn_subagent")) {
      const { capabilities } = spawn.input as { capabilities: string[] };
      expect(capabilities.every((c) => c === "web" || c === "files")).toBe(true);
    }
    await t.approveNext();
    await t.approveNext();
    await t.idle();
    expect(t.execution.browser!.actions).toEqual([]);
    expect(t.execution.commands).toEqual([]);
    expect(t.connectors!.calls).toEqual([]);
  });

  it("is deterministic: the same note yields the same threads", async () => {
    const run = async () => {
      const t = await fakeRuntime({ runtimeHarness: true });
      await t.writeDailyNote(NOTE.slice(0, 5));
      await t.waitForStatus("Book dentist appointment next week", "waiting_approval");
      await t.approveNext();
      await t.waitForStatus("Book dentist appointment next week", "done");
      await t.waitForStatus("Research best standing desks under $500", "done");
      await t.idle();
      return t.runtime
        .listThreads()
        .map((summary) => normalize(t.runtime.getThread(summary.id)!.thread))
        .sort((a, b) => a.title.localeCompare(b.title));
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(first.length).toBe(3);
  });

  it("seeded brains vary their phrasing but not their behavior", async () => {
    const plain = await fakeRuntime();
    const seeded = await fakeRuntime({ brain: createFakeBrain({ seed: 7 }) });
    for (const t of [plain, seeded]) {
      await t.writeDailyNote(["- [ ] Research standing desks", "- [ ] Compare robot vacuums"]);
      await t.waitForStatus("Research standing desks", "done");
      await t.waitForStatus("Compare robot vacuums", "done");
    }
    const shape = (t: typeof plain) => t.audit.gate.map((g) => g.toolName).sort();
    expect(shape(seeded)).toEqual(shape(plain));
    const comments = (t: typeof plain) => [
      t.texts("Research standing desks")[0],
      t.texts("Compare robot vacuums")[0],
    ];
    expect(comments(seeded)).not.toEqual(comments(plain));
  });
});

/** A thread without ids and timestamps, for comparing runs. */
function normalize(thread: Thread): { title: string; status: string; messages: unknown[] } {
  return {
    title: thread.title,
    status: thread.status,
    messages: thread.messages.map((m: ThreadMessage) => {
      switch (m.kind) {
        case "text":
          return { kind: m.kind, author: m.author, text: m.text };
        case "tool_call":
          return { kind: m.kind, tool: m.toolName, status: m.status, input: m.input };
        case "status":
          return { kind: m.kind, status: m.status, text: m.text };
        default:
          return { kind: m.kind, author: m.author };
      }
    }),
  };
}
