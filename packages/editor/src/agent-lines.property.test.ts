import type { DecorationSet } from "@codemirror/view";
import { parseAgentLine } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { AgentSparkleWidget, buildAgentLineDecorations } from "./agent-lines";
import { buildLivePreviewDecorations } from "./live-preview/decorations";
import { markdownLine, selectionIn, toSelection } from "./test-arbitraries";
import { parsedState } from "./test-helpers";

const marker = fc.constantFrom(" %%agent:thr_1%%", " %%agent%%", "%%agent:a-b_c%%", " %%agent%%  ");

/** Random markdown where some lines end with an agent marker. */
const agentDoc = fc
  .array(fc.tuple(markdownLine, fc.option(marker, { nil: undefined })), { maxLength: 20 })
  .map((lines) => lines.map(([line, mark]) => (mark ? line + mark : line)).join("\n"));

interface Replaced {
  from: number;
  to: number;
}

function replaced(set: DecorationSet): Replaced[] {
  const out: Replaced[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { widget?: unknown; class?: string };
    if (spec.widget !== undefined || spec.class === undefined) {
      out.push({ from: cursor.from, to: cursor.to });
    }
  }
  return out;
}

describe("agent line decorations (properties)", () => {
  test.prop([agentDoc.chain((doc) => fc.tuple(fc.constant(doc), selectionIn(doc.length)))])(
    "mark exactly the agent lines and never overlap what the live preview replaces",
    ([doc, selection]) => {
      const state = parsedState(doc, { selection: toSelection(selection) });
      const ranges = [{ from: 0, to: doc.length }];
      for (const focused of [false, true]) {
        const agent = buildAgentLineDecorations(state, ranges, { livePreview: true, focused });
        const preview = buildLivePreviewDecorations(state, ranges, focused);
        const lines: number[] = [];
        for (const cursor = agent.iter(); cursor.value; cursor.next()) {
          if (cursor.from === cursor.to) lines.push(state.doc.lineAt(cursor.from).number);
          else if (cursor.value.spec.widget instanceof AgentSparkleWidget) {
            expect(state.sliceDoc(cursor.from, cursor.to)).toMatch(/^%%agent/);
            expect(cursor.to).toBe(state.doc.lineAt(cursor.from).to);
          }
        }
        const expected: number[] = [];
        for (let n = 1; n <= state.doc.lines; n++) {
          if (parseAgentLine(state.doc.line(n).text)) expected.push(n);
        }
        expect(lines).toEqual(expected);
        for (const a of replaced(agent)) {
          for (const p of replaced(preview)) {
            expect(a.from < p.to && p.from < a.to, `${a.from}-${a.to} vs ${p.from}-${p.to}`).toBe(
              false,
            );
          }
        }
      }
    },
  );
});
