/**
 * Pure post-processing of Playwright's AI aria snapshots (`page.ariaSnapshot({ mode: "ai" })`):
 * refs, value masking for sensitive fields, and a size budget for the model.
 */

export const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000;
export const VALUE_MASK = "•••••• (hidden)";

const MAX_LINE_CHARS = 1_000;
const MAX_URL_CHARS = 150;

/** `- role "name" [attr] [ref=e5] …: value` — the name is JSON-quoted; YAML may single-quote the key. */
const NODE_LINE =
  /^(\s*-\s+'?)(\w+)((?: "(?:[^"\\]|\\.)*")?)((?: \[[^\][]*\])*)('?)(?::(?: (.*))?)?$/;
const REF_ATTR = /\[ref=((?:f\d+)?e\d+)\]/;
const REF_FORMAT = /^(?:f\d+)?e\d+$/;
/** Roles whose line value is the element's current (user-entered) value. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

interface NodeLine {
  prefix: string;
  role: string;
  name: string;
  attrs: string;
  quote: string;
  value: string | undefined;
  ref: string | undefined;
}

function parseNodeLine(line: string): NodeLine | undefined {
  const m = NODE_LINE.exec(line);
  if (!m) return undefined;
  const attrs = m[4] ?? "";
  return {
    prefix: m[1] ?? "",
    role: m[2] ?? "",
    name: m[3] ?? "",
    attrs,
    quote: m[5] ?? "",
    value: m[6],
    ref: REF_ATTR.exec(attrs)?.[1],
  };
}

/** Accepts `e5`, `ref=e5`, `[ref=e5]`, `@e5` (and iframe refs like `f1e2`); `undefined` if malformed. */
export function normalizeRef(input: string): string | undefined {
  const ref = input
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^ref=|^@/, "");
  return REF_FORMAT.test(ref) ? ref : undefined;
}

/** Refs of form fields whose current value is rendered in the snapshot (candidates for masking). */
export function fieldRefsWithValues(snapshot: string): string[] {
  const refs: string[] = [];
  for (const line of snapshot.split("\n")) {
    const node = parseNodeLine(line);
    if (node?.ref && node.value && FIELD_ROLES.has(node.role)) refs.push(node.ref);
  }
  return refs;
}

/** Replaces the rendered values of `refs` (passwords, card numbers…) with {@link VALUE_MASK}. */
export function maskFieldValues(snapshot: string, refs: ReadonlySet<string>): string {
  if (refs.size === 0) return snapshot;
  return snapshot
    .split("\n")
    .map((line) => {
      const node = parseNodeLine(line);
      if (!node?.ref || node.value === undefined || !refs.has(node.ref)) return line;
      return `${node.prefix}${node.role}${node.name}${node.attrs}${node.quote}: ${VALUE_MASK}`;
    })
    .join("\n");
}

/** Role/name of each ref, e.g. `e5 → button "Place order"` (for action summaries). */
export function describeRefs(snapshot: string): Map<string, string> {
  const described = new Map<string, string>();
  for (const line of snapshot.split("\n")) {
    const node = parseNodeLine(line);
    if (node?.ref) described.set(node.ref, `${node.role}${node.name}`);
  }
  return described;
}

function compactLine(line: string): string {
  const url = /^(\s*- \/url: )(.*)$/.exec(line);
  if (url && (url[2]?.length ?? 0) > MAX_URL_CHARS) {
    return `${url[1]}${url[2]?.slice(0, MAX_URL_CHARS)}…`;
  }
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/**
 * Applies the size budget at line boundaries (so every visible ref is complete) and appends a
 * truncation notice.
 */
export function formatSnapshot(snapshot: string, maxChars = DEFAULT_SNAPSHOT_MAX_CHARS): string {
  if (!snapshot.trim()) return "(empty page)";
  const lines = snapshot.split("\n").map(compactLine);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join("\n")}\n[... snapshot truncated: showing ${kept.length} of ${lines.length} lines. Act on the refs shown, or use browser_extract_text to read the rest of the page ...]`;
}
