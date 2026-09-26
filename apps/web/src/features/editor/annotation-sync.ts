import type { TaskAgentRecord } from "@ddl/core";
import { onNextFrame } from "../../lib/frame-loop";
import type { RecordBucket } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { buildAnnotations } from "./annotations";
import type { EditorController } from "./editor-controller";

/**
 * Keeps the editor's agent badges in sync: recomputes on the next frame when the active note's
 * records change (bursts of record events coalesce), and debounced (~150ms) after document edits.
 * Between recomputes the editor maps badge positions through its own transactions, so typing never
 * waits for this.
 */
export class AnnotationSync {
  private readonly editor: EditorController;
  private readonly delayMs: number;
  private activePath: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly scheduleFrame = onNextFrame(() => this.recompute());
  private readonly unsubscribe: () => void;

  constructor(editor: EditorController, delayMs = 150) {
    this.editor = editor;
    this.delayMs = delayMs;
    this.unsubscribe = useAgentStore.subscribe((state, previous) => {
      const path = this.activePath;
      if (path !== null && state.records[path] !== previous.records[path]) this.scheduleFrame();
    });
  }

  setActive(path: string | null): void {
    this.activePath = path;
    this.cancel();
    this.recompute();
  }

  onDocumentEdited(): void {
    if (this.timer !== undefined || !this.hasRecords()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.recompute();
    }, this.delayMs);
  }

  recompute(): void {
    this.cancel();
    const records = this.records();
    if (records.length === 0) {
      this.editor.setAnnotations([]);
      return;
    }
    const doc = this.editor.getDocument();
    if (doc === null) return;
    this.editor.setAnnotations(buildAnnotations(doc, records));
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private bucket(): RecordBucket | undefined {
    return this.activePath === null ? undefined : useAgentStore.getState().records[this.activePath];
  }

  private hasRecords(): boolean {
    const bucket = this.bucket();
    if (!bucket) return false;
    for (const _ in bucket) return true;
    return false;
  }

  private records(): TaskAgentRecord[] {
    const bucket = this.bucket();
    return bucket ? Object.values(bucket) : [];
  }
}
