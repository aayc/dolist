import { reportError } from "./report-error";

/** Runs every animation frame until it returns false. */
export type FrameTask = (now: number) => boolean;
/** Starts a task; the function it returns cancels it. */
export type FrameScheduler = (task: FrameTask) => () => void;

const tasks = new Set<FrameTask>();
let pending = 0;

function tick(now: number): void {
  pending = 0;
  for (const task of [...tasks]) {
    if (!tasks.has(task)) continue;
    let again = false;
    try {
      again = task(now);
    } catch (error) {
      reportError(error);
    }
    if (!again) tasks.delete(task);
  }
  if (tasks.size > 0) pending = requestAnimationFrame(tick);
}

/** One `requestAnimationFrame` for every task, and none once nothing animates. */
export const onEveryFrame: FrameScheduler = (task) => {
  tasks.add(task);
  if (!pending) pending = requestAnimationFrame(tick);
  return () => {
    tasks.delete(task);
    if (tasks.size === 0 && pending) {
      cancelAnimationFrame(pending);
      pending = 0;
    }
  };
};

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
