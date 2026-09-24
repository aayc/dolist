/**
 * The app's tooltip: one element and a few document-level listeners, so any element (React or a
 * CodeMirror widget) gets the same animated tooltip by declaring it with data attributes:
 *
 * - `data-tooltip`: the text;
 * - `data-command`: a command whose shortcut shows as keycaps, looked up when it shows;
 * - `data-tooltip-keys`: a named key that isn't a command instead (see `KEYS`);
 * - `data-tooltip-overflow`: only while truncated: the element itself, or the descendants that
 *   the value selects;
 * - `data-tooltip-placement`, on the element or an ancestor: `bottom` in top toolbars, `right`
 *   beside a left rail, else above. It flips when there isn't room.
 *
 * 500 ms of hover (or keyboard focus) opens it. For 300 ms after it hides, the next target shows
 * at once and the tooltip glides there. A mouse or key press, a scroll that moves the target, a
 * drag, leaving the window or the target going away hide it at once; touch and pen never show it.
 * Keydown only hides, and positions are measured once per show.
 */

export const OPEN_DELAY_MS = 500;
export const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TooltipKeys {
  /** Keycaps of a command's shortcut; null without one. */
  command(id: string): readonly string[] | null;
  /** Keycaps of a named key; null if unknown. */
  named(name: string): readonly string[] | null;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Where a `width`×`height` tooltip goes: on `side` of `anchor` if it fits, else the other side. */
export function placeTooltip(
  anchor: TooltipRect,
  width: number,
  height: number,
  side: TooltipSide,
  viewport: { width: number; height: number },
): { x: number; y: number; side: TooltipSide } {
  const vertical = side === "top" || side === "bottom";
  const [start, end, size, room] = vertical
    ? [anchor.top, anchor.bottom, height, viewport.height]
    : [anchor.left, anchor.right, width, viewport.width];
  const before = start - GAP - size;
  const after = end + GAP;
  const fitsBefore = before >= MARGIN;
  const fitsAfter = after + size <= room - MARGIN;
  const useAfter =
    side === "bottom" || side === "right" ? fitsAfter || !fitsBefore : !fitsBefore && fitsAfter;
  const main = Math.round(clamp(useAfter ? after : before, MARGIN, room - MARGIN - size));
  const cross = Math.round(
    vertical
      ? clamp((anchor.left + anchor.right - width) / 2, MARGIN, viewport.width - MARGIN - width)
      : clamp((anchor.top + anchor.bottom - height) / 2, MARGIN, viewport.height - MARGIN - height),
  );
  return vertical
    ? { x: cross, y: main, side: useAfter ? "bottom" : "top" }
    : { x: main, y: cross, side: useAfter ? "right" : "left" };
}

function truncated(el: Element): boolean {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

function wanted(el: HTMLElement): boolean {
  const overflow = el.dataset.tooltipOverflow;
  if (overflow === undefined) return true;
  return overflow ? [...el.querySelectorAll(overflow)].some(truncated) : truncated(el);
}

/** Keycaps as tooltips, the palette and hints show them: `<span class="keycaps"><kbd>⌘</kbd>…`. */
export function renderKeycaps(doc: Document, keys: readonly string[]): HTMLElement {
  const group = doc.createElement("span");
  group.className = "keycaps";
  for (const key of keys) group.appendChild(doc.createElement("kbd")).textContent = key;
  return group;
}

export function installTooltips(keys: TooltipKeys, doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  let tip: HTMLElement | null = null;
  /** The hovered or focused element whose tooltip is pending or showing. */
  let target: HTMLElement | null = null;
  let shown = false;
  let warm = false;
  /** Pressed or typed on: no tooltip until the pointer or focus leaves it. */
  let suppressed: HTMLElement | null = null;
  let described: HTMLElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  const removal = new MutationObserver(() => {
    if (target && !target.isConnected) hideNow();
  });

  const targetOf = (node: EventTarget | null) =>
    (node as Element | null)?.closest?.<HTMLElement>("[data-tooltip]") ?? null;

  function quiet(): void {
    clearTimeout(openTimer);
    described?.removeAttribute("aria-describedby");
    described = null;
    removal.disconnect();
    target = null;
  }

  function hideNow(): void {
    quiet();
    clearTimeout(warmTimer);
    shown = warm = false;
    if (tip) {
      tip.hidden = true;
      tip.className = "tooltip";
    }
  }

  /** The pointer or focus left: fade out, and show the next target at once for a moment. */
  function leave(): void {
    quiet();
    if (!shown || !tip) return;
    shown = false;
    warm = true;
    tip.className = "tooltip is-hiding";
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      warm = false;
      if (tip) tip.hidden = true;
    }, WARM_MS);
  }

  function show(next: HTMLElement): void {
    const text = next.dataset.tooltip;
    const disabled = next.matches(":disabled,[aria-disabled=true]");
    if (!text || !next.isConnected || disabled || !wanted(next)) {
      leave();
      return;
    }
    if (!tip) {
      tip = doc.body.appendChild(doc.createElement("div"));
      tip.id = "ddl-tooltip";
      tip.setAttribute("role", "tooltip");
      tip.hidden = true;
    }
    const label = doc.createElement("span");
    label.className = "tooltip-text";
    text.split("/").forEach((part, i) => {
      if (i > 0) label.append("/", doc.createElement("wbr"));
      label.append(part);
    });
    const { command, tooltipKeys } = next.dataset;
    const caps = (command && keys.command(command)) || (tooltipKeys && keys.named(tooltipKeys));
    tip.replaceChildren(label);
    if (caps) tip.append(renderKeycaps(doc, caps));

    const glide = !tip.hidden && !win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const side = next.closest<HTMLElement>("[data-tooltip-placement]")?.dataset.tooltipPlacement;
    tip.hidden = false;
    if (!glide) tip.className = "tooltip";
    const place = placeTooltip(
      next.getBoundingClientRect(),
      tip.offsetWidth,
      tip.offsetHeight,
      (side as TooltipSide | undefined) ?? "top",
      { width: win.innerWidth, height: win.innerHeight },
    );
    tip.dataset.side = place.side;
    tip.style.translate = `${place.x}px ${place.y}px`;
    // The entrance must start from this side's offset: apply it before the transition begins.
    if (!glide) tip.getBoundingClientRect();
    tip.className = glide ? "tooltip is-visible is-gliding" : "tooltip is-visible";
    shown = true;
    warm = false;
    clearTimeout(warmTimer);
    // Described only by what the element doesn't already say (a truncated text is all there).
    if (
      !next.hasAttribute("aria-label") &&
      !next.hasAttribute("aria-describedby") &&
      !next.textContent?.includes(text)
    ) {
      next.setAttribute("aria-describedby", tip.id);
      described = next;
    }
    removal.observe(doc.body, { childList: true, subtree: true });
  }

  function schedule(next: HTMLElement): void {
    if (next === target) return;
    quiet();
    target = next;
    if (shown || warm) show(next);
    else openTimer = setTimeout(() => show(next), OPEN_DELAY_MS);
  }

  function dismiss(): void {
    if (!target && !warm) return;
    if (target) suppressed = target;
    hideNow();
  }

  const listeners: Array<[EventTarget, string, (event: never) => void, boolean]> = [
    [
      doc,
      "pointerover",
      (event: PointerEvent) => {
        const next = targetOf(event.target);
        if (event.pointerType === "mouse" && !event.buttons && next && next !== suppressed) {
          schedule(next);
        }
      },
      true,
    ],
    [
      doc,
      "pointerout",
      (event: PointerEvent) => {
        const from = targetOf(event.target);
        const to = targetOf(event.relatedTarget);
        if (from === to) return;
        if (from === suppressed) suppressed = null;
        if (from === target && !to) leave();
      },
      true,
    ],
    [
      doc,
      "focusin",
      (event: FocusEvent) => {
        const el = event.target as HTMLElement;
        if (el !== suppressed && el.matches?.("[data-tooltip]:focus-visible")) schedule(el);
      },
      true,
    ],
    [
      doc,
      "focusout",
      (event: FocusEvent) => {
        if (event.target === suppressed) suppressed = null;
        if (event.target === target) leave();
      },
      true,
    ],
    [
      doc,
      "scroll",
      (event: Event) => {
        if (target && (event.target as Node).contains(target)) hideNow();
      },
      true,
    ],
    [doc, "pointerdown", dismiss, true],
    [doc, "keydown", dismiss, true],
    [doc, "dragstart", dismiss, true],
    [win, "blur", dismiss, false],
  ];
  for (const [on, type, listener, capture] of listeners) {
    on.addEventListener(type, listener as EventListener, capture);
  }
  return () => {
    hideNow();
    for (const [on, type, listener, capture] of listeners) {
      on.removeEventListener(type, listener as EventListener, capture);
    }
    tip?.remove();
  };
}
