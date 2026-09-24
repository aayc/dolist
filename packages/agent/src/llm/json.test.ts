import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "./json";

describe("parseJsonLoose", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ["  [1, 2]  ", [1, 2]],
    ["null", null],
    ['```json\n{"a": "b"}\n```', { a: "b" }],
    ['Here you go:\n```\n{"x": [1]}\n```\nThanks', { x: [1] }],
    ['The answer is {"q": "a \\"quoted\\" }"} as requested', { q: 'a "quoted" }' }],
    ['{broken} then {"ok": true}', { ok: true }],
  ])("parses %j", (input, expected) => {
    expect(parseJsonLoose(input)).toEqual({ ok: true, value: expected });
  });

  it.each(["", "plain words", "{unterminated", '{"a": }'])("rejects %j", (input) => {
    expect(parseJsonLoose(input)).toEqual({ ok: false });
  });
});
