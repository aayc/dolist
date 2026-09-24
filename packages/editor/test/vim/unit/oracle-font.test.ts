import { describe, expect, it } from "vitest";
import { VIEWPORT } from "../format";
import { buildOracleFont, ORACLE_FONT_METRICS } from "../scripts/oracle-font";

function tables(font: DataView): Map<string, { offset: number; length: number; checksum: number }> {
  const count = font.getUint16(4);
  const result = new Map<string, { offset: number; length: number; checksum: number }>();
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...[0, 1, 2, 3].map((byte) => font.getUint8(record + byte)));
    result.set(tag, {
      checksum: font.getUint32(record + 4),
      offset: font.getUint32(record + 8),
      length: font.getUint32(record + 12),
    });
  }
  return result;
}

function sum(font: DataView, offset: number, length: number): number {
  let total = 0;
  for (let i = 0; i < length; i += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte++) {
      word = word * 256 + (i + byte < length ? font.getUint8(offset + i + byte) : 0);
    }
    total = (total + word) >>> 0;
  }
  return total;
}

/** The glyph cmap format 4 maps `code` to. */
function glyphFor(font: DataView, cmapOffset: number, code: number): number {
  const subtable = cmapOffset + font.getUint32(cmapOffset + 8);
  const segments = font.getUint16(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  for (let i = 0; i < segments; i++) {
    if (code > font.getUint16(ends + i * 2)) continue;
    if (code < font.getUint16(starts + i * 2)) return 0;
    return (code + font.getInt16(deltas + i * 2)) & 0xffff;
  }
  return 0;
}

describe("oracle font", () => {
  const bytes = buildOracleFont();
  const font = new DataView(bytes.buffer);
  const directory = tables(font);
  const table = (tag: string) => {
    const entry = directory.get(tag);
    if (!entry) throw new Error(`missing table ${tag}`);
    return entry;
  };

  it("lays out with the geometry the vectors record", () => {
    expect(ORACLE_FONT_METRICS).toEqual({
      textHeight: VIEWPORT.textHeight,
      charWidth: VIEWPORT.charWidth,
    });
  });

  it("is a well-formed TrueType font", () => {
    expect(font.getUint32(0)).toBe(0x00010000);
    expect([...directory.keys()]).toEqual([
      "OS/2",
      "cmap",
      "glyf",
      "head",
      "hhea",
      "hmtx",
      "loca",
      "maxp",
      "name",
      "post",
    ]);
    for (const [tag, entry] of directory) {
      if (tag !== "head") expect(sum(font, entry.offset, entry.length), tag).toBe(entry.checksum);
      expect(entry.offset % 4, tag).toBe(0);
    }
    expect(sum(font, 0, bytes.length)).toBe(0xb1b0afba);
    const head = table("head").offset;
    expect(font.getUint32(head + 12)).toBe(0x5f0f3cf5);
    const glyphs = font.getUint16(table("maxp").offset + 4);
    expect(table("loca").length).toBe((glyphs + 1) * 2);
  });

  it("is monospace with a whole-pixel advance (1280/2048em) and Courier New's ascent/descent", () => {
    expect(font.getUint16(table("head").offset + 18)).toBe(2048);
    const hhea = table("hhea").offset;
    expect(font.getInt16(hhea + 4)).toBe(1705);
    expect(font.getInt16(hhea + 6)).toBe(-615);
    expect(font.getInt16(hhea + 8)).toBe(0);
    expect(font.getUint16(hhea + 34)).toBe(1);
    expect(font.getUint16(table("hmtx").offset)).toBe(1280);
  });

  it("maps printable ASCII and nothing else", () => {
    const cmap = table("cmap").offset;
    expect(glyphFor(font, cmap, 0x20)).toBe(1);
    expect(glyphFor(font, cmap, 0x41)).toBe(0x41 - 0x20 + 1);
    expect(glyphFor(font, cmap, 0x7e)).toBe(0x7e - 0x20 + 1);
    expect(glyphFor(font, cmap, 0x1f)).toBe(0);
    expect(glyphFor(font, cmap, 0xe9)).toBe(0);
  });
});
