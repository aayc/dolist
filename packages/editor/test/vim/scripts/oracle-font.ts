/**
 * The oracle's font, generated: a monospace TrueType font covering printable ASCII with pinned
 * metrics. vim's page motions and display-line commands measure glyph boxes and character widths,
 * so recording with the system `monospace` font would make the vectors depend on the machine's font
 * catalog (macOS and Linux resolve it to different fonts). Ascent and descent are Courier New's
 * (1705/615 of 2048: an 18px glyph box at 16px); the advance is a whole 10px because Chromium on
 * Linux rounds glyph advances to whole pixels. Every glyph but the space is a plain box, which keeps
 * failure screenshots readable.
 */

export const ORACLE_FONT_FAMILY = "DDL Vim Oracle";
export const ORACLE_FONT_SIZE = 16;

const UNITS_PER_EM = 2048;
const ADVANCE = 1280;
const ASCENT = 1705;
const DESCENT = 615;
const FIRST_CHAR = 0x20;
const LAST_CHAR = 0x7e;
/** .notdef, then one glyph per character in FIRST_CHAR..LAST_CHAR. */
const GLYPH_COUNT = 1 + LAST_CHAR - FIRST_CHAR + 1;
const BOX = { xMin: 100, yMin: -200, xMax: ADVANCE - 100, yMax: 1400 };

/** What Chromium lays out with the font at ORACLE_FONT_SIZE (asserted by the pages). */
export const ORACLE_FONT_METRICS = {
  charWidth: (ADVANCE / UNITS_PER_EM) * ORACLE_FONT_SIZE,
  textHeight:
    Math.round((ASCENT / UNITS_PER_EM) * ORACLE_FONT_SIZE) +
    Math.round((DESCENT / UNITS_PER_EM) * ORACLE_FONT_SIZE),
} as const;

class Writer {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }

  i16(value: number): this {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value: number): this {
    return this.u16(value >>> 16).u16(value & 0xffff);
  }

  tag(value: string): this {
    for (const char of value) this.u8(char.charCodeAt(0));
    return this;
  }

  zeros(count: number): this {
    for (let i = 0; i < count; i++) this.u8(0);
    return this;
  }

  get length(): number {
    return this.bytes.length;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function boxGlyph(): Uint8Array {
  const { xMin, yMin, xMax, yMax } = BOX;
  const w = new Writer().i16(1).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
  w.u16(3).u16(0); // endPtsOfContours[0], instructionLength
  for (let i = 0; i < 4; i++) w.u8(0x01); // on-curve, 16-bit deltas
  for (const dx of [xMin, xMax - xMin, 0, xMin - xMax]) w.i16(dx);
  for (const dy of [yMin, 0, yMax - yMin, 0]) w.i16(dy);
  return w.toBytes();
}

function glyphTables(): { glyf: Uint8Array; loca: Uint8Array } {
  const box = boxGlyph();
  const glyf = new Writer();
  const loca = new Writer();
  for (let glyph = 0; glyph < GLYPH_COUNT; glyph++) {
    loca.u16(glyf.length / 2);
    const isSpace = glyph === 1;
    if (!isSpace) for (const byte of box) glyf.u8(byte);
  }
  loca.u16(glyf.length / 2);
  return { glyf: glyf.toBytes(), loca: loca.toBytes() };
}

function head(): Uint8Array {
  return new Writer()
    .u32(0x00010000)
    .u32(0x00010000)
    .u32(0) // checkSumAdjustment, patched once the font is assembled
    .u32(0x5f0f3cf5)
    .u16(0x000b)
    .u16(UNITS_PER_EM)
    .zeros(16) // created, modified
    .i16(BOX.xMin)
    .i16(BOX.yMin)
    .i16(BOX.xMax)
    .i16(BOX.yMax)
    .u16(0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(0) // indexToLocFormat: short offsets
    .i16(0)
    .toBytes();
}

function hhea(): Uint8Array {
  return new Writer()
    .u32(0x00010000)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0) // lineGap
    .u16(ADVANCE)
    .i16(BOX.xMin) // minLeftSideBearing
    .i16(ADVANCE - BOX.xMax) // minRightSideBearing
    .i16(BOX.xMax) // xMaxExtent
    .i16(1) // caretSlopeRise
    .i16(0)
    .i16(0)
    .zeros(8)
    .i16(0) // metricDataFormat
    .u16(1) // numberOfHMetrics: every glyph shares the first advance
    .toBytes();
}

function hmtx(): Uint8Array {
  const w = new Writer().u16(ADVANCE).i16(BOX.xMin);
  for (let glyph = 1; glyph < GLYPH_COUNT; glyph++) w.i16(glyph === 1 ? 0 : BOX.xMin);
  return w.toBytes();
}

function maxp(): Uint8Array {
  return new Writer()
    .u32(0x00010000)
    .u16(GLYPH_COUNT)
    .u16(4) // maxPoints
    .u16(1) // maxContours
    .u16(0)
    .u16(0)
    .u16(1) // maxZones
    .zeros(16)
    .toBytes();
}

function os2(): Uint8Array {
  return new Writer()
    .u16(4)
    .i16(ADVANCE) // xAvgCharWidth
    .u16(400)
    .u16(5)
    .u16(0) // fsType: installable
    .i16(650)
    .i16(700)
    .i16(0)
    .i16(140)
    .i16(650)
    .i16(700)
    .i16(0)
    .i16(480)
    .i16(100) // yStrikeoutSize
    .i16(530)
    .i16(0) // sFamilyClass
    .u8(2) // PANOSE: Latin text …
    .u8(0)
    .u8(0)
    .u8(9) // … monospaced
    .zeros(6)
    .u32(1) // ulUnicodeRange1: Basic Latin
    .zeros(12)
    .tag("NONE")
    .u16(0x00c0) // fsSelection: REGULAR | USE_TYPO_METRICS
    .u16(FIRST_CHAR)
    .u16(LAST_CHAR)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(ASCENT) // usWinAscent
    .u16(DESCENT)
    .u32(1) // ulCodePageRange1: Latin 1
    .u32(0)
    .i16(1100) // sxHeight
    .i16(1400) // sCapHeight
    .u16(0)
    .u16(0x20)
    .u16(1)
    .toBytes();
}

function cmap(): Uint8Array {
  // One format 4 subtable (Windows, Unicode BMP): FIRST_CHAR..LAST_CHAR → glyphs 1.., plus the
  // required final 0xFFFF segment.
  const segments = 2;
  const w = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12);
  w.u16(4)
    .u16(16 + segments * 8)
    .u16(0)
    .u16(segments * 2)
    .u16(4) // searchRange
    .u16(1) // entrySelector
    .u16(0) // rangeShift
    .u16(LAST_CHAR)
    .u16(0xffff)
    .u16(0)
    .u16(FIRST_CHAR)
    .u16(0xffff)
    .i16(1 - FIRST_CHAR)
    .i16(1)
    .u16(0)
    .u16(0);
  return w.toBytes();
}

function name(): Uint8Array {
  const records: Array<[number, string]> = [
    [1, ORACLE_FONT_FAMILY],
    [2, "Regular"],
    [4, `${ORACLE_FONT_FAMILY} Regular`],
    [6, "DDLVimOracle-Regular"],
  ];
  const strings = new Writer();
  const w = new Writer()
    .u16(0)
    .u16(records.length)
    .u16(6 + records.length * 12);
  for (const [id, value] of records) {
    w.u16(3)
      .u16(1)
      .u16(0x0409)
      .u16(id)
      .u16(value.length * 2)
      .u16(strings.length);
    for (const char of value) strings.u16(char.charCodeAt(0));
  }
  const bytes = strings.toBytes();
  for (const byte of bytes) w.u8(byte);
  return w.toBytes();
}

function post(): Uint8Array {
  return new Writer()
    .u32(0x00030000)
    .u32(0) // italicAngle
    .i16(-100)
    .i16(50)
    .u32(1) // isFixedPitch
    .zeros(16)
    .toBytes();
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word =
      ((bytes[i] ?? 0) << 24) |
      ((bytes[i + 1] ?? 0) << 16) |
      ((bytes[i + 2] ?? 0) << 8) |
      (bytes[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** The font file (TrueType, `font/ttf`). */
export function buildOracleFont(): Uint8Array {
  const { glyf, loca } = glyphTables();
  const tables: Array<[string, Uint8Array]> = [
    ["OS/2", os2()],
    ["cmap", cmap()],
    ["glyf", glyf],
    ["head", head()],
    ["hhea", hhea()],
    ["hmtx", hmtx()],
    ["loca", loca],
    ["maxp", maxp()],
    ["name", name()],
    ["post", post()],
  ];
  const directorySize = 12 + tables.length * 16;
  const offsets: number[] = [];
  let offset = directorySize;
  for (const [, data] of tables) {
    offsets.push(offset);
    offset += Math.ceil(data.length / 4) * 4;
  }
  const font = new Uint8Array(offset);
  const directory = new Writer()
    .u32(0x00010000)
    .u16(tables.length)
    .u16(128) // searchRange: 8 tables * 16
    .u16(3)
    .u16(tables.length * 16 - 128);
  tables.forEach(([tag, data], i) => {
    directory.tag(tag).u32(checksum(data)).u32(offsets[i]!).u32(data.length);
    font.set(data, offsets[i]!);
  });
  font.set(directory.toBytes(), 0);
  const headOffset = offsets[tables.findIndex(([tag]) => tag === "head")]!;
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  new DataView(font.buffer).setUint32(headOffset + 8, adjustment);
  return font;
}
