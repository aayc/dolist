import { onNextFrame } from "../../lib/frame-loop";
import { useActivityStore } from "../../state/activity-store";
import { placeChips } from "./activity-chips";
import type { EditorController } from "./editor-controller";

/**
 * Keeps the editor's activity chips in step with what the orchestrator is doing: recomputes on the
 * next frame when the active note's chips change (or start fading), and when another note is shown.
 * Edits never trigger it: the editor maps chips through its own transactions, and drops a chip
 * whose line is edited beyond recognition.
 */
export class ActivitySync {
  private readonly editor: EditorController;
  private activePath: string | null = null;
  private readonly scheduleFrame = onNextFrame(() => this.recompute());
  private readonly unsubscribe: () => void;

  constructor(editor: EditorController) {
    this.editor = editor;
    this.unsubscribe = useActivityStore.subscribe((state, previous) => {
      if (this.activePath === null) return;
      if (state.chips === previous.chips && state.tick === previous.tick) return;
      const path = this.activePath;
      const mine = (chips: typeof state.chips) => chips.some((c) => c.notePath === path);
      if (mine(state.chips) || mine(previous.chips)) this.scheduleFrame();
    });
  }

  setActive(path: string | null): void {
    this.activePath = path;
    this.recompute();
  }

  recompute(): void {
    const path = this.activePath;
    const entries =
      path === null ? [] : useActivityStore.getState().chips.filter((c) => c.notePath === path);
    if (entries.length === 0) {
      this.editor.setActivityChips([]);
      return;
    }
    const doc = this.editor.getDocument();
    if (doc === null) return;
    const mapped = new Map(this.editor.activityChips().map((chip) => [chip.id, chip.line]));
    this.editor.setActivityChips(placeChips(entries, doc.split("\n"), mapped, Date.now()));
  }

  dispose(): void {
    this.unsubscribe();
  }
}
