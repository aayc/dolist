import type {
  ApiCall,
  CaseSpec,
  EditorOptions,
  RegisterValue,
  SelectionRange,
  StepSpec,
  VimOptionValue,
} from "../format";
import { splitKeys } from "../harness/keys";

/** A key sequence as vim notation (`"d2w<Esc>"`), an explicit token list, or a host API call. */
export type StepInput = string | readonly string[] | { api: ApiCall };

export interface CaseInput {
  name: string;
  doc: string;
  /** Shorthand for a single cursor. */
  at?: readonly [number, number];
  selection?: SelectionRange[];
  primary?: number;
  options?: EditorOptions;
  vim?: Record<string, VimOptionValue>;
  registers?: Record<string, RegisterValue>;
  scrollTop?: number;
  steps: readonly StepInput[];
}

function toStep(step: StepInput): StepSpec {
  if (typeof step === "string") return { keys: splitKeys(step) };
  if (Array.isArray(step)) return { keys: [...step] };
  return { api: (step as { api: ApiCall }).api };
}

export function api(op: ApiCall["op"], ...args: unknown[]): { api: ApiCall } {
  return { api: { op, args } };
}

export function ex(command: string): { api: ApiCall } {
  return api("ex", command);
}

/** Types an ex command literally (`<Esc>` inside it is five characters) and submits it. */
export function cmd(command: string): string[] {
  return [":", ...command, "<CR>"];
}

export function register(text: string, linewise = false, blockwise = false): RegisterValue {
  return { text, linewise, blockwise };
}

/** Case names are `/`-separated paths, so keys that contain `/` or spaces get a readable label. */
export function label(keys: string): string {
  if (keys === "") return "none";
  return keys.replaceAll("/", "<slash>").replaceAll(" ", "<Space>");
}

/** A key sequence vim.js throws on; the generator checks it still does instead of recording it. */
export interface ThrowingCase {
  spec: CaseSpec;
  reason: string;
}

function toSpec(input: CaseInput): CaseSpec {
  if (input.steps.length === 0) throw new Error(`case without steps: ${input.name}`);
  const selection = input.selection ?? [[...(input.at ?? [0, 0])] as [number, number]];
  const spec: CaseSpec = {
    name: input.name,
    origin: "catalog",
    doc: input.doc,
    selection,
    steps: input.steps.map(toStep),
  };
  if (input.primary !== undefined) spec.primary = input.primary;
  if (input.options !== undefined) spec.options = input.options;
  if (input.vim !== undefined) spec.vim = input.vim;
  if (input.registers !== undefined) spec.registers = input.registers;
  if (input.scrollTop !== undefined) spec.scrollTop = input.scrollTop;
  return spec;
}

export class Catalog {
  private readonly cases = new Map<string, CaseSpec>();
  private readonly throwing = new Map<string, ThrowingCase>();

  add(input: CaseInput): void {
    if (this.cases.has(input.name) || this.throwing.has(input.name)) {
      throw new Error(`duplicate case name: ${input.name}`);
    }
    this.cases.set(input.name, toSpec(input));
  }

  throws(input: CaseInput & { reason: string }): void {
    if (this.cases.has(input.name) || this.throwing.has(input.name)) {
      throw new Error(`duplicate case name: ${input.name}`);
    }
    this.throwing.set(input.name, { spec: toSpec(input), reason: input.reason });
  }

  all(): CaseSpec[] {
    return [...this.cases.values()];
  }

  allThrowing(): ThrowingCase[] {
    return [...this.throwing.values()];
  }
}
