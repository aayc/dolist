import { afterNextPaint } from "../lib/idle";
import { searchParam } from "../lib/platform";
import { readString, STORAGE_KEYS } from "../lib/storage";

export type PerfMetric =
  | "app:interactive"
  | "daily:open"
  | "daily:prev"
  | "daily:next"
  | "tab:switch"
  | "thread:open"
  | "keystroke";

export interface PerfMeasure {
  name: string;
  duration: number;
  /** Start time (ms since navigation start). */
  ts: number;
  detail?: Record<string, unknown>;
}

export interface LongTaskEntry {
  start: number;
  duration: number;
}

export interface DdlPerfApi {
  measures: PerfMeasure[];
  longTasks: LongTaskEntry[];
  /** True when detailed sampling (keystrokes, long tasks) is on: `?perf=1`. */
  readonly detailed: boolean;
  /** Set once idle prefetching of lazy UI chunks has finished. */
  prefetched: boolean;
  clear(): void;
  mark(name: string): void;
}

declare global {
  interface Window {
    __ddlPerf?: DdlPerfApi;
  }
}

const MAX_MEASURES = 5000;
const measures: PerfMeasure[] = [];
const longTasks: LongTaskEntry[] = [];
const pending = new Map<string, { start: number; detail?: Record<string, unknown> }>();

export const perfDetailed: boolean =
  searchParam("perf") === "1" || readString(STORAGE_KEYS.perf) === "1";

export function recordMeasure(
  name: string,
  start: number,
  end: number,
  detail?: Record<string, unknown>,
): PerfMeasure {
  const measure: PerfMeasure = { name, duration: end - start, ts: start };
  if (detail) measure.detail = detail;
  measures.push(measure);
  if (measures.length > MAX_MEASURES) measures.splice(0, measures.length - MAX_MEASURES);
  if (name !== "keystroke" || perfDetailed) {
    try {
      performance.measure(name, { start, end, detail });
    } catch {
      // Older engines lack the options form; the in-memory record is what matters.
    }
  }
  return measure;
}

/** Starts a pending measurement. `start` defaults to now; pass `event.timeStamp` to include input delay. */
export function perfStart(
  name: PerfMetric,
  start?: number,
  detail?: Record<string, unknown>,
): void {
  pending.set(name, { start: start ?? performance.now(), ...(detail ? { detail } : {}) });
}

export function perfAnnotate(name: PerfMetric, detail: Record<string, unknown>): void {
  const entry = pending.get(name);
  if (entry) entry.detail = { ...entry.detail, ...detail };
}

export function perfPending(name: PerfMetric): boolean {
  return pending.has(name);
}

export function perfCancel(name: PerfMetric): void {
  pending.delete(name);
}

export function perfEnd(name: PerfMetric): PerfMeasure | null {
  const entry = pending.get(name);
  if (!entry) return null;
  pending.delete(name);
  return recordMeasure(name, entry.start, performance.now(), entry.detail);
}

/** Ends a pending measurement once the resulting frame has been painted. */
export function perfEndAfterPaint(name: PerfMetric): void {
  const entry = pending.get(name);
  if (!entry) return;
  afterNextPaint(() => {
    if (pending.get(name) === entry) perfEnd(name);
  });
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
    if (longTasks.length > MAX_MEASURES) longTasks.splice(0, longTasks.length - MAX_MEASURES);
  });
  observer.observe({ type: "longtask", buffered: true });
}

export function installPerfGlobal(): DdlPerfApi {
  const api: DdlPerfApi = {
    measures,
    longTasks,
    detailed: perfDetailed,
    prefetched: false,
    clear() {
      measures.length = 0;
      longTasks.length = 0;
      try {
        performance.clearMeasures();
      } catch {
        // ignore
      }
    },
    mark(name: string) {
      performance.mark(name);
    },
  };
  window.__ddlPerf = api;
  if (perfDetailed) observeLongTasks();
  return api;
}

/**
 * Samples keystroke latency (keydown → next animation frame, i.e. after the editor updated the DOM).
 * Only active with `?perf=1` so production typing pays nothing.
 */
export function installKeystrokeSampler(target: HTMLElement): () => void {
  if (!perfDetailed) return () => {};
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.ctrlKey) return;
    if (event.key.length !== 1 && event.key !== "Enter" && event.key !== "Backspace") return;
    const start = event.timeStamp;
    requestAnimationFrame(() => recordMeasure("keystroke", start, performance.now()));
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}
