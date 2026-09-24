import type { Logger, Unsubscribe } from "@ddl/core";
import type { FrameListener } from "../types";

export type Frame = Parameters<FrameListener>[0];
export type FrameAction = NonNullable<Frame["action"]>;

export interface FrameHubOptions {
  /** Called when the listener count goes 0 → 1. */
  onFirst?: () => void;
  /** Called when the listener count goes 1 → 0 through an unsubscribe. */
  onLast?: () => void;
  logger?: Logger;
}

/** Listener set for live surface frames; one failing listener never affects the others. */
export class FrameHub {
  private readonly listeners = new Set<FrameListener>();
  private readonly options: FrameHubOptions;

  constructor(options: FrameHubOptions = {}) {
    this.options = options;
  }

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: FrameListener): Unsubscribe {
    // Wrap so the same function can subscribe twice and unsubscribe independently.
    const entry: FrameListener = (frame) => listener(frame);
    this.listeners.add(entry);
    if (this.listeners.size === 1) this.options.onFirst?.();
    return () => {
      if (!this.listeners.delete(entry)) return;
      if (this.listeners.size === 0) this.options.onLast?.();
    };
  }

  emit(frame: Frame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.options.logger?.warn("frame listener failed", { error: String(error) });
      }
    }
  }

  /** Drops every listener without calling `onLast` (the owner is shutting down). */
  clear(): void {
    this.listeners.clear();
  }
}
