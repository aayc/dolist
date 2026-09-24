/**
 * Lockstep between the persisted schemas (@ddl/contract) and the agent-owned types they store:
 * mutual assignability at compile time (`pnpm typecheck`), plus the runtime enum lists the agent
 * validates against.
 */
import {
  PersistedActionCategorySchema,
  type PersistedApprovalGrant,
  type PersistedApprovals,
  PersistedCapabilitySchema,
  PersistedRiskLevelSchema,
  type PersistedSettledTask,
  type PersistedSubagentSpec,
} from "@ddl/contract";
import type { TrackedTask } from "@ddl/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Capability } from "../../src/execution/types";
import type { SubagentSpec } from "../../src/orchestrator/types";
import type { ApprovalState } from "../../src/safety/approval-store";
import { ACTION_CATEGORIES, RISK_LEVELS } from "../../src/safety/policy";
import type { ApprovalGrant } from "../../src/safety/types";
import { CAPABILITIES } from "../../src/tools/orchestrator";

type Assignable<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

describe("persisted schemas ⇔ agent types", () => {
  it("records.json specs, approvals.json grants and tracker snapshots", () => {
    expectTypeOf<Mutual<PersistedSubagentSpec, SubagentSpec>>().toEqualTypeOf<true>();
    expectTypeOf<Mutual<PersistedApprovalGrant, ApprovalGrant>>().toEqualTypeOf<true>();
    expectTypeOf<
      Mutual<{ version: 1 } & PersistedApprovals, ApprovalState>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mutual<PersistedSettledTask, { task: TrackedTask; announced: boolean }>
    >().toEqualTypeOf<true>();
    expectTypeOf<(typeof PersistedCapabilitySchema.options)[number]>().toEqualTypeOf<Capability>();
  });

  it("enum lists match the agent's own", () => {
    expect([...PersistedCapabilitySchema.options].sort()).toEqual([...CAPABILITIES].sort());
    expect([...PersistedActionCategorySchema.options].sort()).toEqual(
      [...ACTION_CATEGORIES].sort(),
    );
    expect([...PersistedRiskLevelSchema.options]).toEqual([...RISK_LEVELS]);
  });
});
