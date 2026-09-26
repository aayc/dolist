import { TOOL_NAME_RE } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  assignToolNames,
  MAX_TOOL_NAME_LENGTH,
  mcpToolName,
  sanitizeNameComponent,
  toolRefKey,
} from "./names";

describe("mcpToolName", () => {
  it("prefixes and sanitizes to provider-safe characters", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("Google Workspace", "gmail.send-draft")).toBe(
      "mcp__Google_Workspace__gmail_send-draft",
    );
    expect(mcpToolName("files", "résumé/读")).toBe("mcp__files__r_sum___");
    expect(sanitizeNameComponent("  ")).toBe("_");
  });

  it("clamps long names to 64 characters with a deterministic hash suffix", () => {
    const server = "a-very-long-server-name-from-a-plugin-bundle";
    const tool = "and_an_equally_long_tool_name_that_overflows";
    const name = mcpToolName(server, tool);
    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(name).toMatch(TOOL_NAME_RE);
    expect(name).toMatch(/_[0-9a-f]{8}$/);
    expect(mcpToolName(server, tool)).toBe(name);
    expect(mcpToolName(server, `${tool}_2`)).not.toBe(name);
  });
});

describe("assignToolNames", () => {
  it("de-duplicates tools that sanitize to the same name, case-insensitively", () => {
    const refs = [
      { server: "files", tool: "read.file" },
      { server: "files", tool: "read_file" },
      { server: "Files", tool: "read_file" },
    ];
    const names = assignToolNames(refs);
    const values = [...names.values()];
    expect(new Set(values.map((n) => n.toLowerCase())).size).toBe(3);
    for (const name of values) expect(name).toMatch(TOOL_NAME_RE);
    // Code-unit order: "Files" < "files", and "read.file" < "read_file".
    expect(names.get(toolRefKey("Files", "read_file"))).toBe("mcp__Files__read_file");
    expect(names.get(toolRefKey("files", "read.file"))).toMatch(
      /^mcp__files__read_file_[0-9a-f]{8}$/,
    );
    expect(names.get(toolRefKey("files", "read_file"))).toMatch(
      /^mcp__files__read_file_[0-9a-f]{8}$/,
    );
    expect(assignToolNames([...refs].reverse())).toEqual(names);
  });

  it("is independent of input order and resolves separator ambiguity", () => {
    const refs = [
      { server: "a__b", tool: "c" },
      { server: "a", tool: "b__c" },
      { server: "z", tool: "tool" },
    ];
    const forward = assignToolNames(refs);
    const backward = assignToolNames([...refs].reverse());
    expect([...forward.entries()].sort()).toEqual([...backward.entries()].sort());
    expect(forward.get(toolRefKey("a", "b__c"))).toBe("mcp__a__b__c");
    expect(forward.get(toolRefKey("a__b", "c"))).toMatch(/^mcp__a__b__c_[0-9a-f]{8}$/);
  });
});
