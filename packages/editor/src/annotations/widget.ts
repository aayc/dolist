import { type EditorView, WidgetType } from "@codemirror/view";
import type { TaskAgentStatus } from "@ddl/core";
import { editorCallbacks } from "../callbacks";
import type { LineAnnotation } from "../types";

interface StatusMeta {
  /** Text glyph shown instead of the dot (empty = CSS dot). */
  glyph: string;
  /** Spoken status, used in the badge's accessible name. */
  spoken: string;
}

export const STATUS_META: Record<TaskAgentStatus, StatusMeta> = {
  idle: { glyph: "", spoken: "Idle" },
  triaging: { glyph: "", spoken: "Agent is triaging" },
  queued: { glyph: "", spoken: "Queued for the agent" },
  working: { glyph: "", spoken: "Agent is working" },
  // U+FE0E keeps the warning sign in text (not emoji) presentation.
  waiting_approval: { glyph: "\u26A0\uFE0E", spoken: "Needs your approval" },
  waiting_user: { glyph: "?", spoken: "Waiting for your reply" },
  done: { glyph: "\u2713", spoken: "Done" },
  failed: { glyph: "\u2715", spoken: "Failed" },
  cancelled: { glyph: "\u2013", spoken: "Cancelled" },
  ignored: { glyph: "", spoken: "Ignored" },
};

export function sameAnnotation(a: LineAnnotation, b: LineAnnotation): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.label === b.label &&
    a.unread === b.unread &&
    a.threadId === b.threadId
  );
}

function unreadText(unread: number): string {
  if (!(unread > 0)) return "";
  return unread > 99 ? "99+" : String(Math.floor(unread));
}

function accessibleName(a: LineAnnotation): string {
  const unread = a.unread > 0 ? `, ${unreadText(a.unread)} unread` : "";
  return `${STATUS_META[a.status].spoken}: ${a.label}${unread}. Open agent thread`;
}

interface BadgeDom {
  icon: HTMLElement;
  label: HTMLElement;
  unread: HTMLElement;
  annotation: LineAnnotation;
}

const badgeDom = new WeakMap<HTMLElement, BadgeDom>();

function render(root: HTMLElement, parts: BadgeDom, a: LineAnnotation): void {
  root.className = `cm-ddl-badge cm-ddl-badge-${a.status}`;
  root.title = a.label;
  root.setAttribute("aria-label", accessibleName(a));
  parts.icon.textContent = STATUS_META[a.status].glyph;
  parts.label.textContent = a.label;
  parts.unread.textContent = unreadText(a.unread);
  parts.unread.hidden = !(a.unread > 0);
  parts.annotation = a;
}

/** Agent status pill rendered after the last character of a task line. */
export class BadgeWidget extends WidgetType {
  readonly annotation: LineAnnotation;

  constructor(annotation: LineAnnotation) {
    super();
    this.annotation = annotation;
  }

  override eq(other: BadgeWidget): boolean {
    return sameAnnotation(this.annotation, other.annotation);
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const root = doc.createElement("span");
    root.setAttribute("role", "button");
    root.tabIndex = 0;
    const part = (name: string, hidden: boolean) => {
      const el = root.appendChild(doc.createElement("span"));
      el.className = `cm-ddl-badge-${name}`;
      if (hidden) el.setAttribute("aria-hidden", "true");
      return el;
    };
    const parts: BadgeDom = {
      icon: part("icon", true),
      label: part("label", false),
      unread: part("unread", true),
      annotation: this.annotation,
    };
    badgeDom.set(root, parts);
    render(root, parts, this.annotation);

    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      view.state.facet(editorCallbacks).onAnnotationClick?.(parts.annotation);
    };
    // Keep the caret where it is: the badge is not part of the text.
    root.addEventListener("mousedown", (event) => event.preventDefault());
    root.addEventListener("click", activate);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    return root;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const parts = badgeDom.get(dom);
    if (!parts) return false;
    render(dom, parts, this.annotation);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
