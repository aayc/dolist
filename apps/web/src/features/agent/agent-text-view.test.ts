// @vitest-environment happy-dom
import { Marked, type Token } from "marked";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameScheduler, FrameTask } from "../../lib/frame-loop";
import { type AgentTextDeps, AgentTextView, withoutTrailingDelimiters } from "./agent-text-view";

/** Frames on demand: `advance()` runs one at `now + ms`. */
class ManualFrames {
  readonly tasks = new Set<FrameTask>();
  now = 1000;
  readonly schedule: FrameScheduler = (task) => {
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  };
  advance(ms = 1000 / 60): void {
    this.now += ms;
    for (const task of [...this.tasks]) if (!task(this.now)) this.tasks.delete(task);
  }
  run(max = 10_000): number {
    let frames = 0;
    while (this.tasks.size > 0 && frames < max) {
      this.advance();
      frames++;
    }
    return frames;
  }
}

// DOMPurify needs a real browser; the view only needs some HTML per block.
const marked = new Marked({ gfm: true, breaks: true, async: false });

function setup(options: { reduced?: boolean } = {}) {
  const frames = new ManualFrames();
  let reduced = options.reduced ?? false;
  const rendered: string[] = [];
  const deps: AgentTextDeps = {
    renderWhole: vi.fn((source: string) => marked.parse(source, { async: false })),
    blocks: {
      lex: (source) => marked.lexer(source),
      render: (token: Token) => {
        rendered.push(token.raw);
        return marked.parser([token]);
      },
    },
    frames: frames.schedule,
    reducedMotion: () => reduced,
  };
  const host = document.createElement("div");
  const root = host.appendChild(document.createElement("div"));
  document.body.replaceChildren(host);
  const events = { onRevealing: vi.fn(), onSettled: vi.fn() };
  const view = (text: string, streaming: boolean, live: boolean) =>
    new AgentTextView(root, text, streaming, deps, { live, host, ...events });
  return {
    frames,
    deps,
    host,
    root,
    events,
    rendered,
    view,
    setReduced: (value: boolean) => {
      reduced = value;
    },
  };
}

const caret = (root: HTMLElement) => root.querySelector(".type-caret");
/** The text shown, without the newlines between blocks. */
const textOf = (root: HTMLElement) => (root.textContent ?? "").replace(/\n/g, "");

describe("AgentTextView", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows history at once, rendered whole, with no caret and no frames", () => {
    const { root, host, frames, deps, events, view } = setup();
    view("**Done.** Found three options.", false, false);
    expect(root.innerHTML).toContain("<strong>Done.</strong>");
    expect(deps.renderWhole).toHaveBeenCalledTimes(1);
    expect(caret(root)).toBeNull();
    expect(host.dataset.streaming).toBe("false");
    expect(frames.tasks.size).toBe(0);
    expect(events.onSettled).toHaveBeenCalledWith(root);
    expect(events.onRevealing).not.toHaveBeenCalled();
  });

  it("types a new message out frame by frame, then settles on the final text", () => {
    const { root, host, frames, events, view } = setup();
    view("Picked this up — handing it to a **research** subagent.", false, true);
    expect(textOf(root)).toBe("");
    expect(caret(root)).not.toBeNull();
    expect(host.dataset.streaming).toBe("true");
    expect(events.onRevealing).toHaveBeenLastCalledWith(true);

    frames.advance();
    expect(textOf(root)).toBe("P");
    const lengths = [textOf(root).length];
    for (let i = 0; i < 10; i++) {
      frames.advance();
      lengths.push(textOf(root).length);
    }
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(new Set(lengths).size).toBeGreaterThan(5);
    // The caret sits at the reveal point, inside the paragraph.
    expect(caret(root)?.parentElement?.tagName).toBe("P");

    frames.run();
    expect(textOf(root)).toBe("Picked this up — handing it to a research subagent.");
    expect(root.querySelector("strong")?.textContent).toBe("research");
    expect(caret(root)).toBeNull();
    expect(host.dataset.streaming).toBe("false");
    expect(events.onRevealing).toHaveBeenLastCalledWith(false);
    expect(events.onSettled).toHaveBeenCalledTimes(1);
    expect(frames.tasks.size).toBe(0);
  });

  it("keeps the caret while streaming, idles when caught up, and resumes on the next delta", () => {
    const { root, frames, view } = setup();
    const v = view("", true, true);
    expect(caret(root)).not.toBeNull();
    v.update("Looking", true);
    frames.run();
    expect(textOf(root)).toBe("Looking");
    expect(caret(root)).not.toBeNull();
    expect(frames.tasks.size).toBe(0);

    v.update("Looking into it", true);
    expect(frames.tasks.size).toBe(1);
    frames.run();
    expect(textOf(root)).toBe("Looking into it");
    v.update("Looking into it now.", false);
    frames.run();
    expect(textOf(root)).toBe("Looking into it now.");
    expect(caret(root)).toBeNull();
  });

  it("opened mid-stream: what had arrived shows at once, the rest types out", () => {
    const { root, frames, view } = setup();
    const v = view("Already here.", true, false);
    expect(textOf(root)).toBe("Already here.");
    expect(caret(root)).not.toBeNull();
    v.update("Already here. More", true);
    frames.advance();
    expect(textOf(root)).toBe("Already here. ");
  });

  it("never shows half of a closing delimiter (no flash of the wrong emphasis)", () => {
    const { root, frames, view } = setup();
    view("a **bold** word and `code`", false, true);
    const seen: string[] = [];
    while (frames.tasks.size > 0) {
      frames.advance();
      seen.push(root.innerHTML);
    }
    expect(seen.some((html) => html.includes("<em>"))).toBe(false);
    expect(seen.some((html) => html.includes("<strong>bold</strong>"))).toBe(true);
    expect(root.querySelector("code")?.textContent).toBe("code");
    expect(withoutTrailingDelimiters("a **bold*")).toBe("a **bold");
    expect(withoutTrailingDelimiters("~~gone~~")).toBe("~~gone");
    expect(withoutTrailingDelimiters("plain")).toBe("plain");
  });

  it("re-renders only the block that changed", () => {
    const { frames, rendered, view } = setup();
    const v = view("First paragraph.\n\nSecond", true, false);
    rendered.length = 0;
    v.update("First paragraph.\n\nSecond one grows", true);
    frames.run();
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered.every((raw) => raw.startsWith("Second"))).toBe(true);
  });

  it("with reduced motion, text appears as it arrives (no typing)", () => {
    const { root, frames, events, view } = setup({ reduced: true });
    const v = view("", true, true);
    v.update("A whole sentence arrives at once.", true);
    frames.advance();
    expect(textOf(root)).toBe("A whole sentence arrives at once.");
    expect(frames.tasks.size).toBe(0);
    expect(events.onRevealing).not.toHaveBeenCalledWith(true);
    v.update("A whole sentence arrives at once.", false);
    frames.advance();
    expect(caret(root)).toBeNull();
  });

  it("switching reduced motion on mid-reveal shows the rest at once", () => {
    const { root, frames, view, setReduced } = setup();
    view("A reasonably long reply that would take a moment to type out.", false, true);
    frames.advance();
    setReduced(true);
    frames.advance();
    expect(textOf(root)).toBe("A reasonably long reply that would take a moment to type out.");
  });

  it("renders a raw HTML block whole at the end", () => {
    const { root, frames, deps, view } = setup();
    view("<details>\n\nhidden\n\n</details>", false, true);
    frames.run();
    expect(deps.renderWhole).toHaveBeenCalledTimes(1);
    expect(root.querySelector("details")).not.toBeNull();
  });

  it("stops its frames and reports it's no longer revealing when disposed", () => {
    const { frames, events, view } = setup();
    const v = view("Going away mid-reveal", false, true);
    frames.advance();
    v.dispose();
    expect(frames.tasks.size).toBe(0);
    expect(events.onRevealing).toHaveBeenLastCalledWith(false);
  });
});
