/**
 * Type lockstep between the persisted schemas and the @ddl/core types the code reads and writes:
 * each pair must be mutually assignable, so a change on either side fails `pnpm typecheck`.
 * (The agent-owned types — SubagentSpec, ApprovalGrant, Capability — are checked in
 * packages/agent/test/persistence/types.test.ts.)
 */
import type {
  ActionCategory,
  ApprovalRequest,
  ApprovalScope,
  ApprovalStatus,
  AppSettings,
  ArtifactKind,
  ArtifactMeta,
  DeepPartial,
  RiskLevel,
  SurfaceKind,
  TaskAgentRecord,
  TaskAgentStatus,
  TaskStatus,
  Thread,
  ThreadMessage,
  TrackedTask,
} from "@ddl/core";
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  PersistedActionCategorySchema,
  PersistedApprovalRequest,
  PersistedApprovalScopeSchema,
  PersistedApprovalStatusSchema,
  PersistedArtifactKindSchema,
  PersistedArtifactMeta,
  PersistedRiskLevelSchema,
  PersistedSettingsOverrides,
  PersistedSurfaceKindSchema,
  PersistedTaskAgentRecord,
  PersistedTaskAgentStatusSchema,
  PersistedTaskStatusSchema,
  PersistedThread,
  PersistedThreadMessage,
  PersistedTrackedTask,
} from "../../src/persisted";

type Assignable<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

describe("persisted schemas ⇔ @ddl/core types", () => {
  it("threads and their parts", () => {
    expectTypeOf<Mutual<PersistedThread, Thread>>().toEqualTypeOf<true>();
    expectTypeOf<Mutual<PersistedThreadMessage, ThreadMessage>>().toEqualTypeOf<true>();
    expectTypeOf<Mutual<PersistedArtifactMeta, ArtifactMeta>>().toEqualTypeOf<true>();
  });

  it("task records, tracked tasks and approvals", () => {
    expectTypeOf<Mutual<PersistedTaskAgentRecord, TaskAgentRecord>>().toEqualTypeOf<true>();
    expectTypeOf<Mutual<PersistedTrackedTask, TrackedTask>>().toEqualTypeOf<true>();
    expectTypeOf<Mutual<PersistedApprovalRequest, ApprovalRequest>>().toEqualTypeOf<true>();
  });

  it("settings overrides", () => {
    expectTypeOf<
      Mutual<PersistedSettingsOverrides, DeepPartial<AppSettings>>
    >().toEqualTypeOf<true>();
  });

  it("enums", () => {
    expectTypeOf<z.infer<typeof PersistedTaskAgentStatusSchema>>().toEqualTypeOf<TaskAgentStatus>();
    expectTypeOf<z.infer<typeof PersistedTaskStatusSchema>>().toEqualTypeOf<TaskStatus>();
    expectTypeOf<z.infer<typeof PersistedRiskLevelSchema>>().toEqualTypeOf<RiskLevel>();
    expectTypeOf<z.infer<typeof PersistedActionCategorySchema>>().toEqualTypeOf<ActionCategory>();
    expectTypeOf<z.infer<typeof PersistedApprovalScopeSchema>>().toEqualTypeOf<ApprovalScope>();
    expectTypeOf<z.infer<typeof PersistedApprovalStatusSchema>>().toEqualTypeOf<ApprovalStatus>();
    expectTypeOf<z.infer<typeof PersistedArtifactKindSchema>>().toEqualTypeOf<ArtifactKind>();
    expectTypeOf<z.infer<typeof PersistedSurfaceKindSchema>>().toEqualTypeOf<SurfaceKind>();
  });
});
