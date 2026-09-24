/**
 * On-disk format of the approval broker's state: standing grants plus pending and recent
 * approvals, stored in the vault sidecar. Parsing is defensive — malformed entries are dropped,
 * never trusted — because the file lives next to user-editable notes.
 */
import type { ApprovalRequest, ApprovalScope, ApprovalStatus, RiskLevel } from "@ddl/core";
import { SIDECAR_DIR } from "@ddl/core";
import { ACTION_CATEGORIES, RISK_LEVELS } from "./policy";
import type { ApprovalGrant } from "./types";

export const APPROVALS_STATE_PATH = `${SIDECAR_DIR}/state/approvals.json`;
export const MAX_PERSISTED_DECIDED = 200;

const STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
];
const SCOPES: readonly ApprovalScope[] = ["once", "task", "always"];

export interface ApprovalState {
  version: 1;
  grants: ApprovalGrant[];
  approvals: ApprovalRequest[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

function categories(value: unknown): ApprovalRequest["categories"] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((c): c is ApprovalRequest["categories"][number] =>
    ACTION_CATEGORIES.includes(c),
  );
}

function parseGrant(value: unknown): ApprovalGrant | undefined {
  if (!isObject(value)) return undefined;
  const { toolName, scope, taskId, createdAt, risk } = value;
  if (
    !isString(toolName) ||
    (scope !== "task" && scope !== "always") ||
    !isNullableString(taskId) ||
    !isNumber(createdAt)
  ) {
    return undefined;
  }
  if (scope === "task" && taskId === null) return undefined;
  const cats = categories(value.categories);
  return {
    toolName,
    scope,
    taskId: scope === "always" ? null : taskId,
    createdAt,
    ...(cats ? { categories: cats } : {}),
    ...(RISK_LEVELS.includes(risk as RiskLevel) ? { risk: risk as RiskLevel } : {}),
  };
}

function parseApproval(value: unknown): ApprovalRequest | undefined {
  if (!isObject(value)) return undefined;
  const v = value;
  const cats = categories(v.categories);
  if (
    !isString(v.id) ||
    !isNullableString(v.threadId) ||
    !isNullableString(v.taskId) ||
    !isString(v.toolName) ||
    !isString(v.summary) ||
    !isString(v.reason) ||
    !RISK_LEVELS.includes(v.risk as RiskLevel) ||
    !STATUSES.includes(v.status as ApprovalStatus) ||
    !isNumber(v.createdAt) ||
    !cats
  ) {
    return undefined;
  }
  return {
    id: v.id,
    threadId: v.threadId,
    taskId: v.taskId,
    toolName: v.toolName,
    ...(isString(v.toolLabel) ? { toolLabel: v.toolLabel } : {}),
    input: v.input,
    summary: v.summary,
    risk: v.risk as RiskLevel,
    categories: cats,
    reason: v.reason,
    status: v.status as ApprovalStatus,
    ...(SCOPES.includes(v.scope as ApprovalScope) ? { scope: v.scope as ApprovalScope } : {}),
    ...(isString(v.decisionNote) ? { decisionNote: v.decisionNote } : {}),
    createdAt: v.createdAt,
    ...(isNumber(v.decidedAt) ? { decidedAt: v.decidedAt } : {}),
    ...(isNumber(v.expiresAt) ? { expiresAt: v.expiresAt } : {}),
  };
}

/** Returns undefined for unreadable files; drops individual malformed entries. */
export function parseApprovalState(text: string): ApprovalState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || !Array.isArray(raw.grants) || !Array.isArray(raw.approvals))
    return undefined;
  return {
    version: 1,
    grants: raw.grants.map(parseGrant).filter((g): g is ApprovalGrant => g !== undefined),
    approvals: raw.approvals
      .map(parseApproval)
      .filter((a): a is ApprovalRequest => a !== undefined),
  };
}

/** Keeps every pending approval and the most recently decided ones. */
export function serializeApprovalState(
  grants: readonly ApprovalGrant[],
  approvals: readonly ApprovalRequest[],
): string {
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, MAX_PERSISTED_DECIDED);
  const state: ApprovalState = {
    version: 1,
    grants: [...grants],
    approvals: [...pending, ...decided].sort((a, b) => a.createdAt - b.createdAt),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}
