import type { Token, TokensList } from "marked";

export interface BlockMarkdown {
  lex(source: string): TokensList;
  /** Sanitized HTML for one top-level block. */
  render(token: Token): string;
}

interface Block {
  key: string;
  nodes: ChildNode[];
}

/**
 * Renders a growing markdown text into `root` block by block. Each update re-lexes the text (cheap)
 * and re-renders only the blocks that changed since the last one, usually just the last: text that
 * types out costs one block per frame, however long the message.
 */
export class ProgressiveMarkdown {
  private readonly root: HTMLElement;
  private readonly md: BlockMarkdown;
  private blocks: Block[] = [];
  private source = "";
  private html = false;

  constructor(root: HTMLElement, md: BlockMarkdown) {
    this.root = root;
    this.md = md;
    root.replaceChildren();
  }

  /** The text rendered last. */
  get rendered(): string {
    return this.source;
  }

  /**
   * Raw HTML blocks are sanitized one at a time here, so a tag opened in one block and closed in
   * another nests differently than in a whole-text render.
   */
  get approximate(): boolean {
    return this.html;
  }

  update(source: string): void {
    if (source === this.source && this.blocks.length > 0) return;
    this.source = source;
    const tokens = this.md.lex(source);
    // A link definition changes how earlier blocks resolve `[text][ref]`.
    const refs = Object.keys(tokens.links ?? {})
      .sort()
      .join("\n");
    const visible = tokens.filter((token) => token.type !== "space");
    const keys = visible.map((token) => `${token.type}\u0001${token.raw}\u0001${refs}`);
    let same = 0;
    while (same < visible.length && this.blocks[same]?.key === keys[same]) same++;
    for (const block of this.blocks.splice(same)) {
      for (const node of block.nodes) node.remove();
    }
    const doc = this.root.ownerDocument;
    for (let i = same; i < visible.length; i++) {
      const template = doc.createElement("template");
      template.innerHTML = this.md.render(visible[i]!);
      const nodes = [...template.content.childNodes];
      this.root.append(template.content);
      this.blocks.push({ key: keys[i]!, nodes });
    }
    this.html = visible.some((token) => token.type === "html");
  }
}

/** Puts `caret` right after the last character in `root` (inside its paragraph, item or code). */
export function placeCaret(root: HTMLElement, caret: HTMLElement): void {
  let block = root.lastChild;
  while (block && (block === caret || isBlank(block))) block = block.previousSibling;
  const text = block ? lastText(block, caret) : null;
  if (text) text.after(caret);
  else root.append(caret);
}

function isBlank(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node as Text).data.trim() === "";
}

function lastText(node: Node, skip: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return isBlank(node) ? null : (node as Text);
  for (let child = node.lastChild; child; child = child.previousSibling) {
    if (child === skip) continue;
    const found = lastText(child, skip);
    if (found) return found;
  }
  return null;
}
