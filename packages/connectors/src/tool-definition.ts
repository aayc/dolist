/**
 * Lenient parsing of `tools/list` entries. The SDK's strict schema rejects a server's whole tool list
 * when a single tool is malformed; here each tool is checked on its own and only unusable ones are
 * skipped. Schemas are normalized later by the adapter.
 */
import { isPlainObject } from "./util";

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDefinition {
  /** Exact wire name, used for `tools/call`. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** Raw `inputSchema` as sent by the server. */
  readonly inputSchema: unknown;
  readonly annotations: McpToolAnnotations;
}

export type ParsedTool =
  | { readonly ok: true; readonly tool: McpToolDefinition }
  | { readonly ok: false; readonly reason: string };

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

export function parseToolDefinition(raw: unknown): ParsedTool {
  if (!isPlainObject(raw)) return { ok: false, reason: "tool entry is not an object" };
  const name = typeof raw.name === "string" ? raw.name : "";
  if (name.trim() === "") return { ok: false, reason: "tool has no name" };
  if (isPlainObject(raw.execution) && raw.execution.taskSupport === "required") {
    return { ok: false, reason: `tool "${name}" requires task-based execution (not supported)` };
  }
  const annotations: { -readonly [K in keyof McpToolAnnotations]: McpToolAnnotations[K] } = {};
  if (isPlainObject(raw.annotations)) {
    const source = raw.annotations;
    if (typeof source.title === "string" && source.title.trim() !== "") {
      annotations.title = source.title;
    }
    for (const hint of HINTS) {
      const value = source[hint];
      if (typeof value === "boolean") annotations[hint] = value;
    }
  }
  return {
    ok: true,
    tool: {
      name,
      ...(typeof raw.title === "string" && raw.title.trim() !== "" ? { title: raw.title } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      inputSchema: raw.inputSchema,
      annotations,
    },
  };
}

const INVISIBLE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** Removes invisible/bidi control characters (a prompt-injection vector) and clamps the length. */
export function sanitizeToolText(value: string, maxLength: number): string {
  const cleaned = value.replace(INVISIBLE_RE, "").trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

// Adapted from Hermes Agent (MIT): tools/mcp_tool_schema.py (`_MCP_INJECTION_PATTERNS`).
const SUSPICIOUS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    "asks to ignore previous instructions",
  ],
  [/you\s+are\s+now\s+(a|an|the)\b/i, "tries to change the assistant's identity"],
  [/your\s+new\s+(task|role|instructions?)\s+(is|are)\b/i, "tries to replace the assistant's task"],
  [/<\s*\/?\s*(system|assistant|human)\s*>/i, "contains chat role tags"],
  [/do\s+not\s+(tell|inform|mention|reveal)\b/i, "asks to conceal information"],
  [/\b(curl|wget)\s+https?:\/\//i, "embeds a download command"],
];

/**
 * Findings for descriptions that look like prompt injection. Advisory only (logged): the safety gate,
 * not this heuristic, decides what may run.
 */
export function suspiciousToolText(value: string): string[] {
  return SUSPICIOUS_PATTERNS.filter(([pattern]) => pattern.test(value)).map(([, reason]) => reason);
}
