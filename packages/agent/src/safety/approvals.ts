/**
 * The approval broker: turns `require_approval` verdicts into pending approval requests, waits
 * for the user's decision (or a timeout / abort), and records standing grants for "approve for
 * this task" and "always approve". With a storage provider, grants and recent approvals persist
 * in the vault sidecar (`createApprovalStateFile`: a corrupt file is moved aside and a newer one
 * never overwritten, both loading as no state); approvals left pending by a previous process load
 * as `expired`.
 */
import type {
  ApprovalDecisionRequest,
  ApprovalRequest,
  ApprovalScope,
  ApprovalStatus,
  Unsubscribe,
} from "@ddl/core";
import { createId, DEFAULT_SETTINGS, debounce, silentLogger } from "@ddl/core";
import { type ApprovalState, createApprovalStateFile, mergeApprovalStates } from "./approval-store";
import { riskRank } from "./policy";
import type {
  ApprovalBroker,
  ApprovalBrokerOptions,
  ApprovalGrant,
  ApprovalOutcome,
  GrantQuery,
  NewApproval,
  PendingApproval,
} from "./types";

export class ApprovalNotFoundError extends Error {
  readonly approvalId: string;

  constructor(approvalId: string) {
    super(`Approval ${approvalId} not found`);
    this.name = "ApprovalNotFoundError";
    this.approvalId = approvalId;
  }
}

/** Thrown when deciding an approval that is no longer pending. */
export class ApprovalStateError extends Error {
  readonly approvalId: string;
  readonly status: ApprovalStatus;

  constructor(approvalId: string, status: ApprovalStatus) {
    super(`Approval ${approvalId} is already ${status}`);
    this.name = "ApprovalStateError";
    this.approvalId = approvalId;
    this.status = status;
  }
}

export interface PersistentApprovalBroker extends ApprovalBroker {
  /** Settles once persisted state has been loaded (immediately without storage). */
  readonly ready: Promise<void>;
  /** Writes pending state changes now. */
  flush(): Promise<void>;
  /** Stops timers and flushes. Pending requests stay pending (and load as expired next time). */
  dispose(): Promise<void>;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_DECIDED_IN_MEMORY = 500;
const PERSIST_DEBOUNCE_MS = 250;

interface Waiter {
  resolve(outcome: ApprovalOutcome): void;
  cleanup(): void;
}

const isComputerTool = (toolName: string) => toolName.startsWith("computer_");

/**
 * A grant covers its own tool, and one made in an app covers every computer action in that app:
 * allowing a click in Grok Bot for the task lets the agent type there too. The category and risk
 * checks still apply, so a Return, a send or a payment asks again.
 */
function coversTool(grant: ApprovalGrant, query: GrantQuery): boolean {
  if (grant.toolName === query.toolName) return true;
  return (
    grant.target !== undefined && isComputerTool(grant.toolName) && isComputerTool(query.toolName)
  );
}

function sameGrant(a: ApprovalGrant, b: ApprovalGrant): boolean {
  return (
    a.toolName === b.toolName &&
    a.scope === b.scope &&
    a.taskId === b.taskId &&
    a.risk === b.risk &&
    a.target === b.target &&
    JSON.stringify([...(a.categories ?? [])].sort()) ===
      JSON.stringify([...(b.categories ?? [])].sort())
  );
}

export function createApprovalBroker(
  options: ApprovalBrokerOptions = {},
): PersistentApprovalBroker {
  const { storage } = options;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SETTINGS.agent.approvalTimeoutMs;
  const approvals = new Map<string, ApprovalRequest>();
  const waiters = new Map<string, Waiter>();
  /** Targets of pending approvals (grants made from them are scoped to it). */
  const targets = new Map<string, string>();
  /** Pending approvals asked only because the approval policy asks (the evaluator allowed them). */
  const policyOnly = new Set<string>();
  const grants: ApprovalGrant[] = [];
  const listeners = new Set<(approval: ApprovalRequest) => void>();

  const emit = (approval: ApprovalRequest) => {
    for (const listener of [...listeners]) {
      try {
        listener(approval);
      } catch (error) {
        logger.warn("approval listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const file = storage ? createApprovalStateFile({ storage, logger, now }) : undefined;
  /**
   * What another writer saved (a sync, a hand edit), seen when a write conflicted. Written back
   * merged with ours so nothing it holds is lost, but never honored before the next load: grants
   * and decisions apply only once loaded, and a live approval is decided only here.
   */
  let external: ApprovalState | undefined;
  const ready: Promise<void> = file
    ? file
        .load()
        .then(adopt)
        .catch((error: unknown) => {
          logger.warn("failed to load approvals state", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
    : Promise.resolve();
  let writes: Promise<void> = ready;

  function adopt(state: ApprovalState | undefined): void {
    if (!state) return;
    for (const grant of state.grants)
      if (!grants.some((g) => sameGrant(g, grant))) grants.unshift(grant);
    let expired = 0;
    for (const approval of state.approvals) {
      if (approvals.has(approval.id)) continue;
      if (approval.status !== "pending") {
        approvals.set(approval.id, approval);
        continue;
      }
      // Its agent died with the previous process; nobody is waiting for this decision anymore.
      const stale: ApprovalRequest = {
        ...approval,
        status: "expired",
        decidedAt: now(),
        decisionNote: "The app restarted before a decision was made.",
      };
      approvals.set(approval.id, stale);
      expired++;
      emit(stale);
    }
    if (expired > 0) schedulePersist();
  }

  async function persist(): Promise<void> {
    await file?.save(
      () => {
        const ours: ApprovalState = { version: 1, grants, approvals: [...approvals.values()] };
        return external ? mergeApprovalStates(ours, external) : ours;
      },
      (theirs) => {
        external = theirs;
      },
    );
  }

  const persistSoon = debounce(() => {
    writes = writes.then(persist);
  }, PERSIST_DEBOUNCE_MS);

  function schedulePersist(): void {
    if (file) persistSoon();
  }

  async function flush(): Promise<void> {
    await ready;
    persistSoon.flush();
    await writes;
  }

  function trimHistory(): void {
    const decided = [...approvals.values()].filter((a) => a.status !== "pending");
    const excess = decided.length - MAX_DECIDED_IN_MEMORY;
    if (excess <= 0) return;
    decided.sort((a, b) => (a.decidedAt ?? a.createdAt) - (b.decidedAt ?? b.createdAt));
    for (const old of decided.slice(0, excess)) approvals.delete(old.id);
  }

  function finish(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    note?: string,
    scope?: ApprovalScope,
  ): ApprovalRequest | undefined {
    const current = approvals.get(id);
    if (current?.status !== "pending") return current;
    const decided: ApprovalRequest = {
      ...current,
      status,
      decidedAt: now(),
      ...(scope ? { scope } : {}),
      ...(note ? { decisionNote: note } : {}),
    };
    approvals.set(id, decided);
    targets.delete(id);
    policyOnly.delete(id);
    const waiter = waiters.get(id);
    waiters.delete(id);
    waiter?.cleanup();
    emit(decided);
    trimHistory();
    schedulePersist();
    waiter?.resolve({
      approved: status === "approved",
      request: decided,
      ...(note ? { note } : {}),
    });
    return decided;
  }

  function addGrant(approval: ApprovalRequest, scope: Exclude<ApprovalScope, "once">): void {
    const target = targets.get(approval.id);
    const grant: ApprovalGrant = {
      toolName: approval.toolName,
      scope,
      taskId: scope === "task" ? approval.taskId : null,
      createdAt: now(),
      categories: [...approval.categories],
      risk: approval.risk,
      ...(target ? { target } : {}),
    };
    if (!grants.some((g) => sameGrant(g, grant))) grants.push(grant);
  }

  return {
    ready,

    request(input: NewApproval, signal?: AbortSignal): Promise<ApprovalOutcome> {
      const createdAt = now();
      const requested = [input.timeoutMs, defaultTimeoutMs].find(
        (ms): ms is number => typeof ms === "number" && !Number.isNaN(ms),
      );
      const timeoutMs = Math.min(
        Math.max(1, Math.round(requested ?? DEFAULT_SETTINGS.agent.approvalTimeoutMs)),
        MAX_TIMER_MS,
      );
      const approval: ApprovalRequest = {
        id: createId("apr"),
        threadId: input.threadId,
        taskId: input.taskId,
        toolName: input.toolName,
        ...(input.toolLabel ? { toolLabel: input.toolLabel } : {}),
        input: input.input,
        summary: input.summary,
        risk: input.risk,
        categories: [...input.categories],
        reason: input.reason,
        status: "pending",
        createdAt,
        expiresAt: createdAt + timeoutMs,
      };
      let resolve!: (outcome: ApprovalOutcome) => void;
      const outcome = new Promise<ApprovalOutcome>((r) => {
        resolve = r;
      });
      const timer = setTimeout(
        () => finish(approval.id, "expired", "No decision before the approval timed out."),
        timeoutMs,
      );
      (timer as { unref?: () => void }).unref?.();
      const onAbort = () =>
        finish(approval.id, "cancelled", "The agent stopped before a decision was made.");
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.set(approval.id, {
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      approvals.set(approval.id, approval);
      if (input.target) targets.set(approval.id, input.target);
      if (input.verdict === "allow") policyOnly.add(approval.id);
      emit(approval);
      schedulePersist();
      if (signal?.aborted) onAbort();
      return outcome;
    },

    async decide(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
      const current = approvals.get(id);
      if (!current) throw new ApprovalNotFoundError(id);
      if (current.status !== "pending") throw new ApprovalStateError(id, current.status);
      if (decision.decision !== "approve" && decision.decision !== "deny") {
        throw new TypeError(`Invalid approval decision: ${String(decision.decision)}`);
      }
      const note =
        typeof decision.note === "string" && decision.note.trim()
          ? decision.note.trim().slice(0, 1000)
          : undefined;
      if (decision.decision === "deny") return finish(id, "denied", note)!;
      const requested = decision.scope ?? "once";
      if (requested !== "once" && requested !== "task" && requested !== "always") {
        throw new TypeError(`Invalid approval scope: ${String(requested)}`);
      }
      // A task grant needs a task to attach to; otherwise the approval only covers this call.
      const scope: ApprovalScope =
        requested === "task" && current.taskId === null ? "once" : requested;
      if (scope !== "once") addGrant(current, scope);
      return finish(id, "approved", note, scope)!;
    },

    get(id: string): ApprovalRequest | undefined {
      return approvals.get(id);
    },

    list(
      filter: { status?: ApprovalStatus; threadId?: string; taskId?: string } = {},
    ): ApprovalRequest[] {
      return [...approvals.values()]
        .filter(
          (a) =>
            (filter.status === undefined || a.status === filter.status) &&
            (filter.threadId === undefined || a.threadId === filter.threadId) &&
            (filter.taskId === undefined || a.taskId === filter.taskId),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    findGrant(query: GrantQuery): ApprovalGrant | undefined {
      for (let i = grants.length - 1; i >= 0; i--) {
        const grant = grants[i]!;
        if (!coversTool(grant, query)) continue;
        if (grant.scope === "task" && (query.taskId === null || grant.taskId !== query.taskId))
          continue;
        // Approving "Press Send in Grok Bot" says nothing about WhatsApp, or the whole screen.
        if ((grant.target ?? undefined) !== (query.target ?? undefined)) continue;
        if (
          query.categories &&
          grant.categories &&
          !query.categories.every((c) => grant.categories!.includes(c))
        )
          continue;
        if (query.risk && grant.risk && riskRank(query.risk) > riskRank(grant.risk)) continue;
        return grant;
      }
      return undefined;
    },

    cancelForTask(taskId: string, reason: string): void {
      for (const approval of [...approvals.values()]) {
        if (approval.taskId === taskId && approval.status === "pending")
          finish(approval.id, "cancelled", reason);
      }
    },

    approvePending(
      approves: (pending: PendingApproval) => boolean,
      note: string,
    ): ApprovalRequest[] {
      const approved: ApprovalRequest[] = [];
      for (const request of [...approvals.values()]) {
        if (request.status !== "pending") continue;
        const verdict = policyOnly.has(request.id) ? "allow" : "require_approval";
        if (!approves({ request, verdict })) continue;
        const decided = finish(request.id, "approved", note, "once");
        if (decided) approved.push(decided);
      }
      return approved;
    },

    onUpsert(listener: (approval: ApprovalRequest) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flush,

    async dispose(): Promise<void> {
      // Release waiting agents; the records stay pending on disk and load as expired next time.
      for (const [id, waiter] of waiters) {
        waiter.cleanup();
        const request = approvals.get(id);
        if (request)
          waiter.resolve({ approved: false, request, note: "The app is shutting down." });
      }
      waiters.clear();
      await flush();
    },
  };
}
