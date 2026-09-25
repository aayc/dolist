import type { OrchestratorActivity } from "@ddl/core";
import { create } from "zustand";
import {
  type ActivityView,
  EMPTY_ACTIVITY,
  expireChips,
  nextChipChange,
  reduceActivity,
} from "../features/editor/activity-chips";

interface ActivityStoreState extends ActivityView {
  /** Bumped when a chip starts fading, so views redraw it. */
  tick: number;
}

/** What the orchestrator is doing (`orchestrator.activity`), for the editor's chips and indicators. */
export const useActivityStore = create<ActivityStoreState>(() => ({ ...EMPTY_ACTIVITY, tick: 0 }));

let events = 0;
let keys = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const newKey = () => `chip_${++keys}`;

/** One `orchestrator.activity` event. */
export function applyActivity(activity: OrchestratorActivity, now = Date.now()): void {
  events++;
  const state = useActivityStore.getState();
  useActivityStore.setState(reduceActivity(expireChips(state, now), activity, now, newKey));
  schedule(now);
}

/** How many events arrived so far: a status fetched before one of them is older than it. */
export function activityEventCount(): number {
  return events;
}

/**
 * The activity in an agent status fetched when `eventsBefore` events had arrived (at startup and
 * after a reconnect): it applies unless a newer event arrived meanwhile.
 */
export function seedActivity(
  activity: OrchestratorActivity | undefined,
  eventsBefore: number,
): void {
  if (events !== eventsBefore) return;
  applyActivity(activity ?? { phase: "idle" });
}

function schedule(now: number): void {
  clearTimeout(timer);
  const next = nextChipChange(useActivityStore.getState(), now);
  if (next === null) return;
  timer = setTimeout(() => {
    const at = Date.now();
    const state = useActivityStore.getState();
    useActivityStore.setState({ ...expireChips(state, at), tick: state.tick + 1 });
    schedule(at);
  }, next - now);
}

/** Test helper. */
export function resetActivityStore(): void {
  clearTimeout(timer);
  events = 0;
  keys = 0;
  useActivityStore.setState({ ...EMPTY_ACTIVITY, tick: 0 }, true);
}
