// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTooltips,
  OPEN_DELAY_MS,
  placeTooltip,
  type TooltipKeys,
  WARM_MS,
} from "./tooltips";

const VIEWPORT = { width: 1000, height: 800 };
const rect = (left: number, top: number, width = 28, height = 28) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("placeTooltip", () => {
  it("puts the tooltip 6px from the target on the preferred side, centered", () => {
    expect(placeTooltip(rect(100, 100), 80, 26, "bottom", VIEWPORT)).toEqual({
      x: 74,
      y: 134,
      side: "bottom",
    });
    expect(placeTooltip(rect(100, 100), 80, 26, "top", VIEWPORT)).toEqual({
      x: 74,
      y: 68,
      side: "top",
    });
    expect(placeTooltip(rect(100, 100), 80, 26, "right", VIEWPORT)).toEqual({
      x: 134,
      y: 101,
      side: "right",
    });
  });

  it("flips to the other side when there isn't room", () => {
    // Too close to the bottom edge for "below".
    expect(placeTooltip(rect(100, 760), 80, 26, "bottom", VIEWPORT).side).toBe("top");
    // Too close to the top edge for "above".
    expect(placeTooltip(rect(100, 10), 80, 26, "top", VIEWPORT)).toMatchObject({
      side: "bottom",
      y: 44,
    });
    // Too close to the right edge for "right".
    expect(placeTooltip(rect(950, 100), 80, 26, "right", VIEWPORT)).toMatchObject({
      side: "left",
      x: 864,
    });
  });

  it("keeps the preferred side when neither fits, clamped to the viewport", () => {
    expect(placeTooltip(rect(100, 10, 28, 780), 80, 26, "top", VIEWPORT)).toMatchObject({
      side: "top",
      y: 8,
    });
  });

  it("clamps to the viewport with an 8px margin", () => {
    expect(placeTooltip(rect(0, 100), 120, 26, "bottom", VIEWPORT).x).toBe(8);
    expect(placeTooltip(rect(990, 100, 10), 120, 26, "top", VIEWPORT).x).toBe(872);
    expect(placeTooltip(rect(10, 790, 28, 10), 80, 26, "right", VIEWPORT).y).toBe(766);
  });

  it("rounds to whole pixels so text stays crisp", () => {
    const { x, y } = placeTooltip(rect(100.3, 100.6, 27.5, 27.7), 80.4, 25.9, "bottom", VIEWPORT);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });
});

describe("the tooltip layer", () => {
  let uninstall: () => void;
  let reducedMotion = false;
  const keys: TooltipKeys = {
    command: (id) => (id === "note:new" ? ["⌘", "N"] : null),
    named: (name) => (name === "enter" ? ["↩"] : null),
  };

  const tooltip = () => document.getElementById("ddl-tooltip");
  const visible = () => tooltip()?.classList.contains("is-visible") === true;
  const text = () => tooltip()?.querySelector(".tooltip-text")?.textContent;
  const caps = () => [...(tooltip()?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent);

  function add(html: string): HTMLElement {
    document.body.insertAdjacentHTML("beforeend", html);
    return document.body.lastElementChild as HTMLElement;
  }

  function pointer(
    type: string,
    target: Element,
    init: { pointerType?: string; buttons?: number; relatedTarget?: Element | null } = {},
  ): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType: init.pointerType ?? "mouse",
        buttons: init.buttons ?? 0,
        relatedTarget: init.relatedTarget ?? null,
      }),
    );
  }

  /** The pointer moves from `from` (or nowhere) onto `to` (or nowhere). */
  function move(from: Element | null, to: Element | null): void {
    if (from) pointer("pointerout", from, { relatedTarget: to });
    if (to) pointer("pointerover", to, { relatedTarget: from });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("reduce") && reducedMotion,
          media: query,
        }) as MediaQueryList,
    );
    uninstall = installTooltips(keys);
  });

  afterEach(() => {
    uninstall();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("opens after 500 ms of hover, with its text and the command's keycaps", () => {
    const button = add(`<button data-tooltip="New note" data-command="note:new">+</button>`);
    move(null, button);
    vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(visible()).toBe(true);
    expect(tooltip()?.getAttribute("role")).toBe("tooltip");
    expect(text()).toBe("New note");
    expect(caps()).toEqual(["⌘", "N"]);
    expect(tooltip()?.style.translate).toMatch(/px/);
  });

  it("doesn't restart the delay while the pointer moves inside the target", () => {
    const button = add(`<button data-tooltip="Send"><svg></svg></button>`);
    move(null, button);
    vi.advanceTimersByTime(300);
    move(button, button.firstElementChild);
    vi.advanceTimersByTime(OPEN_DELAY_MS - 300);
    expect(visible()).toBe(true);
  });

  it("shows named keys that aren't commands, and nothing for unknown ones", () => {
    const send = add(`<button data-tooltip="Send" data-tooltip-keys="enter">→</button>`);
    move(null, send);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(caps()).toEqual(["↩"]);
    const other = add(`<button data-tooltip="Close" data-command="nope">x</button>`);
    move(send, other);
    expect(text()).toBe("Close");
    expect(caps()).toEqual([]);
  });

  it("warms up: the next target shows at once and the tooltip glides there", () => {
    const [a, b] = [
      add(`<button data-tooltip="A">a</button>`),
      add(`<button data-tooltip="B">b</button>`),
    ];
    move(null, a);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(tooltip()?.className).toBe("tooltip is-visible");
    // Straight onto the neighbor.
    move(a, b);
    expect(text()).toBe("B");
    expect(tooltip()?.className).toBe("tooltip is-visible is-gliding");
  });

  it("fades out on leave, and a target reached within the warm window shows at once", () => {
    const [a, b] = [
      add(`<button data-tooltip="A">a</button>`),
      add(`<button data-tooltip="B">b</button>`),
    ];
    move(null, a);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    move(a, null);
    expect(tooltip()?.className).toBe("tooltip is-hiding");
    vi.advanceTimersByTime(WARM_MS - 50);
    move(null, b);
    expect(text()).toBe("B");
    expect(tooltip()?.className).toBe("tooltip is-visible is-gliding");
  });

  it("goes cold after the warm window: the next target waits for the delay again", () => {
    const [a, b] = [
      add(`<button data-tooltip="A">a</button>`),
      add(`<button data-tooltip="B">b</button>`),
    ];
    move(null, a);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    move(a, null);
    vi.advanceTimersByTime(WARM_MS);
    expect(tooltip()?.hidden).toBe(true);
    move(null, b);
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(text()).toBe("B");
    expect(tooltip()?.className).toBe("tooltip is-visible");
  });

  it("only fades (never glides) with reduced motion", () => {
    reducedMotion = true;
    const [a, b] = [
      add(`<button data-tooltip="A">a</button>`),
      add(`<button data-tooltip="B">b</button>`),
    ];
    move(null, a);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    move(a, b);
    expect(text()).toBe("B");
    expect(tooltip()?.className).toBe("tooltip is-visible");
  });

  it.each([
    ["a mouse press", (target: Element) => pointer("pointerdown", target)],
    ["a key press", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))],
    ["leaving the window", () => window.dispatchEvent(new Event("blur"))],
    [
      "a drag",
      (target: Element) => target.dispatchEvent(new Event("dragstart", { bubbles: true })),
    ],
  ])("hides at once on %s, and the target stays quiet until the pointer leaves it", (_, act) => {
    const button = add(`<button data-tooltip="New note">+</button>`);
    move(null, button);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    act(button);
    expect(tooltip()?.hidden).toBe(true);
    expect(tooltip()?.className).toBe("tooltip");
    // Still over it: no tooltip, however long.
    pointer("pointerover", button);
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2);
    expect(visible()).toBe(false);
    // Leaving and coming back is a fresh, cold hover.
    move(button, null);
    move(null, button);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(visible()).toBe(true);
  });

  it("cancels a pending tooltip on a press", () => {
    const button = add(`<button data-tooltip="New note">+</button>`);
    move(null, button);
    vi.advanceTimersByTime(200);
    pointer("pointerdown", button);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(visible()).toBe(false);
  });

  it("hides when something scrolls the target away, not for unrelated scrolling", () => {
    const pane = add(`<div><button data-tooltip="Row">row</button></div>`);
    const other = add(`<div class="chat"></div>`);
    const button = pane.firstElementChild as HTMLElement;
    move(null, button);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    other.dispatchEvent(new Event("scroll"));
    expect(visible()).toBe(true);
    pane.dispatchEvent(new Event("scroll"));
    expect(tooltip()?.hidden).toBe(true);
  });

  it("hides when its target goes away", async () => {
    const button = add(`<button data-tooltip="Stop">■</button>`);
    move(null, button);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    button.remove();
    await Promise.resolve();
    expect(tooltip()?.hidden).toBe(true);
  });

  it("ignores touch and pen, and never opens while a mouse button is held", () => {
    const button = add(`<button data-tooltip="New note">+</button>`);
    pointer("pointerover", button, { pointerType: "touch" });
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    pointer("pointerover", button, { pointerType: "pen" });
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    pointer("pointerover", button, { buttons: 1 });
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it("shows overflow tooltips only while the text is cut off", () => {
    const tab = add(
      `<div role="tab" data-tooltip="Projects/Quarterly plans.md" data-tooltip-overflow=".title"><span class="title">Quarterly plans</span></div>`,
    );
    const title = tab.firstElementChild as HTMLElement;
    let scrollWidth = 90;
    Object.defineProperty(title, "clientWidth", { value: 100 });
    Object.defineProperty(title, "scrollWidth", { get: () => scrollWidth });
    move(null, tab);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(visible()).toBe(false);
    move(tab, null);
    scrollWidth = 140;
    move(null, tab);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(visible()).toBe(true);
    // Paths may wrap after their slashes.
    expect(tooltip()?.querySelector(".tooltip-text")?.innerHTML).toBe(
      "Projects/<wbr>Quarterly plans.md",
    );
  });

  it("measures the element itself for an empty overflow attribute", () => {
    const title = add(
      `<h2 data-tooltip="A long thread title" data-tooltip-overflow="">A long…</h2>`,
    );
    Object.defineProperty(title, "clientHeight", { value: 36 });
    Object.defineProperty(title, "scrollHeight", { value: 54 });
    move(null, title);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(text()).toBe("A long thread title");
  });

  it("never shows for disabled controls or empty text", () => {
    const disabled = add(`<button data-tooltip="Next daily note" disabled>›</button>`);
    const empty = add(`<span data-tooltip="">vault</span>`);
    move(null, disabled);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    move(disabled, empty);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(visible()).toBe(false);
  });

  it("opens for keyboard focus after the delay and closes when focus leaves", () => {
    const button = add(`<button data-tooltip="Search vault">⌕</button>`);
    button.focus();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(text()).toBe("Search vault");
    button.blur();
    expect(tooltip()?.className).toBe("tooltip is-hiding");
  });

  it("takes its side from the nearest placement attribute, above by default", () => {
    const bar = add(
      `<div data-tooltip-placement="bottom"><button data-tooltip="Toggle agent panel">▯</button></div>`,
    );
    move(null, bar.firstElementChild);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(tooltip()?.dataset.side).toBe("bottom");
    const status = add(`<button data-tooltip="Vim mode">NORMAL</button>`);
    status.getBoundingClientRect = () => new DOMRect(100, 400, 60, 20);
    move(bar.firstElementChild, status);
    expect(tooltip()?.dataset.side).toBe("top");
  });

  it("describes its target only with what the target doesn't already say", () => {
    const agent = add(
      `<button data-tooltip="The agent is paused — click to resume">Agent paused</button>`,
    );
    move(null, agent);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(agent.getAttribute("aria-describedby")).toBe("ddl-tooltip");
    const labelled = add(`<button aria-label="New note" data-tooltip="New note">+</button>`);
    move(agent, labelled);
    expect(agent.hasAttribute("aria-describedby")).toBe(false);
    expect(labelled.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps one tooltip element for every target", () => {
    const [a, b] = [
      add(`<button data-tooltip="A">a</button>`),
      add(`<button data-tooltip="B">b</button>`),
    ];
    move(null, a);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    move(a, b);
    expect(document.querySelectorAll("[role=tooltip]")).toHaveLength(1);
  });
});
