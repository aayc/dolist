import type { FileEntry } from "../types";
import type { SnapshotEntry } from "./snapshot";

export type SyncDecision =
  | { action: "skip" }
  /** Gone on both sides: drop the snapshot entry. */
  | { action: "forget" }
  /** Copy primary → target; `target` is the version to replace (undefined = must not exist). */
  | { action: "push"; primary: FileEntry; target: FileEntry | undefined }
  /** Copy target → primary; `primary` is the version to replace (undefined = must not exist). */
  | { action: "pull"; target: FileEntry; primary: FileEntry | undefined }
  | { action: "delete-target"; target: FileEntry }
  | { action: "delete-primary"; primary: FileEntry }
  /** Present on both sides and changed on both (or never synced): compare contents. */
  | { action: "reconcile"; primary: FileEntry; target: FileEntry };

/**
 * Three-way decision for one path from the last synced state and both sides' current listing.
 * A path is "changed" on a side when its version differs from the snapshot (or it disappeared).
 * Deletions only propagate against an unchanged side; a delete racing a modification keeps the
 * modified file. Without a snapshot entry nothing is ever deleted.
 */
export function decideSync(
  base: SnapshotEntry | undefined,
  primary: FileEntry | undefined,
  target: FileEntry | undefined,
): SyncDecision {
  if (!base) {
    if (primary && target) return { action: "reconcile", primary, target };
    if (primary) return { action: "push", primary, target: undefined };
    if (target) return { action: "pull", target, primary: undefined };
    return { action: "skip" };
  }
  const primaryChanged = !primary || primary.version !== base.p;
  const targetChanged = !target || target.version !== base.t;
  if (!primaryChanged && !targetChanged) return { action: "skip" };
  if (!targetChanged) {
    return primary
      ? { action: "push", primary, target }
      : { action: "delete-target", target: target! };
  }
  if (!primaryChanged) {
    return target
      ? { action: "pull", target, primary }
      : { action: "delete-primary", primary: primary! };
  }
  if (primary && target) return { action: "reconcile", primary, target };
  if (primary) return { action: "push", primary, target: undefined };
  if (target) return { action: "pull", target, primary: undefined };
  return { action: "forget" };
}
