/**
 * Per-server tool filter: `include` (when non-empty) first, then `exclude`. Patterns are exact MCP
 * tool names or `*` globs.
 *
 * Adapted from OpenClaw (MIT): src/agents/mcp-tool-filter.ts.
 */
import type { McpToolFilter } from "./types";

export function matchesToolPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "s").test(name);
}

export function isToolAllowed(filter: McpToolFilter | undefined, name: string): boolean {
  const matches = (pattern: string) => matchesToolPattern(pattern, name);
  const included = !filter?.include?.length || filter.include.some(matches);
  return included && !filter?.exclude?.some(matches);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
