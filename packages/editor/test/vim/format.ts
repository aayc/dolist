/**
 * The `vectors.jsonl` format (see README.md): types shared by the Node scripts and the Chromium
 * pages, plus the canonical serialization that keeps the committed file stable.
 */

export const VECTORS_FORMAT = "ddl-vim-vectors";
export const VECTORS_VERSION = 1;
/**
 * The oracle's geometry: 20 rows of 20px lines, no wrapping, laid out in the generated oracle font
 * (scripts/oracle-font.ts) whose glyph box is `textHeight` tall and `charWidth` wide.
 */
export const VIEWPORT = {
  rows: 20,
  lineHeight: 20,
  wrap: false,
  textHeight: 18,
  charWidth: 9.6015625,
} as const;
export const DEFAULT_OPTIONS = { tabSize: 4, indentUnit: "\t" } as const;

export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line" | "visual-block";

/** `[line, ch]` is a cursor, `[anchorLine, anchorCh, headLine, headCh]` a range. */
export type SelectionRange = [number, number] | [number, number, number, number];

export interface RegisterValue {
  text: string;
  linewise: boolean;
  blockwise: boolean;
}

export interface EditorOptions {
  tabSize?: number;
  indentUnit?: string;
}

export type VimOptionValue = string | number | boolean;

export type ApiOp =
  | "setCursor"
  | "setSelections"
  | "setValue"
  | "replaceRange"
  | "setOption"
  | "vimSetOption"
  | "map"
  | "noremap"
  | "unmap"
  | "mapclear"
  | "setRegister"
  | "pushText"
  | "ex";

export interface ApiCall {
  op: ApiOp;
  args: unknown[];
}

export interface PromptState {
  prefix: string;
  text: string;
}

export interface ExpectedState {
  doc: string;
  selection: SelectionRange[];
  primary?: number;
  mode: VimMode;
  registers?: Record<string, RegisterValue>;
  prompt?: PromptState;
  message?: string;
  scrollTop?: number;
}

/** A step before the oracle filled in its expectation. */
export type StepSpec = { keys: string[] } | { api: ApiCall };

export type VectorStep = StepSpec & { expect: ExpectedState };

interface CaseFields {
  name: string;
  origin: string;
  doc: string;
  selection: SelectionRange[];
  primary?: number;
  options?: EditorOptions;
  vim?: Record<string, VimOptionValue>;
  registers?: Record<string, RegisterValue>;
  scrollTop?: number;
}

/** A case as authored by the catalog or recorded from upstream: steps without expectations. */
export interface CaseSpec extends CaseFields {
  steps: StepSpec[];
}

export interface VectorCase extends CaseFields {
  steps: VectorStep[];
}

export interface VectorHeader {
  format: typeof VECTORS_FORMAT;
  version: typeof VECTORS_VERSION;
  engine: string;
  viewport: typeof VIEWPORT;
  defaults: typeof DEFAULT_OPTIONS;
}

export function createHeader(engine: string): VectorHeader {
  return {
    format: VECTORS_FORMAT,
    version: VECTORS_VERSION,
    engine,
    viewport: VIEWPORT,
    defaults: DEFAULT_OPTIONS,
  };
}

function orderedExpect(expect: ExpectedState): ExpectedState {
  const ordered: ExpectedState = { doc: expect.doc, selection: expect.selection, mode: "normal" };
  if (expect.primary !== undefined) ordered.primary = expect.primary;
  ordered.mode = expect.mode;
  if (expect.registers !== undefined) ordered.registers = expect.registers;
  if (expect.prompt !== undefined) ordered.prompt = expect.prompt;
  if (expect.message !== undefined) ordered.message = expect.message;
  if (expect.scrollTop !== undefined) ordered.scrollTop = expect.scrollTop;
  return ordered;
}

function orderedStep(step: VectorStep): VectorStep {
  const expect = orderedExpect(step.expect);
  return "keys" in step ? { keys: step.keys, expect } : { api: step.api, expect };
}

/** One JSON line with a fixed key order, so regenerating an unchanged case is byte-identical. */
export function serializeCase(vector: VectorCase): string {
  const ordered: Record<string, unknown> = {
    name: vector.name,
    origin: vector.origin,
    doc: vector.doc,
    selection: vector.selection,
  };
  if (vector.primary !== undefined) ordered.primary = vector.primary;
  if (vector.options !== undefined) ordered.options = vector.options;
  if (vector.vim !== undefined) ordered.vim = vector.vim;
  if (vector.registers !== undefined) ordered.registers = vector.registers;
  if (vector.scrollTop !== undefined) ordered.scrollTop = vector.scrollTop;
  ordered.steps = vector.steps.map(orderedStep);
  return JSON.stringify(ordered);
}

export function serializeVectors(header: VectorHeader, cases: readonly VectorCase[]): string {
  const sorted = [...cases].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${[JSON.stringify(header), ...sorted.map(serializeCase)].join("\n")}\n`;
}

export interface ParsedVectors {
  header: VectorHeader;
  cases: VectorCase[];
}

export function parseVectors(text: string): ParsedVectors {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const [first, ...rest] = lines;
  if (first === undefined) throw new Error("vectors file is empty");
  const header = JSON.parse(first) as VectorHeader;
  if (header.format !== VECTORS_FORMAT) throw new Error(`unexpected format ${header.format}`);
  return { header, cases: rest.map((line) => JSON.parse(line) as VectorCase) };
}

/** The part of a case the oracle derives the expectations from. */
export function caseSpecOf(vector: VectorCase): CaseSpec {
  return {
    ...vector,
    steps: vector.steps.map((step) => ("keys" in step ? { keys: step.keys } : { api: step.api })),
  };
}
