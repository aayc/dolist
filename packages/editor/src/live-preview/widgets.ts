import { type EditorView, WidgetType } from "@codemirror/view";
import { toggleTaskAtPos } from "../commands/tasks";
import { isDoneStatusChar } from "../task-lines";

/** Task checkbox replacing `- [ ]` (or just `[ ]` in ordered lists). */
export class CheckboxWidget extends WidgetType {
  readonly statusChar: string;
  readonly readOnly: boolean;

  constructor(statusChar: string, readOnly: boolean) {
    super();
    this.statusChar = statusChar;
    this.readOnly = readOnly;
  }

  override eq(other: CheckboxWidget): boolean {
    return other.statusChar === this.statusChar && other.readOnly === this.readOnly;
  }

  /**
   * An ARIA checkbox rather than `<input type="checkbox">`: a native input takes focus when clicked
   * (stealing keystrokes from the editor) and toggles itself, while the document is the source of
   * truth. Keyboard users toggle with Mod-Enter / Mod-l on the line.
   */
  toDOM(view: EditorView): HTMLElement {
    const box = view.dom.ownerDocument.createElement("span");
    box.className = "cm-ddl-checkbox";
    box.setAttribute("role", "checkbox");
    this.sync(box);
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (event.button === 0) toggleTaskAtPos(view, view.posAtDOM(box));
    });
    return box;
  }

  override updateDOM(dom: HTMLElement): boolean {
    if (dom.getAttribute("role") !== "checkbox") return false;
    this.sync(dom);
    return true;
  }

  private sync(box: HTMLElement): void {
    const ch = this.statusChar;
    box.setAttribute("aria-checked", ch === " " ? "false" : ch === "/" ? "mixed" : "true");
    box.setAttribute(
      "aria-label",
      isDoneStatusChar(ch) ? "Mark task as not done" : "Mark task as done",
    );
    box.setAttribute("aria-disabled", String(this.readOnly));
    box.dataset.task = ch;
    box.classList.toggle("cm-ddl-checkbox-readonly", this.readOnly);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Dot replacing a `-`/`*`/`+` bullet list marker. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "cm-ddl-bullet";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  // Let clicks through so they place the caret (which reveals the marker).
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Horizontal rule replacing `---` / `***` / `___`. */
export class HorizontalRuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "cm-ddl-hr";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
