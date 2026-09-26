/**
 * Model-facing tool names: `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_-]` and clamped to the
 * 64-character function-name limit (`TOOL_NAME_RE`) with a deterministic hash suffix.
 *
 * Adapted from Hermes Agent (MIT): tools/mcp_tool_schema.py (`mcp_prefixed_tool_name`).
 */

import { createHash } from "node:crypto";
import { compareStrings } from "@ddl/core";

export const MCP_TOOL_PREFIX = "mcp__";
export const MAX_TOOL_NAME_LENGTH = 64;
const SEPARATOR = "__";
const HASH_LENGTH = 8;

export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

export function sanitizeNameComponent(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "_" : cleaned;
}

/** Stable key of a (server, tool) pair, used to look up assigned names. */
export function toolRefKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

/** The natural name of one tool, before collision handling. */
export function mcpToolName(server: string, tool: string): string {
  const name = unclampedName(server, tool);
  return name.length <= MAX_TOOL_NAME_LENGTH
    ? name
    : withHashSuffix(name, toolRefKey(server, tool));
}

/**
 * Assigns unique names to a set of tools. Pairs are processed in a fixed order (server, then tool;
 * code-unit comparison), so the result depends only on the set, not on connection or listing order.
 * The first pair keeps its natural name; later pairs that collide (case-insensitively, e.g. `a.b` vs
 * `a_b`) get a hash suffix derived from their raw names.
 */
export function assignToolNames(refs: Iterable<McpToolRef>): Map<string, string> {
  const unique = new Map<string, McpToolRef>();
  for (const ref of refs) unique.set(toolRefKey(ref.server, ref.tool), ref);
  const ordered = [...unique.entries()].sort(([a], [b]) => compareStrings(a, b));
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const [key, ref] of ordered) {
    let name = mcpToolName(ref.server, ref.tool);
    for (let attempt = 0; taken.has(name.toLowerCase()); attempt++) {
      name = withHashSuffix(
        unclampedName(ref.server, ref.tool),
        attempt === 0 ? key : `${key}#${attempt}`,
      );
    }
    taken.add(name.toLowerCase());
    names.set(key, name);
  }
  return names;
}

function unclampedName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeNameComponent(server)}${SEPARATOR}${sanitizeNameComponent(tool)}`;
}

function withHashSuffix(name: string, seed: string): string {
  const suffix = `_${createHash("sha256").update(seed).digest("hex").slice(0, HASH_LENGTH)}`;
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
