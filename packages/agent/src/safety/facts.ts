/**
 * Normalizes a tool call into the facts the rules inspect: which family of tool it is, the element
 * being clicked or typed into, typed text, URLs, paths, shell command, MCP server/tool words, the
 * app a computer action targets and every string in the input. Rules never look at raw inputs
 * directly.
 */
import type { ToolSubject } from "@ddl/core";
import { MCP_TOOL_PREFIX, TOOL } from "../tools/contracts";
import { INTERNAL_TOOLS, KNOWLEDGE_TOOLS } from "./policy";
import { ROUTINE_TOOLS } from "./rules/routines";
import { parseShell, type ShellAnalysis } from "./shell";
import type { ActionContext } from "./types";
import { normalizePhrase, READINGS_SEPARATOR } from "./vocab";

export type ToolFamily =
  | "internal"
  | "knowledge"
  | "web_search"
  | "web_fetch"
  | "browser"
  | "computer"
  | "shell"
  | "file_read"
  | "file_write"
  | "note_edit"
  | "routine"
  | "mcp"
  | "custom";

export type UiAction =
  | "click"
  | "type"
  | "select"
  | "key"
  | "navigate"
  | "hover"
  | "upload"
  | "script"
  | "dialog"
  | "read"
  | "other";

export interface UiFacts {
  surface: "browser" | "computer";
  action: UiAction;
}

export interface McpFacts {
  server: string;
  tool: string;
  /** Lowercased words of the tool name (`sendEmail` → `send`, `email`). */
  words: readonly string[];
}

/** The app a computer action targets. */
export interface AppFacts {
  /** The model's `app` text and, once the subject is added, the app's real name. */
  readonly names: readonly string[];
  /** How evidence names the app: its real name when known. */
  readonly label: string;
  /** The normalized real name (else the model's text): what standing grants are scoped to. */
  readonly target: string;
}

export interface ActionFacts {
  readonly ctx: ActionContext;
  readonly family: ToolFamily;
  /** The underlying operation: the tool name, or the MCP tool part (`browser_click` for `mcp__pw__browser_click`). */
  readonly operation: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly ui?: UiFacts;
  /** Normalized description of the element acted on (element, label, button text, selector words). */
  readonly element: string;
  /** Human-readable element description for evidence and summaries. */
  readonly elementLabel: string;
  readonly typedText?: string;
  /** A typed value contains a line break, which keyboard typing turns into Return. */
  readonly typedLineBreak: boolean;
  readonly submit: boolean;
  /** Normalized key combo, e.g. `cmd+enter`. */
  readonly key?: string;
  readonly urls: readonly string[];
  readonly command?: string;
  readonly paths: readonly string[];
  /** Every string value in the input (bounded). */
  readonly strings: readonly string[];
  readonly mcp?: McpFacts;
  /** Normalized task text + rationale, for intent heuristics. */
  readonly intent: string;
  readonly shell?: ShellAnalysis;
  /** What the tool knows about the real target (`ToolSafetyHints.subject`), sanitized. */
  readonly subject?: ToolSubject;
  readonly app?: AppFacts;
}

/** Computer tools that only look: screenshots, the app list, an app's accessibility tree. */
export const COMPUTER_READ_RE = /(?:^|_)(?:screenshot|apps|app_state)$/;

/** App control operations and the UI action the rules treat them as. */
const COMPUTER_ACTIONS: Readonly<Record<string, UiAction>> = {
  press: "click",
  set_value: "type",
  apps: "read",
  app_state: "read",
  open_app: "other",
};

const FILE_READ_TOOLS: ReadonlySet<string> = new Set([TOOL.read, TOOL.grep, TOOL.find, TOOL.ls]);
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([TOOL.write, TOOL.edit]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function familyOf(toolName: string, isMcp: boolean): ToolFamily {
  if (isMcp) return "mcp";
  if (INTERNAL_TOOLS.has(toolName)) return "internal";
  if (KNOWLEDGE_TOOLS.has(toolName)) return "knowledge";
  if (toolName === TOOL.editNote) return "note_edit";
  if (ROUTINE_TOOLS.has(toolName)) return "routine";
  if (toolName === TOOL.webSearch) return "web_search";
  if (toolName === TOOL.webFetch) return "web_fetch";
  if (toolName === TOOL.bash) return "shell";
  if (FILE_READ_TOOLS.has(toolName)) return "file_read";
  if (FILE_WRITE_TOOLS.has(toolName)) return "file_write";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("computer_")) return "computer";
  return "custom";
}

const UI_ACTIONS: ReadonlyArray<readonly [RegExp, UiAction]> = [
  [/^(?:click|double_click|right_click|tap|drag|drag_and_drop)$/, "click"],
  [/^(?:type|type_text|fill|fill_form|input)$/, "type"],
  [/^(?:select_option|select)$/, "select"],
  [/^(?:press_key|key|keypress|hotkey|press)$/, "key"],
  [/^(?:navigate|goto|open_url|open)$/, "navigate"],
  [/^(?:hover|move|mouse_move)$/, "hover"],
  [/^(?:file_upload|upload|upload_file|set_input_files)$/, "upload"],
  [/^(?:evaluate|run_code|execute_javascript|eval|run_script|install)$/, "script"],
  [/^(?:handle_dialog|dialog)$/, "dialog"],
  [
    /^(?:snapshot|screenshot|take_screenshot|extract_text|get_text|scroll|back|go_back|navigate_back|forward|navigate_forward|console_messages|network_requests|wait|wait_for|resize|tabs|tab_list|tab_select|tab_new|tab_close|close|pdf_save|zoom)$/,
    "read",
  ],
];

function uiFacts(operation: string): UiFacts | undefined {
  const m = /^(browser|computer)_(.+)$/.exec(operation);
  if (!m) return undefined;
  const surface = m[1] as "browser" | "computer";
  const special = surface === "computer" ? COMPUTER_ACTIONS[m[2]!] : undefined;
  const action = special ?? UI_ACTIONS.find(([re]) => re.test(m[2]!))?.[1] ?? "other";
  return { surface, action };
}

const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["command", "cmd"],
  ["meta", "cmd"],
  ["super", "cmd"],
  ["⌘", "cmd"],
  ["control", "ctrl"],
  ["⌃", "ctrl"],
  ["option", "alt"],
  ["opt", "alt"],
  ["⌥", "alt"],
  ["⇧", "shift"],
  ["return", "enter"],
  ["numpadenter", "enter"],
  ["kp_enter", "enter"],
  ["kpenter", "enter"],
  ["↩", "enter"],
  ["↵", "enter"],
  ["⏎", "enter"],
  ["⌤", "enter"],
  ["⌫", "backspace"],
  ["⌦", "delete"],
  ["⎋", "escape"],
  ["esc", "escape"],
  ["del", "delete"],
  ["arrowup", "up"],
  ["arrowdown", "down"],
  ["arrowleft", "left"],
  ["arrowright", "right"],
]);

export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/([⌘⌃⌥⇧])(?=\S)/g, "$1+")
    .split(/\s*[+-]\s*|\s+/)
    .filter(Boolean)
    .map((part) => KEY_ALIASES.get(part) ?? part)
    .join("+");
}

function collectStrings(value: unknown, out: string[], budget: { chars: number }, depth = 0): void {
  if (out.length >= 300 || budget.chars <= 0 || depth > 8) return;
  if (typeof value === "string") {
    const clipped = value.slice(0, budget.chars);
    out.push(clipped);
    budget.chars -= clipped.length;
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, budget, depth + 1);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) collectStrings(v, out, budget, depth + 1);
  }
}

const URL_KEYS_RE =
  /^(?:url|uri|link|href|endpoint|webhook(?:_?url)?|website|page_?url|target_?url)$/i;
const PATH_KEYS_RE =
  /^(?:path|paths|file|files|file_?path|file_?paths|filename|dir|directory|destination|dest|source|src|target_?path|output_?path|folder)$/i;
const COMMAND_KEYS_RE = /^(?:command|cmd|script|shell_?command)$/i;

function fieldStrings(input: Record<string, unknown>, keyRe: RegExp): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!keyRe.test(key)) continue;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value))
      out.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return out;
}

function elementText(input: Record<string, unknown>, action: UiAction | undefined): string {
  const parts = [
    str(input.element),
    str(input.label),
    str(input.name),
    str(input.description),
    str(input.button),
  ];
  if (action !== "type") parts.push(str(input.text));
  const selector = str(input.selector);
  if (selector) parts.push(selector.replace(/[#.[\]=_"'>:()-]+/g, " "));
  const fields = Array.isArray(input.fields) ? input.fields : [];
  for (const field of fields)
    if (isRecord(field)) parts.push(str(field.name), str(field.label), str(field.element));
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(" ");
}

function typedValuesOf(input: Record<string, unknown>, ui: UiFacts | undefined): string[] {
  if (ui?.action !== "type") return [];
  const parts = [str(input.text), str(input.value)];
  const fields = Array.isArray(input.fields) ? input.fields : [];
  for (const field of fields) if (isRecord(field)) parts.push(str(field.value), str(field.text));
  return parts.filter((p): p is string => p !== undefined);
}

const MAX_SUBJECT_CHARS = 200;

/** The tool's `subject` hint, if it gave a usable one. A broken hint is ignored, never trusted. */
function subjectOf(ctx: ActionContext): ToolSubject | undefined {
  let raw: unknown;
  try {
    raw = ctx.hints?.subject?.(ctx.input);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const clean = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS)
      : undefined;
  const app = clean(raw.app);
  const element = clean(raw.element);
  if (!app && !element) return undefined;
  return { ...(app ? { app } : {}), ...(element ? { element } : {}) };
}

function appNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.app\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function appFacts(names: readonly string[]): AppFacts | undefined {
  const usable = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (usable.length === 0) return undefined;
  const real = usable.at(-1)!;
  return { names: usable, label: real.slice(0, 80), target: appNameKey(real).slice(0, 200) };
}

/**
 * The facts with the subject's real target added to the model's words: its element label joins
 * the element text and its app name joins the app names. The evaluator only takes risky rule hits
 * from these (see `analyzeAction`), so a subject can make a verdict stricter, never looser.
 */
export function withSubject(facts: ActionFacts): ActionFacts {
  const subject = facts.subject;
  if (!subject) return facts;
  const element = [facts.element, subject.element ? normalizePhrase(subject.element) : ""]
    .filter(Boolean)
    .join(READINGS_SEPARATOR);
  const names = [...(facts.app?.names ?? []), ...(subject.app ? [subject.app] : [])];
  const app = appFacts(names);
  return {
    ...facts,
    element,
    elementLabel: (subject.element ?? facts.elementLabel).slice(0, 120),
    ...(app ? { app } : {}),
  };
}

export function buildFacts(ctx: ActionContext): ActionFacts {
  const input = isRecord(ctx.input) ? ctx.input : {};
  const mcpName = parseMcpToolName(ctx.toolName);
  const family = familyOf(ctx.toolName, mcpName !== undefined);
  const operation = mcpName ? mcpName.tool : ctx.toolName;
  const ui =
    family === "browser" || family === "computer" || family === "mcp"
      ? uiFacts(operation)
      : undefined;
  const rawElement = elementText(input, ui?.action);
  const strings: string[] = [];
  collectStrings(ctx.input, strings, { chars: 50_000 });
  const subject = ui?.surface === "computer" ? subjectOf(ctx) : undefined;
  const app = ui?.surface === "computer" ? appFacts([str(input.app) ?? ""]) : undefined;
  // Setting a value inserts line breaks as text; only keyboard typing turns them into Return.
  const setsValue = ui?.surface === "computer" && /(?:^|_)set_value$/.test(operation);

  const urls = fieldStrings(input, URL_KEYS_RE);
  const paths = family === "shell" ? [] : fieldStrings(input, PATH_KEYS_RE);
  const command =
    family === "shell"
      ? str(input.command)
      : family === "mcp" || family === "custom"
        ? fieldStrings(input, COMMAND_KEYS_RE)[0]
        : undefined;
  const rawKey =
    ui?.action === "key" ? (str(input.key) ?? str(input.combo) ?? str(input.keys)) : undefined;
  const typedValues = typedValuesOf(input, ui);

  return {
    ctx,
    family,
    operation,
    input,
    ...(ui ? { ui } : {}),
    element: normalizePhrase(rawElement),
    elementLabel: rawElement.trim().slice(0, 120),
    ...(typedValues.length > 0 ? { typedText: typedValues.join("\n") } : {}),
    typedLineBreak: !setsValue && typedValues.some((value) => /[\r\n]/.test(value)),
    submit: input.submit === true,
    ...(rawKey ? { key: normalizeKey(rawKey) } : {}),
    urls,
    ...(command === undefined ? {} : { command }),
    paths,
    strings,
    ...(mcpName ? { mcp: { ...mcpName, words: toolWords(mcpName.tool) } } : {}),
    intent: normalizePhrase(`${ctx.taskText ?? ""} ${ctx.rationale ?? ""}`),
    ...(command === undefined
      ? {}
      : { shell: parseShell(command, ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}) }),
    ...(subject ? { subject } : {}),
    ...(app ? { app } : {}),
  };
}
