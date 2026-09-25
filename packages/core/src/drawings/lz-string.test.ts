import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { compressToBase64, decompressFromBase64 } from "./lz-string";

/** Outputs of lz-string 1.5.0's `compressToBase64`, recorded from the library. */
const LIBRARY_VECTORS: Array<[string, string]> = [
  ["", "Q==="],
  ["a", "IZA="],
  ["hello world", "BYUwNmD2AEDukCcwBMg="],
  ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "IY18ZJA="],
  [
    '{"type":"excalidraw","version":2}',
    "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmAXyA==",
  ],
  ["日本語 🎉 é", "qemhpzR5UQBIPBuJH7EJdA=="],
];

describe("LZ-String base64", () => {
  it.each(LIBRARY_VECTORS)("matches the library for %j", (text, compressed) => {
    expect(compressToBase64(text)).toBe(compressed);
    expect(decompressFromBase64(compressed)).toBe(text);
  });

  test.prop([fc.string({ unit: "binary", maxLength: 400 })])("round-trips any text", (text) => {
    expect(decompressFromBase64(compressToBase64(text))).toBe(text);
  });

  test.prop([fc.string({ maxLength: 60 })])("never throws on arbitrary input", (input) => {
    expect(() => decompressFromBase64(input)).not.toThrow();
  });

  it("returns null or empty for input that isn't a compressed stream", () => {
    expect(decompressFromBase64("")).toBeNull();
    expect(decompressFromBase64("////")).toBeNull();
    expect(decompressFromBase64(compressToBase64("some drawing").slice(0, 3))).toBe("");
  });
});
