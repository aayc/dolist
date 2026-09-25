import type { FrameScheduler } from "../../lib/frame-loop";
import { type BlockMarkdown, ProgressiveMarkdown, placeCaret } from "./progressive-markdown";
import { TypeReveal } from "./reveal";

/**
 * The revealed prefix without a trailing run of emphasis or code delimiters: half of a closing
 * `**` would parse as `*` plus italics for a frame. They show with the next character.
 */
export function withoutTrailingDelimiters(text: string): string {
  return text.replace(/[*_~`]+$/, "");
}

export interface AgentTextDeps {
  /** The whole text as sanitized HTML (cached): history, and a reveal that finished. */
  renderWhole(source: string): string;
  blocks: BlockMarkdown;
  frames: FrameScheduler;
  reducedMotion(): boolean;
}

export interface AgentTextOptions {
  /** Arrived while the thread is on screen: types out from nothing (history shows at once). */
  live: boolean;
  /** Gets `data-streaming` while the text streams in or types out, `data-revealing` while typing. */
  host?: HTMLElement | null;
  /** The text started (true) or finished (false) typing out. */
  onRevealing?(revealing: boolean): void;
  /** The final text is on screen in full. */
  onSettled?(root: HTMLElement): void;
}

/**
 * An agent message's markdown in `root`, driven imperatively (no React render per character).
 * Text that arrives while it's on screen types out at the shared pace with a soft caret at the
 * reveal point, re-rendering at most once per frame; with reduced motion it appears as it arrives.
 */
export class AgentTextView {
  private readonly root: HTMLElement;
  private readonly deps: AgentTextDeps;
  private readonly options: AgentTextOptions;
  private readonly reveal: TypeReveal;
  private readonly caret: HTMLElement;
  private streaming: boolean;
  private progressive: ProgressiveMarkdown | null = null;
  private settled = false;
  private revealing = false;
  private cancelFrames: (() => void) | null = null;
  private lastFrame: number | null = null;

  constructor(
    root: HTMLElement,
    text: string,
    streaming: boolean,
    deps: AgentTextDeps,
    options: AgentTextOptions,
  ) {
    this.root = root;
    this.deps = deps;
    this.options = options;
    this.streaming = streaming;
    this.reveal = new TypeReveal(text, options.live && !deps.reducedMotion() ? 0 : text.length);
    this.caret = root.ownerDocument.createElement("span");
    this.caret.className = "type-caret";
    this.caret.setAttribute("aria-hidden", "true");
    this.paint();
    if (!this.reveal.caughtUp) this.schedule();
  }

  update(text: string, streaming: boolean): void {
    if (text === this.reveal.target && streaming === this.streaming) return;
    this.reveal.update(text);
    this.streaming = streaming;
    if (this.deps.reducedMotion()) this.reveal.finish();
    this.schedule();
  }

  dispose(): void {
    this.cancelFrames?.();
    this.cancelFrames = null;
    this.lastFrame = null;
    this.setRevealing(false);
  }

  private schedule(): void {
    if (this.cancelFrames) return;
    this.cancelFrames = this.deps.frames((now) => this.frame(now));
  }

  private frame(now: number): boolean {
    const dt = this.lastFrame === null ? 0 : (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (this.deps.reducedMotion()) this.reveal.finish();
    else this.reveal.step(dt);
    this.paint();
    if (!this.reveal.caughtUp) return true;
    this.cancelFrames = null;
    this.lastFrame = null;
    return false;
  }

  private paint(): void {
    const done = this.reveal.caughtUp && !this.streaming;
    this.setRevealing(!this.reveal.caughtUp);
    this.options.host?.setAttribute("data-streaming", done ? "false" : "true");
    this.options.host?.setAttribute("data-revealing", this.reveal.caughtUp ? "false" : "true");
    if (done) {
      this.settle();
      return;
    }
    this.settled = false;
    this.progressive ??= new ProgressiveMarkdown(this.root, this.deps.blocks);
    this.caret.remove();
    this.progressive.update(withoutTrailingDelimiters(this.reveal.shown));
    placeCaret(this.root, this.caret);
  }

  /** The final text replaces the revealed prefix exactly: usually the same blocks, kept as is. */
  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.caret.remove();
    const text = this.reveal.target;
    const progressive = this.progressive;
    this.progressive = null;
    if (progressive) progressive.update(text);
    if (!progressive || progressive.approximate) this.root.innerHTML = this.deps.renderWhole(text);
    this.options.onSettled?.(this.root);
  }

  private setRevealing(revealing: boolean): void {
    if (revealing === this.revealing) return;
    this.revealing = revealing;
    this.options.onRevealing?.(revealing);
  }
}
