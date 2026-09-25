/**
 * The data contract under real traffic: every runtime event produced by a broad mix of flows must
 * parse as a `ServerEvent` of `@ddl/contract`, and every sidecar file the run leaves behind must
 * parse with its persisted-format schema.
 */
import {
  decodePersistedThreadJournal,
  PersistedApprovalsFileSchema,
  PersistedRecordsFileSchema,
  PersistedRoutinesFileSchema,
  PersistedTaskStateFileSchema,
  PersistedThreadFileSchema,
  persistedThreadIdFromJournalPath,
  ServerEventSchema,
} from "@ddl/contract";
import type { ServerEvent } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime, RuntimeEvent } from "../../src/testing";
import { fakeRuntime, subagentFor, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

function toServerEvent(event: RuntimeEvent): ServerEvent {
  switch (event.type) {
    case "task.record":
      return { type: "task.record", record: event.payload };
    case "task.records":
      return { type: "task.records", ...event.payload };
    case "thread.upsert":
      return { type: "thread.upsert", thread: event.payload };
    case "thread.message":
      return { type: "thread.message", ...event.payload };
    case "thread.delta":
      return { type: "thread.delta", ...event.payload };
    case "approval.upsert":
      return { type: "approval.upsert", approval: event.payload };
    case "status":
      return { type: "agent.status", status: event.payload };
    case "surface.frame":
      return { type: "surface.frame", ...event.payload };
    case "routines.changed":
      return { type: "routines.changed", routines: event.payload };
    case "routine.notification":
      return { type: "routine.notification", notification: event.payload };
  }
}

function invalidEvents(t: FakeAgentRuntime): string[] {
  const problems: string[] = [];
  for (const event of t.events) {
    const parsed = ServerEventSchema.safeParse(toServerEvent(event));
    if (!parsed.success) {
      problems.push(
        `${event.type}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    }
  }
  return problems;
}

async function invalidFiles(t: FakeAgentRuntime): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of await t.storage.list({ includeHidden: true, prefix: ".daily-do-list" })) {
    const journalOf = persistedThreadIdFromJournalPath(entry.path);
    if (journalOf) {
      const read = decodePersistedThreadJournal(
        (await t.storage.read(entry.path))!.content,
        journalOf,
      );
      if (read.issues.length > 0 || read.newer !== null || !read.endsWithNewline) {
        problems.push(`${entry.path}: ${JSON.stringify(read.issues)} newer=${read.newer}`);
      }
      if (!read.events.some((e) => e.type === "thread.created" || e.type === "thread.imported")) {
        problems.push(`${entry.path}: no thread.created or thread.imported event`);
      }
      continue;
    }
    const schema =
      entry.path.startsWith(".daily-do-list/threads/") && entry.path.endsWith(".json")
        ? PersistedThreadFileSchema
        : entry.path === ".daily-do-list/state/records.json"
          ? PersistedRecordsFileSchema
          : entry.path === ".daily-do-list/state/approvals.json"
            ? PersistedApprovalsFileSchema
            : entry.path === ".daily-do-list/state/routines.json"
              ? PersistedRoutinesFileSchema
              : entry.path.startsWith(".daily-do-list/state/tasks/")
                ? PersistedTaskStateFileSchema
                : undefined;
    if (!schema) continue;
    const file = await t.storage.read(entry.path);
    const parsed = schema.safeParse(JSON.parse(file!.content));
    if (!parsed.success) {
      problems.push(
        `${entry.path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    }
  }
  return problems;
}

describe("wire and persistence contract under real traffic", () => {
  it("every event and every sidecar file of a busy mock-mode day is valid", async () => {
    const t = await fakeRuntime({ wordDelayMs: 0 });
    await t.writeDailyNote([
      "- [ ] Research best standing desks under $500",
      "  - under 30 inches deep",
      "- [ ] What's the capital of Australia?",
      "- [ ] Go to the gym",
      "- [ ] Figure out the thing",
      "- [ ] Book a table for two on Friday",
      "- [ ] Email landlord about the leaky faucet",
      "- [ ] Research 🌱 café options in Zürich — “naïve” \\ test",
      `- [ ] Research ${"very long task text ".repeat(120)}`,
    ]);
    await t.waitForStatus("Figure out the thing", "waiting_user");
    await t.replyInThread("Figure out the thing", "The quarterly tax estimate");
    await t.approveNext({ task: "Book a table for two on Friday", scope: "task" });
    await t.denyNext("Not now", { task: "Email landlord about the leaky faucet" });
    await t.waitForStatus("Email landlord about the leaky faucet", "waiting_user");
    await t.waitForStatus("Book a table for two on Friday", "done");
    await t.waitForStatus("Research best standing desks under $500", "done");
    await t.replyInThread("Research best standing desks under $500", "Only ones with a crank");
    await t.waitForStatus("Figure out the thing", "done");
    await t.idle();
    await t.runtime.stop();

    expect(new Set(t.events.map((e) => e.type))).toEqual(
      new Set([
        "task.record",
        "task.records",
        "thread.upsert",
        "thread.message",
        "thread.delta",
        "approval.upsert",
        "status",
      ]),
    );
    expect(invalidEvents(t)).toEqual([]);
    expect(await invalidFiles(t)).toEqual([]);
    const journals = await t.storage.list({
      includeHidden: true,
      prefix: ".daily-do-list/state/journal/threads",
    });
    expect(journals.length).toBeGreaterThan(0);
  });

  it("live-mode events with browser frames, blocks and failures are valid too", async () => {
    const t = await fakeRuntime({ mode: "live", execution: { browser: true }, connectors: true });
    t.brain.fail({
      role: subagentFor("Compare flights to Denver"),
      message: "flaky model",
      times: 1,
    });
    await t.writeDailyNote([
      "- [ ] Compare flights to Denver",
      "- [ ] Order printer ink (HP 63XL)",
    ]);
    const failed = await t.waitForStatus("Compare flights to Denver", "failed");
    await t.runtime.retryThread(failed.threadId!);
    const approval = await t.waitForApproval();
    const unsubscribe = t.runtime.subscribeSurface(approval.threadId!, "browser");
    await t.approveNext();
    await t.waitForStatus("Order printer ink (HP 63XL)", "done");
    await t.waitForStatus("Compare flights to Denver", "done");
    unsubscribe();
    await t.idle();
    await t.runtime.stop();

    expect(t.events.some((e) => e.type === "surface.frame")).toBe(true);
    expect(invalidEvents(t)).toEqual([]);
    expect(await invalidFiles(t)).toEqual([]);
  });
});
