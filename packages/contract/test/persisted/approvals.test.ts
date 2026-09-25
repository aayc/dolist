import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decodePersistedApprovals,
  encodePersistedApprovals,
  mergePersistedApprovals,
  type PersistedApprovalGrant,
  type PersistedApprovalRequest,
  PersistedApprovalsFileSchema,
} from "../../src/persisted";
import { approvalArb, approvalsArb, grantArb } from "./arbitraries";

const approval: PersistedApprovalRequest = {
  id: "apr_1",
  threadId: "thr_1",
  taskId: "tsk_1",
  toolName: "browser_click",
  input: { element: "Place order" },
  summary: "Click “Place order”",
  risk: "high",
  categories: ["payment"],
  reason: "Completes a purchase",
  status: "approved",
  scope: "task",
  createdAt: 1_000,
  decidedAt: 2_000,
  expiresAt: 5_000,
};
const grant: PersistedApprovalGrant = {
  toolName: "browser_click",
  scope: "task",
  taskId: "tsk_1",
  createdAt: 1,
  categories: ["payment"],
  risk: "high",
};

const decodeGrants = (grants: unknown[]) => {
  const result = decodePersistedApprovals(JSON.stringify({ version: 1, grants, approvals: [] }));
  if (!result.ok) throw new Error("expected ok");
  return result;
};

describe("decodePersistedApprovals", () => {
  it("reads v1 files and files without `version`", () => {
    const v1 = decodePersistedApprovals(
      JSON.stringify({ version: 1, grants: [grant], approvals: [approval] }),
    );
    expect(v1).toEqual({
      ok: true,
      value: { grants: [grant], approvals: [approval] },
      fromVersion: 1,
      issues: [],
    });
    const legacy = decodePersistedApprovals(JSON.stringify({ grants: [], approvals: [approval] }));
    expect(legacy).toMatchObject({ ok: true, fromVersion: null, value: { approvals: [approval] } });
  });

  it("normalizes the task of an `always` grant to null", () => {
    expect(decodeGrants([{ ...grant, scope: "always" }]).value.grants).toEqual([
      { ...grant, scope: "always", taskId: null },
    ]);
  });

  // Grants widen what agents may do unasked: anything malformed must make them disappear, never
  // turn into a broader grant (the pre-contract reader dropped a bad `risk`/`categories` field and
  // kept the grant, which then covered every risk level / category).
  it.each([
    ["a task grant without a task", { ...grant, taskId: null }],
    ["an unknown risk level", { ...grant, risk: "extreme" }],
    ["categories that are not a list", { ...grant, categories: "payment" }],
    ["an unknown category", { ...grant, categories: ["payment", "teleport"] }],
    ["an empty tool name", { ...grant, toolName: "" }],
    ["scope once", { ...grant, scope: "once" }],
    ["no createdAt", { ...grant, createdAt: undefined }],
    ["an empty target", { ...grant, target: "" }],
    ["a target that isn't text", { ...grant, target: 7 }],
    ["a target over 200 characters", { ...grant, target: "x".repeat(201) }],
  ])("drops a grant with %s instead of widening it", (_label, bad) => {
    const result = decodeGrants([bad]);
    expect(result.value.grants).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it("drops malformed approvals one by one", () => {
    const result = decodePersistedApprovals(
      JSON.stringify({
        version: 1,
        grants: [],
        approvals: [
          approval,
          { ...approval, id: "apr_2", status: "maybe" },
          { ...approval, id: "apr_3", categories: ["payment", "teleport"] },
          { ...approval, id: "apr_4", scope: "forever" },
          { id: "apr_5" },
        ],
      }),
    );
    expect(result.ok && result.value.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    expect(result.ok && result.issues).toHaveLength(4);
  });

  it("accepts approvals whose input was absent", () => {
    const { input: _input, ...noInput } = approval;
    const result = decodePersistedApprovals(
      JSON.stringify({ version: 1, grants: [], approvals: [noInput] }),
    );
    expect(result.ok && result.value.approvals[0]).toEqual({ ...noInput, input: undefined });
  });

  it("treats a file without both lists as corrupt", () => {
    expect(decodePersistedApprovals('{"version":1,"grants":[]}')).toMatchObject({
      kind: "corrupt",
    });
  });
});

describe("encodePersistedApprovals", () => {
  test.prop([approvalsArb])("output parses with the v1 schema and round-trips exactly", (state) => {
    const text = encodePersistedApprovals(state);
    expect(PersistedApprovalsFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(decodePersistedApprovals(text)).toEqual({
      ok: true,
      value: state,
      fromVersion: 1,
      issues: [],
    });
  });
});

describe("mergePersistedApprovals", () => {
  it("prefers a decided copy over a pending one and dedupes grants", () => {
    const pending = { ...approval, status: "pending" as const };
    const merged = mergePersistedApprovals(
      { grants: [grant], approvals: [pending] },
      { grants: [{ ...grant, createdAt: 99 }], approvals: [approval] },
    );
    expect(merged.approvals).toEqual([approval]);
    expect(merged.grants).toHaveLength(1);
    const kept = mergePersistedApprovals(
      { grants: [], approvals: [approval] },
      { grants: [], approvals: [{ ...approval, status: "denied" }] },
    );
    expect(kept.approvals).toEqual([approval]);
  });

  it("keeps grants for different targets apart", () => {
    const grok = { ...grant, target: "grok bot" };
    const merged = mergePersistedApprovals(
      { grants: [grant, grok], approvals: [] },
      {
        grants: [
          { ...grok, createdAt: 5 },
          { ...grant, target: "whatsapp" },
        ],
        approvals: [],
      },
    );
    expect(merged.grants.map((g) => g.target ?? null)).toEqual([null, "grok bot", "whatsapp"]);
  });

  test.prop([
    fc.array(grantArb, { maxLength: 4 }),
    fc.array(grantArb, { maxLength: 4 }),
    fc.uniqueArray(approvalArb(), { maxLength: 4, selector: (a) => a.id }),
    fc.uniqueArray(approvalArb(), { maxLength: 4, selector: (a) => a.id }),
  ])("is idempotent and keeps every approval id", (g1, g2, a1, a2) => {
    const merged = mergePersistedApprovals(
      { grants: g1, approvals: a1 },
      { grants: g2, approvals: a2 },
    );
    expect(mergePersistedApprovals(merged, { grants: g2, approvals: a2 })).toEqual(merged);
    const ids = new Set(merged.approvals.map((a) => a.id));
    for (const a of [...a1, ...a2]) expect(ids.has(a.id)).toBe(true);
  });
});
