import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file";

describe("parseEnvFile", () => {
  it("parses assignments, quotes, export and comments", () => {
    const vars = parseEnvFile(
      [
        "# comment",
        "",
        "PLAIN=value",
        "export EXPORTED=yes",
        "SPACED = padded value   ",
        'DOUBLE="line\\nbreak \\"quoted\\""',
        "SINGLE='literal \\n $HOME'",
        "INLINE=value # trailing comment",
        "HASH=abc#def",
        "EMPTY=",
        "not a valid line",
        'UNTERMINATED="oops',
      ].join("\n"),
    );
    expect(Object.fromEntries(vars)).toEqual({
      PLAIN: "value",
      EXPORTED: "yes",
      SPACED: "padded value",
      DOUBLE: 'line\nbreak "quoted"',
      SINGLE: "literal \\n $HOME",
      INLINE: "value",
      HASH: "abc#def",
      EMPTY: "",
    });
  });

  it("handles CRLF line endings", () => {
    expect(Object.fromEntries(parseEnvFile("A=1\r\nB=2\r\n"))).toEqual({ A: "1", B: "2" });
  });
});
