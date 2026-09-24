/**
 * `.daily-do-list/state/approvals.json` — the approval broker's standing grants ("approve for this
 * task" / "always approve") and its pending plus most recent decided approvals. Written by
 * packages/agent/src/safety/approval-store.ts, pretty-printed JSON with a trailing newline.
 *
 * Grants widen what agents may do without asking, so they are read strictly: a grant with an
 * unknown risk level or category, or a task grant without a task, is dropped rather than repaired
 * into something broader.
 *
 * v1: `{ version, grants, approvals }`. The writer always wrote `version: 1`; the reader accepts the
 * same shape without it, as the pre-contract reader did.
 */
import { z } from "zod";
import {
  decodePersisted,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedFormatSpec,
  PersistedListSchema,
  readEnvelope,
  salvageList,
} from "./common";
import {
  PersistedActionCategorySchema,
  PersistedApprovalScopeSchema,
  PersistedApprovalStatusSchema,
  PersistedIdSchema,
  PersistedRiskLevelSchema,
  PersistedTimestampSchema,
} from "./primitives";

export const PERSISTED_APPROVALS_VERSION = 1;

export const PersistedApprovalGrantSchema = z
  .object({
    toolName: z.string().min(1),
    scope: z.enum(["task", "always"]),
    taskId: z.string().nullable(),
    createdAt: PersistedTimestampSchema,
    /** When set, the grant only covers calls whose categories are all listed. */
    categories: z.array(PersistedActionCategorySchema).optional(),
    /** When set, the grant does not cover riskier calls. */
    risk: PersistedRiskLevelSchema.optional(),
  })
  .refine((grant) => grant.scope !== "task" || grant.taskId !== null, {
    message: "a task grant needs a taskId",
  })
  .transform((grant) => (grant.scope === "always" ? { ...grant, taskId: null } : grant));
export type PersistedApprovalGrant = z.infer<typeof PersistedApprovalGrantSchema>;

export const PersistedApprovalRequestSchema = z.object({
  id: PersistedIdSchema,
  threadId: z.string().nullable(),
  taskId: z.string().nullable(),
  toolName: z.string(),
  toolLabel: z.string().optional(),
  /** Tool arguments as JSON; absent when the call had none. */
  input: z.unknown().default(undefined),
  summary: z.string(),
  risk: PersistedRiskLevelSchema,
  categories: z.array(PersistedActionCategorySchema),
  reason: z.string(),
  status: PersistedApprovalStatusSchema,
  scope: PersistedApprovalScopeSchema.optional(),
  decisionNote: z.string().optional(),
  createdAt: PersistedTimestampSchema,
  decidedAt: PersistedTimestampSchema.optional(),
  expiresAt: PersistedTimestampSchema.optional(),
});
export type PersistedApprovalRequest = z.infer<typeof PersistedApprovalRequestSchema>;

export const PersistedApprovalsFileSchema = z.object({
  version: z.literal(PERSISTED_APPROVALS_VERSION),
  grants: z.array(PersistedApprovalGrantSchema),
  approvals: z.array(PersistedApprovalRequestSchema),
});
export type PersistedApprovalsFile = z.infer<typeof PersistedApprovalsFileSchema>;
export type PersistedApprovals = Omit<PersistedApprovalsFile, "version">;

const ApprovalsEnvelopeSchema = z.object({
  grants: PersistedListSchema,
  approvals: PersistedListSchema,
});

const approvalsSpec: PersistedFormatSpec<PersistedApprovals> = {
  version: PERSISTED_APPROVALS_VERSION,
  migrateUnversioned: (doc) => ({ ...doc, version: 1 }),
  read(doc, issues) {
    const envelope = readEnvelope(ApprovalsEnvelopeSchema, doc);
    if (envelope instanceof PersistedCorruption) return envelope;
    return {
      grants: salvageList(envelope.grants, PersistedApprovalGrantSchema, "grants", issues),
      approvals: salvageList(
        envelope.approvals,
        PersistedApprovalRequestSchema,
        "approvals",
        issues,
        (a) => a.id,
      ),
    };
  },
};

export function decodePersistedApprovals(text: string): PersistedDecodeResult<PersistedApprovals> {
  return decodePersisted(approvalsSpec, text);
}

export function encodePersistedApprovals(state: PersistedApprovals): string {
  const file: PersistedApprovalsFile = {
    version: PERSISTED_APPROVALS_VERSION,
    grants: state.grants,
    approvals: state.approvals,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Union of both sides. Grants are deduplicated by their full content. For an approval id present
 * on both sides a decided copy beats a pending one (the decision happened somewhere); otherwise
 * `ours` wins.
 */
export function mergePersistedApprovals(
  ours: PersistedApprovals,
  theirs: PersistedApprovals,
): PersistedApprovals {
  const grants = [...ours.grants];
  const seen = new Set(grants.map(grantKey));
  for (const grant of theirs.grants) {
    const key = grantKey(grant);
    if (!seen.has(key)) {
      seen.add(key);
      grants.push(grant);
    }
  }
  const approvals = new Map(ours.approvals.map((approval) => [approval.id, approval]));
  for (const approval of theirs.approvals) {
    const mine = approvals.get(approval.id);
    if (!mine || (mine.status === "pending" && approval.status !== "pending")) {
      approvals.set(approval.id, approval);
    }
  }
  return { grants, approvals: [...approvals.values()] };
}

function grantKey(grant: PersistedApprovalGrant): string {
  return JSON.stringify([
    grant.toolName,
    grant.scope,
    grant.taskId,
    grant.risk ?? null,
    grant.categories ? [...grant.categories].sort() : null,
  ]);
}
