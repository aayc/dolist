import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { buildAgentLineDecorations } from "./agent-lines";
import { getAnnotations, setAnnotationsEffect } from "./annotations/field";
import { buildLivePreviewDecorations } from "./live-preview/decorations";
import { makeNote, parsedState } from "./test-helpers";
import type { LineAnnotation } from "./types";

/**
 * Keystroke-path budgets (p99, ms), set from local measurements (see README) with 2–5x headroom
 * for CI runners; scale with BENCH_BUDGET_MULTIPLIER on slow machines.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const MULTIPLIER = Number(env?.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = {
  typing500: 500 * MULTIPLIER,
  preview60: 2 * MULTIPLIER,
  preview150: 4 * MULTIPLIER,
  agentLines150: 1 * MULTIPLIER,
};

// Measure the steady state: until a fenced-code language has loaded, lezer skips those blocks and
// re-parses around them on every change (the view re-parses once the language arrives).
await LanguageDescription.matchLanguageName(languages, "ts", true)?.load();

const NOTE = makeNote(2000);
const BASE = parsedState(NOTE);

const TASK_LINES = NOTE.split("\n")
  .map((text, line) => (text.startsWith("- [") ? line : -1))
  .filter((line) => line >= 0);
const ANNOTATIONS: LineAnnotation[] = Array.from({ length: 30 }, (_, i) => ({
  id: `task-${i}`,
  line: TASK_LINES[Math.floor((i * TASK_LINES.length) / 30)] ?? 0,
  status: i % 3 === 0 ? "working" : i % 3 === 1 ? "waiting_approval" : "done",
  label: "Researching…",
  unread: i % 4,
  threadId: `thread-${i}`,
}));
const ANNOTATED = BASE.update({ effects: setAnnotationsEffect.of(ANNOTATIONS) }).state;

/** Types 500 characters at the end of a task line in the middle of the note. */
function type500(start: EditorState): EditorState {
  const at = start.doc.line(1001).to;
  let state = start;
  for (let i = 0; i < 500; i++) {
    state = state.update({
      changes: { from: at + i, insert: "a" },
      selection: { anchor: at + i + 1 },
      userEvent: "input.type",
    }).state;
  }
  return state;
}

function viewport(state: EditorState, firstLine: number, lines: number) {
  return [{ from: state.doc.line(firstLine).from, to: state.doc.line(firstLine + lines - 1).to }];
}

test("typing: 500 single-character inserts, 2k-line note, 30 badges", async ({ bench }) => {
  const typed = type500(ANNOTATED);
  expect(getAnnotations(typed)).toHaveLength(30);
  expect(typed.doc.length).toBe(NOTE.length + 500);

  const result = await bench("typing: 500 single-char inserts, 2k lines, 30 badges", () => {
    type500(ANNOTATED);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.typing500);
});

test("live preview: decorations for a 60-line viewport of a 2k-line note", async ({ bench }) => {
  const state = BASE.update({ selection: { anchor: BASE.doc.line(1030).from + 8 } }).state;
  const ranges = viewport(state, 1000, 60);
  expect(buildLivePreviewDecorations(state, ranges, true).size).toBeGreaterThan(100);

  const result = await bench("live preview: 60-line viewport, 2k lines", () => {
    buildLivePreviewDecorations(state, ranges, true);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.preview60);
});

test("agent lines: decorations for a 150-line viewport, every 4th line the agent's", async ({
  bench,
}) => {
  const doc = NOTE.split("\n")
    .map((line, i) => (i % 4 === 1 ? `${line} %%agent:thr_${i % 7}%%` : line))
    .join("\n");
  const state = parsedState(doc, { selection: { anchor: 0 } });
  const ranges = viewport(state, 960, 150);
  const options = { livePreview: true, focused: true };
  expect(buildAgentLineDecorations(state, ranges, options).size).toBeGreaterThan(60);

  const result = await bench("agent lines: 150-line viewport, 2k lines", () => {
    buildAgentLineDecorations(state, ranges, options);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.agentLines150);
});

test("live preview: decorations for a 150-line rendered viewport", async ({ bench }) => {
  // CodeMirror renders a margin beyond the visible area; this is closer to what it rebuilds.
  const state = BASE.update({ selection: { anchor: BASE.doc.line(1030).from + 8 } }).state;
  const ranges = viewport(state, 960, 150);

  const result = await bench("live preview: 150-line viewport, 2k lines", () => {
    buildLivePreviewDecorations(state, ranges, true);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.preview150);
});
