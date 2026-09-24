/**
 * Lines the agent wrote end with an Obsidian comment naming their thread (`%%agent:thr_1%%`, see
 * `@ddl/core`'s agent-text). They are drawn in the agent text color in both modes. The live
 * preview hides the marker behind a ✦ glyph that opens the thread, and reveals it (faint) while
 * the selection is on the line, like block syntax; source mode shows it faint.
 */
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { parseAgentLine } from "@ddl/core";
import { editorCallbacks } from "./callbacks";
import type { VisibleRange } from "./live-preview/decorations";
import { hasFocusWithin, livePreviewEnabled } from "./live-preview/plugin";

export const AGENT_SPARKLE_TITLE = "Written by the agent — open thread";
const AGENT_SPARKLE_TITLE_NO_THREAD = "Written by the agent";

const AGENT_LINE = Decoration.line({ class: "cm-ddl-agent-line" });
const AGENT_MARKER = Decoration.mark({ class: "cm-ddl-agent-marker" });
const MAX_CACHED_SPARKLES = 256;
const sparkles = new Map<string, Decoration>();

/** The ✦ that stands in for a hidden agent marker. */
export class AgentSparkleWidget extends WidgetType {
  readonly threadId: string | null;

  constructor(threadId: string | null) {
    super();
    this.threadId = threadId;
  }

  override eq(other: AgentSparkleWidget): boolean {
    return other.threadId === this.threadId;
  }

  toDOM(view: EditorView): HTMLElement {
    const glyph = view.dom.ownerDocument.createElement("span");
    glyph.className = "cm-ddl-agent-sparkle";
    glyph.textContent = "✦";
    const { threadId } = this;
    // `data-tooltip` is shown by the host's tooltip layer.
    if (threadId === null) {
      glyph.dataset.tooltip = AGENT_SPARKLE_TITLE_NO_THREAD;
      glyph.setAttribute("aria-label", AGENT_SPARKLE_TITLE_NO_THREAD);
      glyph.setAttribute("role", "img");
      return glyph;
    }
    glyph.classList.add("cm-ddl-agent-sparkle-link");
    glyph.dataset.tooltip = AGENT_SPARKLE_TITLE;
    glyph.setAttribute("aria-label", AGENT_SPARKLE_TITLE);
    glyph.setAttribute("role", "button");
    // Keep the caret where it is: the glyph is not part of the text.
    glyph.addEventListener("mousedown", (event) => event.preventDefault());
    glyph.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.state.facet(editorCallbacks).onAgentLineClick?.(threadId);
    });
    return glyph;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function sparkle(threadId: string | null): Decoration {
  const key = threadId ?? "";
  let deco = sparkles.get(key);
  if (!deco) {
    if (sparkles.size >= MAX_CACHED_SPARKLES) sparkles.clear();
    deco = Decoration.replace({ widget: new AgentSparkleWidget(threadId) });
    sparkles.set(key, deco);
  }
  return deco;
}

function skipBlanks(text: string, from: number): number {
  let pos = from;
  while (text[pos] === " " || text[pos] === "\t") pos++;
  return pos;
}

export interface AgentLineOptions {
  livePreview: boolean;
  /** Without focus nothing is revealed (there is no visible caret). */
  focused: boolean;
}

/** Agent line decorations for the visible ranges. Pure, like the live preview builder. */
export function buildAgentLineDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  options: AgentLineOptions,
): DecorationSet {
  const { doc } = state;
  const selection = options.focused ? state.selection.ranges : [];
  const ranges: Range<Decoration>[] = [];
  let lastLine = 0;
  for (const range of visibleRanges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = Math.max(first, lastLine + 1); n <= last; n++) {
      const line = doc.line(n);
      const agent = parseAgentLine(line.text);
      if (!agent) continue;
      ranges.push(AGENT_LINE.range(line.from));
      // From the `%%`: the blanks before it may belong to syntax the live preview hides (`# `).
      const from = line.from + skipBlanks(line.text, agent.markerFrom);
      const revealed =
        !options.livePreview || selection.some((r) => r.from <= line.to && r.to >= line.from);
      ranges.push((revealed ? AGENT_MARKER : sparkle(agent.threadId)).range(from, line.to));
    }
    lastLine = Math.max(lastLine, last);
  }
  return Decoration.set(ranges, true);
}

function build(view: EditorView): DecorationSet {
  return buildAgentLineDecorations(view.state, view.visibleRanges, {
    livePreview: view.state.facet(livePreviewEnabled),
    focused: hasFocusWithin(view),
  });
}

const agentLinesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.focusChanged ||
        (update.selectionSet && update.state.facet(livePreviewEnabled)) ||
        update.transactions.some((tr) => tr.reconfigured)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Text typed at or after an agent marker goes in front of it, so the marker stays at the end of
 * its line. (With the marker hidden, clicking the end of an agent line puts the caret after it.)
 * Only single, one-line insertions are moved; anything else is left as typed.
 */
function keepMarkerLast(tr: Transaction): Transaction | TransactionSpec {
  if (!tr.docChanged || !tr.isUserEvent("input") || tr.isUserEvent("input.type.compose")) {
    return tr;
  }
  if (tr.effects.length > 0) return tr;
  let changes = 0;
  let at = -1;
  let text = "";
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes++;
    if (fromA === toA) {
      at = fromA;
      text = inserted.toString();
    }
  });
  if (changes !== 1 || at < 0 || text === "" || text.includes("\n")) return tr;
  const line = tr.startState.doc.lineAt(at);
  const agent = parseAgentLine(line.text);
  if (!agent) return tr;
  const markerStart = line.from + skipBlanks(line.text, agent.markerFrom);
  if (at < markerStart) return tr;
  // Before the blank that separates the text from the marker, so a typed space stays a space.
  const target = markerStart > line.from + agent.markerFrom ? markerStart - 1 : markerStart;
  const shift = target - at;
  const end = at + text.length;
  const selection = tr.newSelection;
  if (shift === 0 || selection.ranges.some((r) => r.from < at || r.to > end)) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes: { from: target, insert: text },
    selection: EditorSelection.create(
      selection.ranges.map((r) => EditorSelection.range(r.anchor + shift, r.head + shift)),
      selection.mainIndex,
    ),
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent === undefined ? {} : { userEvent }),
  };
}

export const agentLines: Extension = [
  agentLinesPlugin,
  EditorState.transactionFilter.of(keepMarkerLast),
];
