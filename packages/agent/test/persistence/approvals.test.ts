import { encodePersistedApprovals, PersistedApprovalsFileSchema } from "@ddl/contract";
import type { ApprovalRequest } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { approvalArb, grantArb } from "../../../contract/test/persisted/arbitraries";
import {
  APPROVALS_STATE_PATH,
  type ApprovalState,
  createApprovalStateFile,
  MAX_PERSISTED_DECIDED,
  mergeApprovalStates,
  parseApprovalState,
  serializeApprovalState,
} from "../../src/safety/approval-store";
import { createApprovalBroker } from "../../src/safety/approvals";
import { NOW, readFixture, recordingLogger, STAMP, sidecar, vault } from "./helpers";

const CORRUPT_COPY = `.daily-do-list/corrupt/state/approvals.${STAMP}.json`;

const BOOKING: ApprovalRequest = {
  id: "apr_book01",
  threadId: "thr_k3j9x0q2m1ab",
  taskId: "tsk_7fq2m9x0ab",
  toolName: "browser_click",
  toolLabel: "Click",
  input: { element: "Confirm booking", ref: "e42" },
  summary: "Click “Confirm booking” on the dentist's site",
  risk: "medium",
  categories: ["form_submission"],
  reason: "Submits a booking form",
  status: "approved",
  scope: "task",
  decisionNote: "Tuesday works",
  createdAt: 1790154004000,
  decidedAt: 1790154004500,
  expiresAt: 1790197204000,
};

async function broker(storage: ReturnType<typeof vault>) {
  const events: ApprovalRequest[] = [];
  const b = createApprovalBroker({ storage, now: () => NOW });
  b.onUpsert((approval) => events.push(approval));
  await b.ready;
  return { broker: b, events };
}

describe("golden approvals fixtures through the real approval broker", () => {
  it("v1.json: grants apply as recorded, history loads, the pending approval loads as expired", async () => {
    const storage = vault({ [APPROVALS_STATE_PATH]: readFixture("approvals", "v1.json") });
    const { broker: b, events } = await broker(storage);
    const taskGrant = { toolName: "browser_click", taskId: "tsk_7fq2m9x0ab" };
    expect(b.findGrant({ ...taskGrant, categories: ["form_submission"], risk: "medium" })).toEqual({
      toolName: "browser_click",
      scope: "task",
      taskId: "tsk_7fq2m9x0ab",
      createdAt: 1790154004500,
      categories: ["form_submission"],
      risk: "medium",
    });
    expect(
      b.findGrant({ ...taskGrant, categories: ["form_submission"], risk: "high" }),
    ).toBeUndefined();
    expect(b.findGrant({ ...taskGrant, categories: ["payment"], risk: "low" })).toBeUndefined();
    expect(b.findGrant({ ...taskGrant, taskId: "tsk_other" })).toBeUndefined();
    expect(
      b.findGrant({
        toolName: "mcp__calendar__create_event",
        taskId: null,
        categories: ["booking"],
      }),
    ).toMatchObject({ scope: "always", taskId: null, risk: "high" });
    // A target-scoped grant covers its app only, never another app or the whole screen.
    const appGrant = {
      toolName: "computer_set_value",
      taskId: "tsk_7fq2m9x0ab",
      categories: ["computer_control" as const],
      risk: "medium" as const,
    };
    expect(b.findGrant({ ...appGrant, target: "grok bot" })).toMatchObject({ target: "grok bot" });
    expect(b.findGrant({ ...appGrant, target: "whatsapp" })).toBeUndefined();
    expect(b.findGrant(appGrant)).toBeUndefined();

    expect(b.get("apr_book01")).toEqual(BOOKING);
    const expired = {
      id: "apr_ink0001",
      threadId: "thr_ink0000001",
      taskId: "tsk_wait000001",
      toolName: "browser_click",
      input: { element: "Place order" },
      summary: "Click “Place order” (€34.90)",
      risk: "high",
      categories: ["payment"],
      reason: "Completes a purchase",
      status: "expired",
      createdAt: 1790154006000,
      expiresAt: 1790197206000,
      decidedAt: NOW,
      decisionNote: "The app restarted before a decision was made.",
    };
    expect(b.get("apr_ink0001")).toEqual(expired);
    expect(events).toEqual([expired]);
    await b.flush();
    expect(
      parseApprovalState((await storage.read(APPROVALS_STATE_PATH))!.content)?.approvals,
    ).toEqual([BOOKING, expired]);
  });

  it("legacy-unversioned.json loads its grants", async () => {
    const storage = vault({
      [APPROVALS_STATE_PATH]: readFixture("approvals", "legacy-unversioned.json"),
    });
    const { broker: b } = await broker(storage);
    expect(b.findGrant({ toolName: "web_fetch", taskId: "tsk_any" })).toEqual({
      toolName: "web_fetch",
      scope: "always",
      taskId: null,
      createdAt: 1790000000000,
    });
  });

  it("v1-invalid-entries.json: malformed grants never become broader grants (regression)", async () => {
    // The pre-contract parser kept a grant whose `risk` or `categories` was malformed and dropped
    // only that field, which made the grant cover every risk level or every category.
    const storage = vault({
      [APPROVALS_STATE_PATH]: readFixture("approvals", "v1-invalid-entries.json"),
    });
    const { broker: b } = await broker(storage);
    expect(
      b.findGrant({
        toolName: "browser_click",
        taskId: "tsk_1",
        categories: ["payment"],
        risk: "critical",
      }),
    ).toBeUndefined();
    expect(b.findGrant({ toolName: "browser_click", taskId: "tsk_1" })).toBeUndefined();
    expect(b.findGrant({ toolName: "browser_type", taskId: null })).toBeUndefined();
    // A malformed target drops the grant; it never becomes an unscoped (screen-level) grant.
    expect(b.findGrant({ toolName: "computer_press", taskId: null })).toBeUndefined();
    expect(b.findGrant({ toolName: "computer_press", taskId: null, target: "" })).toBeUndefined();
    expect(b.findGrant({ toolName: "bash", taskId: "tsk_9" })).toMatchObject({
      scope: "always",
      taskId: null,
    });
    expect(b.list().map((a) => a.id)).toEqual(["apr_ok"]);
  });

  it.each(["corrupt-truncated.json", "future-version.json"])(
    "%s is ignored by the broker: no grants, no approvals",
    async (name) => {
      const storage = vault({ [APPROVALS_STATE_PATH]: readFixture("approvals", name) });
      const { broker: b } = await broker(storage);
      expect(b.list()).toEqual([]);
      expect(b.findGrant({ toolName: "browser_click", taskId: "tsk_1" })).toBeUndefined();
    },
  );

  // Known gap: createApprovalBroker (safety/approvals.ts, not owned by this slice) still writes
  // approvals.json unconditionally. Switching its load/persist to createApprovalStateFile (below)
  // makes these pass; then turn `it.fails` into `it`.
  it.fails("the broker keeps a future-version approvals.json untouched after a new approval", async () => {
    const future = readFixture("approvals", "future-version.json");
    const storage = vault({ [APPROVALS_STATE_PATH]: future });
    const { broker: b } = await broker(storage);
    void b.request({
      threadId: null,
      taskId: null,
      toolName: "bash",
      input: { command: "ls" },
      summary: "Run ls",
      risk: "low",
      categories: ["read"],
      reason: "test",
      timeoutMs: 60_000,
    });
    await b.dispose();
    expect((await storage.read(APPROVALS_STATE_PATH))!.content).toBe(future);
  });

  it.fails("the broker moves a corrupt approvals.json aside before replacing it", async () => {
    const corrupt = readFixture("approvals", "corrupt-truncated.json");
    const storage = vault({ [APPROVALS_STATE_PATH]: corrupt });
    const { broker: b } = await broker(storage);
    void b.request({
      threadId: null,
      taskId: null,
      toolName: "bash",
      input: {},
      summary: "Run ls",
      risk: "low",
      categories: ["read"],
      reason: "test",
      timeoutMs: 60_000,
    });
    await b.dispose();
    expect((await storage.read(CORRUPT_COPY))?.content).toBe(corrupt);
  });
});

describe("createApprovalStateFile (the storage-bound loader for the broker)", () => {
  const empty = () => ({ grants: [], approvals: [] });

  it("loads v1 and legacy files exactly like parseApprovalState", async () => {
    for (const name of ["v1.json", "legacy-unversioned.json"]) {
      const content = readFixture("approvals", name);
      const file = createApprovalStateFile({
        storage: vault({ [APPROVALS_STATE_PATH]: content }),
        now: () => NOW,
      });
      expect(await file.load()).toEqual(parseApprovalState(content));
    }
  });

  it("moves a corrupt file aside byte for byte, then writes a fresh one", async () => {
    const corrupt = readFixture("approvals", "corrupt-truncated.json");
    const storage = vault({ [APPROVALS_STATE_PATH]: corrupt });
    const file = createApprovalStateFile({ storage, now: () => NOW, logger: recordingLogger() });
    expect(await file.load()).toBeUndefined();
    expect(await file.save(empty)).toBe("written");
    expect(await sidecar(storage)).toEqual({
      [CORRUPT_COPY]: corrupt,
      [APPROVALS_STATE_PATH]: serializeApprovalState([], []),
    });
  });

  it("never writes over a future-version file", async () => {
    const future = readFixture("approvals", "future-version.json");
    const storage = vault({ [APPROVALS_STATE_PATH]: future });
    const file = createApprovalStateFile({ storage, now: () => NOW });
    expect(await file.load()).toBeUndefined();
    expect(file.blocked).toMatch(/newer version/);
    expect(await file.save(empty)).toBe("blocked");
    expect(await sidecar(storage)).toEqual({ [APPROVALS_STATE_PATH]: future });
  });

  it("keeps a copy of a partly invalid file before its first rewrite", async () => {
    const original = readFixture("approvals", "v1-invalid-entries.json");
    const storage = vault({ [APPROVALS_STATE_PATH]: original });
    const file = createApprovalStateFile({ storage, now: () => NOW });
    const loaded = await file.load();
    expect(loaded?.grants).toHaveLength(1);
    expect(await file.save(() => loaded!)).toBe("written");
    expect((await storage.read(CORRUPT_COPY))!.content).toBe(original);
  });

  it("hands a concurrent change to the owner for merging before it writes", async () => {
    const storage = vault();
    const file = createApprovalStateFile({ storage, now: () => NOW });
    await file.load();
    let ours: ApprovalState = {
      version: 1,
      grants: [],
      approvals: [{ ...BOOKING, status: "pending" }],
    };
    await file.save(() => ours);
    storage.simulateExternalChange(APPROVALS_STATE_PATH, serializeApprovalState([], [BOOKING]));
    const result = await file.save(
      () => ours,
      (theirs) => {
        ours = mergeApprovalStates(ours, theirs);
      },
    );
    expect(result).toBe("written");
    expect(
      parseApprovalState((await storage.read(APPROVALS_STATE_PATH))!.content)?.approvals,
    ).toEqual([BOOKING]);
  });

  it("reports storage failures instead of throwing", async () => {
    const storage = vault();
    storage.write = async () => {
      throw new Error("disk full");
    };
    const file = createApprovalStateFile({ storage, now: () => NOW, logger: recordingLogger() });
    await file.load();
    expect(await file.save(empty)).toBe("failed");
  });
});

describe("approvals writer", () => {
  test.prop([
    fc.array(grantArb, { maxLength: 5 }),
    fc.uniqueArray(approvalArb(), { maxLength: 12, selector: (a) => a.id }),
  ])(
    "serializes schema-valid state that parses back to the kept approvals",
    (grants, approvals) => {
      const text = serializeApprovalState(grants, approvals);
      expect(PersistedApprovalsFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
      const parsed = parseApprovalState(text)!;
      expect(parsed.grants).toEqual(grants);
      expect(new Set(parsed.approvals.map((a) => a.id))).toEqual(
        new Set(approvals.map((a) => a.id)),
      );
      expect(text).toBe(
        encodePersistedApprovals({ grants: parsed.grants, approvals: parsed.approvals }),
      );
    },
  );

  it("keeps every pending approval and only the most recent decided ones", () => {
    const decided = Array.from({ length: MAX_PERSISTED_DECIDED + 10 }, (_, i) => ({
      ...BOOKING,
      id: `apr_${i}`,
      decidedAt: i,
    }));
    const pending = { ...BOOKING, id: "apr_pending", status: "pending" as const, createdAt: 0 };
    const parsed = parseApprovalState(serializeApprovalState([], [...decided, pending]))!;
    expect(parsed.approvals).toHaveLength(MAX_PERSISTED_DECIDED + 1);
    expect(parsed.approvals.some((a) => a.id === "apr_pending")).toBe(true);
    expect(parsed.approvals.some((a) => a.id === "apr_0")).toBe(false);
  });
});
