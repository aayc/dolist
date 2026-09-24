import { type EditorView, WidgetType } from "@codemirror/view";
import type { TaskAgentStatus } from "@ddl/core";
import { editorCallbacks } from "../callbacks";
import type { LineAnnotation } from "../types";

/** Spoken status, used in the badge's accessible name. */
const SPOKEN_STATUS: Record<TaskAgentStatus, string> = {
  idle: "Idle",
  triaging: "Agent is triaging",
  queued: "Queued for the agent",
  working: "Agent is working",
  waiting_approval: "Needs your approval",
  waiting_user: "Waiting for your reply",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  ignored: "Ignored",
};

/**
 * Visual weight of a badge: only what needs the user is loud, failures are tinted, work in
 * progress is a neutral pill and finished work is quiet text.
 */
export type BadgeTone = "needs-you" | "failed" | "working" | "quiet";

export function badgeTone(status: TaskAgentStatus): BadgeTone {
  switch (status) {
    case "waiting_approval":
    case "waiting_user":
      return "needs-you";
    case "failed":
      return "failed";
    case "triaging":
    case "queued":
    case "working":
      return "working";
    case "done":
    case "cancelled":
    case "idle":
    case "ignored":
      return "quiet";
  }
}

/** The status class colors the dot; the tone class sets fill, border and text. */
export function badgeClassName(status: TaskAgentStatus): string {
  return `cm-ddl-badge cm-ddl-badge-${status} cm-ddl-badge-tone-${badgeTone(status)}`;
}

const ENTER_CLASS = "cm-ddl-badge-enter";

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
  return `${SPOKEN_STATUS[a.status]}: ${a.label}${unread}. Open agent thread`;
}

interface BadgeDom {
  label: HTMLElement;
  unread: HTMLElement;
  annotation: LineAnnotation;
  /** Until its appear animation ends; a badge moved in the DOM later must not replay it. */
  entering: boolean;
}

const badgeDom = new WeakMap<HTMLElement, BadgeDom>();

function render(root: HTMLElement, parts: BadgeDom, a: LineAnnotation): void {
  const className = badgeClassName(a.status);
  root.className = parts.entering ? `${className} ${ENTER_CLASS}` : className;
  const unread = unreadText(a.unread);
  root.title = unread ? `${a.label} (${unread} unread)` : a.label;
  root.setAttribute("aria-label", accessibleName(a));
  parts.label.textContent = a.label;
  parts.unread.hidden = !unread;
  parts.annotation = a;
}

/**
 * Agent status pill rendered after the last character of a task line. Updates (status, label,
 * unread) reuse the DOM through `updateDOM`, so only a badge that just appeared animates in.
 */
export class BadgeWidget extends WidgetType {
  readonly annotation: LineAnnotation;
  /** Plays the appear animation, on the first draw only (not after scrolling back to it). */
  private enter: boolean;

  constructor(annotation: LineAnnotation, enter = false) {
    super();
    this.annotation = annotation;
    this.enter = enter;
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
    part("icon", true);
    const parts: BadgeDom = {
      label: part("label", false),
      unread: part("unread", true),
      annotation: this.annotation,
      entering: this.enter,
    };
    this.enter = false;
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
    root.addEventListener("animationend", (event) => {
      if (event.target !== root || !parts.entering) return;
      parts.entering = false;
      root.classList.remove(ENTER_CLASS);
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
