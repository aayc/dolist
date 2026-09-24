/**
 * HarnessSession over a Pi AgentSession. Prompts are serialized through one drain loop so Pi never
 * sees overlapping `prompt()` calls; steering is handed to Pi's queue while a run streams, and
 * anything still queued in Pi when a run settles is replayed as the next prompt.
 */
import { type Deferred, deferred, type Logger } from "@ddl/core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessEvent, HarnessSession } from "../types";
import { PiEventMapper } from "./events";
import type { ToolCallLedger } from "./ledger";

interface PendingPrompt {
  text: string;
  /** Absent for messages replayed from Pi's queue (their callers were already answered). */
  done?: Deferred<void>;
}

/** Shared with the gate extension so tool calls are refused once the session is closed. */
export interface SessionLifecycle {
  closed: boolean;
}

export interface PiHarnessSessionInit {
  id: string;
  session: AgentSession;
  ledger: ToolCallLedger;
  lifecycle: SessionLifecycle;
  logger: Logger;
  onEvent?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
}

export class PiHarnessSession implements HarnessSession {
  readonly id: string;
  private readonly pi: AgentSession;
  private readonly ledger: ToolCallLedger;
  private readonly lifecycle: SessionLifecycle;
  private readonly logger: Logger;
  private readonly onEvent: ((event: HarnessEvent) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly mapper: PiEventMapper;
  private readonly unsubscribe: () => void;
  private readonly pending: PendingPrompt[] = [];
  private draining = false;
  private currentRun: Promise<Error | undefined> | undefined;
  private runSeq = 0;
  private abortedRunSeq = -1;
  private runSettled = false;
  private disposing: Promise<void> | undefined;

  constructor(init: PiHarnessSessionInit) {
    this.id = init.id;
    this.pi = init.session;
    this.ledger = init.ledger;
    this.lifecycle = init.lifecycle;
    this.logger = init.logger;
    this.onEvent = init.onEvent;
    this.signal = init.signal;
    this.mapper = new PiEventMapper({ ledger: init.ledger });
    this.unsubscribe = this.pi.subscribe((event) => this.handle(event));
    this.signal?.addEventListener("abort", this.onSignalAbort, { once: true });
  }

  get isRunning(): boolean {
    return this.draining;
  }

  prompt(text: string): Promise<void> {
    if (this.lifecycle.closed) return Promise.resolve();
    const done = deferred<void>();
    this.pending.push({ text, done });
    this.kick();
    return done.promise;
  }

  async steer(text: string): Promise<void> {
    if (this.lifecycle.closed) return;
    if (!this.draining) return this.prompt(text);
    await this.pi.steer(text);
    // The run may have settled while the message was being queued; replay it instead.
    if (!this.draining) {
      this.reclaimQueued();
      this.kick();
    }
  }

  async abort(): Promise<void> {
    if (this.lifecycle.closed) return;
    this.abortedRunSeq = this.runSeq;
    this.pi.clearQueue();
    await this.pi.abort();
  }

  dispose(): Promise<void> {
    this.disposing ??= this.close();
    return this.disposing;
  }

  private readonly onSignalAbort = (): void => {
    void this.dispose();
  };

  private async close(): Promise<void> {
    this.lifecycle.closed = true;
    this.signal?.removeEventListener("abort", this.onSignalAbort);
    for (const item of this.pending.splice(0)) item.done?.resolve();
    try {
      this.pi.clearQueue();
      await this.pi.abort();
      await this.currentRun;
    } catch (error) {
      this.logger.warn("error while closing session", { error: messageOf(error) });
    } finally {
      this.unsubscribe();
      this.pi.dispose();
      this.ledger.clear();
    }
  }

  private kick(): void {
    if (this.draining || this.lifecycle.closed) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        this.reclaimQueued();
        const next = this.lifecycle.closed ? undefined : this.pending.shift();
        if (!next) return;
        this.currentRun = this.run(next);
        const failure = await this.currentRun;
        this.currentRun = undefined;
        // Clear the running flag before answering so an awaiting caller sees the settled state.
        const settled = this.pending.length === 0 && this.pi.pendingMessageCount === 0;
        if (settled) this.draining = false;
        if (failure) next.done?.reject(failure);
        else next.done?.resolve();
        if (settled) return;
      }
    } finally {
      this.currentRun = undefined;
      this.draining = false;
    }
  }

  /** Moves messages left in Pi's steering/follow-up queues (Pi is idle here) to our queue. */
  private reclaimQueued(): void {
    if (this.pi.pendingMessageCount === 0) return;
    const { steering, followUp } = this.pi.clearQueue();
    this.pending.unshift(...[...steering, ...followUp].map((text) => ({ text })));
  }

  /** Resolves with the error when Pi refused the prompt; model errors arrive as events instead. */
  private async run(item: PendingPrompt): Promise<Error | undefined> {
    this.runSeq++;
    this.runSettled = false;
    try {
      await this.pi.prompt(item.text, { expandPromptTemplates: false, source: "rpc" });
      return undefined;
    } catch (error) {
      const message = messageOf(error);
      this.logger.warn("prompt rejected", { error: message });
      this.emit({ type: "error", message });
      if (!this.runSettled) this.emit({ type: "idle" });
      return error instanceof Error ? error : new Error(message);
    }
  }

  private handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        // An abort requested before Pi started streaming this run would otherwise be lost.
        if (this.lifecycle.closed || this.abortedRunSeq === this.runSeq) void this.pi.abort();
        break;
      case "agent_settled":
        this.runSettled = true;
        break;
      case "auto_retry_start":
        this.logger.warn("retrying model request", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;
      case "compaction_end":
        if (event.errorMessage)
          this.logger.warn("context compaction failed", { error: event.errorMessage });
        break;
    }
    for (const mapped of this.mapper.map(event)) this.emit(mapped);
  }

  private emit(event: HarnessEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.logger.warn("onEvent listener threw", { event: event.type, error: messageOf(error) });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
