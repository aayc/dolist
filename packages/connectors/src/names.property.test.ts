import { TOOL_NAME_RE } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { assignToolNames, type McpToolRef, mcpToolName, toolRefKey } from "./names";

const runs = (factor: number) =>
  Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));

/** Names servers and tools really have, plus unicode, separators, case twins and overlong names. */
const component = fc.oneof(
  fc.string({ unit: "binary", maxLength: 30 }),
  fc.string({ unit: "grapheme", maxLength: 30 }),
  fc.stringMatching(/^[a-z][a-z0-9_.-]{0,20}$/),
  fc.constantFrom(
    "",
    " ",
    "__",
    "a__b",
    "read.file",
    "read_file",
    "READ_FILE",
    "read file",
    "résumé",
    "读",
  ),
  fc.integer({ min: 40, max: 200 }).map((n) => "x".repeat(n)),
);
const ref = fc.record({ server: component, tool: component });

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("mcpToolName", () => {
  test.prop([component, component], { numRuns: runs(3) })(
    "is always a provider-safe, deterministic name",
    (server, tool) => {
      const name = mcpToolName(server, tool);
      expect(name).toMatch(TOOL_NAME_RE);
      expect(name.startsWith("mcp__")).toBe(true);
      expect(mcpToolName(server, tool)).toBe(name);
    },
  );
});

describe("assignToolNames", () => {
  test.prop([fc.array(ref, { maxLength: 40 }), fc.nat()], { numRuns: runs(2) })(
    "gives every distinct pair a unique, valid name, independent of order",
    (refs, seed) => {
      const names = assignToolNames(refs);
      const distinct = new Set(refs.map((r) => toolRefKey(r.server, r.tool)));
      expect(names.size).toBe(distinct.size);
      const values = [...names.values()];
      for (const name of values) expect(name).toMatch(TOOL_NAME_RE);
      expect(new Set(values.map((n) => n.toLowerCase())).size).toBe(values.length);
      expect(assignToolNames(shuffle(refs, seed))).toEqual(names);
      expect(assignToolNames([...refs, ...refs])).toEqual(names);
    },
  );

  test.prop([fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/), { maxLength: 20 })])(
    "keeps natural names when sanitized names cannot collide",
    (tools) => {
      const refs = tools.map((tool) => ({ server: "srv", tool }));
      const names = assignToolNames(refs);
      for (const r of refs)
        expect(names.get(toolRefKey(r.server, r.tool))).toBe(`mcp__srv__${r.tool}`);
    },
  );

  test.prop([
    fc.uniqueArray(fc.stringMatching(/^[A-Za-z]{1,6}$/), { minLength: 2, maxLength: 6 }),
    fc.array(component, { minLength: 1, maxLength: 10 }),
  ])("never collides across servers, even case-twins sharing tool names", (servers, tools) => {
    const refs: McpToolRef[] = servers.flatMap((server) => tools.map((tool) => ({ server, tool })));
    const values = [...assignToolNames(refs).values()];
    expect(new Set(values.map((n) => n.toLowerCase())).size).toBe(values.length);
  });

  it("stays unique and fast for thousands of tools that sanitize to the same name", () => {
    const variants = ["a.b", "a_b", "A_B", "a b", "a/b", "a:b", "a\u00A0b", "a😀b"];
    const refs = Array.from({ length: 3_000 }, (_, i) => ({
      server: i % 2 === 0 ? "srv" : "SRV",
      tool: `${variants[i % variants.length]}${Math.floor(i / variants.length)}`,
    }));
    const started = performance.now();
    const values = [...assignToolNames(refs).values()];
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(values).toHaveLength(3_000);
    expect(new Set(values.map((n) => n.toLowerCase())).size).toBe(3_000);
    for (const name of values) expect(name).toMatch(TOOL_NAME_RE);
  });
});
