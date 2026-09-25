import { type EditorView, WidgetType } from "@codemirror/view";
import { editorCallbacks } from "../callbacks";
import type { ActivityChip } from "../types";

const ENTER_CLASS = "cm-ddl-badge-enter";

export function sameChip(a: ActivityChip, b: ActivityChip): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.tooltip === b.tooltip &&
    a.tone === b.tone &&
    Boolean(a.pulse) === Boolean(b.pulse) &&
    Boolean(a.fading) === Boolean(b.fading) &&
    a.kind === b.kind
  );
}

/** Styled like a badge (`cm-ddl-badge` and its tones), with a dot and an optional label. */
export function chipClassName(chip: ActivityChip): string {
  return [
    "cm-ddl-badge",
    `cm-ddl-badge-tone-${chip.tone}`,
    "cm-ddl-activity-chip",
    chip.label ? "" : "cm-ddl-activity-chip-dot",
    chip.pulse ? "cm-ddl-activity-chip-pulse" : "",
    chip.fading ? "cm-ddl-activity-chip-fading" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface ChipDom {
  label: HTMLElement;
  chip: ActivityChip;
  entering: boolean;
}

const chipDom = new WeakMap<HTMLElement, ChipDom>();

function render(root: HTMLElement, parts: ChipDom, chip: ActivityChip): void {
  root.className = `${chipClassName(chip)}${parts.entering ? ` ${ENTER_CLASS}` : ""}`;
  root.dataset.tooltip = chip.tooltip;
  root.setAttribute("aria-label", chip.tooltip);
  if (chip.kind) root.dataset.kind = chip.kind;
  else delete root.dataset.kind;
  parts.label.textContent = chip.label;
  parts.label.hidden = chip.label === "";
  parts.chip = chip;
}

/**
 * What the orchestrator is doing about a line, after the line's last character (and after its
 * badge, when it has one). Updates reuse the DOM, so a dot turning into a label doesn't re-enter.
 */
export class ActivityChipWidget extends WidgetType {
  readonly chip: ActivityChip;
  private enter: boolean;

  constructor(chip: ActivityChip, enter = false) {
    super();
    this.chip = chip;
    this.enter = enter;
  }

  override eq(other: ActivityChipWidget): boolean {
    return sameChip(this.chip, other.chip);
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const root = doc.createElement("span");
    root.setAttribute("role", "button");
    root.tabIndex = 0;
    const icon = root.appendChild(doc.createElement("span"));
    icon.className = "cm-ddl-badge-icon";
    icon.setAttribute("aria-hidden", "true");
    const label = root.appendChild(doc.createElement("span"));
    label.className = "cm-ddl-badge-label";
    const parts: ChipDom = { label, chip: this.chip, entering: this.enter };
    this.enter = false;
    chipDom.set(root, parts);
    render(root, parts, this.chip);

    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      view.state.facet(editorCallbacks).onActivityChipClick?.(parts.chip);
    };
    root.addEventListener("mousedown", (event) => event.preventDefault());
    root.addEventListener("click", activate);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    root.addEventListener("animationend", (event) => {
      if (event.target !== root || !parts.entering) return;
      parts.entering = false;
      root.classList.remove(ENTER_CLASS);
    });
    return root;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const parts = chipDom.get(dom);
    if (!parts) return false;
    render(dom, parts, this.chip);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
