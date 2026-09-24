import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  isBlankTaskText,
  isTaskLine,
  type ParsedTask,
  parseTasks,
  setStatusCharOnLine,
  statusFromChar,
  toggleTaskLine,
} from "./tasks";
import { parseWikiLinks } from "./wikilinks";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE =
  Number(
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
      .TEST_TIME_SCALE,
  ) || 1;

// ── Independent restatement of the grammar (no regex shared with the parser) ──────────────────

interface OracleTask {
  indent: number;
  marker: string;
  statusChar: string;
  statusOffset: number;
  text: string;
}

const isBlank = (ch: string | undefined) => ch === " " || ch === "\t";

/** `[ \t]*` + (`-`/`*`/`+` | 1-9 digits + `.`/`)`) + `[ \t]+` + `[` + one code unit + `]` + end or blank. */
function oracleTask(line: string): OracleTask | null {
  let i = 0;
  let indent = 0;
  while (isBlank(line[i])) indent += line[i++] === "\t" ? 4 : 1;
  const markerStart = i;
  if (line[i] === "-" || line[i] === "*" || line[i] === "+") i++;
  else {
    while (i < line.length && line[i]! >= "0" && line[i]! <= "9") i++;
    const digits = i - markerStart;
    if (digits < 1 || digits > 9 || (line[i] !== "." && line[i] !== ")")) return null;
    i++;
  }
  const marker = line.slice(markerStart, i);
  const gapStart = i;
  while (isBlank(line[i])) i++;
  if (i === gapStart || line[i] !== "[" || i + 2 >= line.length || line[i + 2] !== "]") {
    return null;
  }
  const rest = line.slice(i + 3);
  if (rest !== "" && !isBlank(rest[0])) return null;
  return { indent, marker, statusChar: line[i + 1]!, statusOffset: i + 1, text: rest.trim() };
}

function fenceOpener(line: string): { char: string; length: number } | null {
  let i = 0;
  while (isBlank(line[i])) i++;
  const char = line[i];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (line[i + length] === char) length++;
  if (length < 3) return null;
  if (char === "`" && line.slice(i + length).includes("`")) return null;
  return { char, length };
}

function closesFence(line: string, fence: { char: string; length: number }): boolean {
  let i = 0;
  while (isBlank(line[i])) i++;
  let length = 0;
  while (line[i + length] === fence.char) length++;
  if (length < fence.length) return false;
  for (let j = i + length; j < line.length; j++) if (!isBlank(line[j])) return false;
  return true;
}

const FRONTMATTER_DELIMITER = /^(?:---|\.\.\.)\s*$/;

/** A normal-context line that the generator must not produce by accident. */
const isStructural = (line: string) =>
  oracleTask(line) !== null || fenceOpener(line) !== null || FRONTMATTER_DELIMITER.test(line);

// ── Generators ───────────────────────────────────────────────────────────────────────────────

const indentArb = fc
  .array(fc.constantFrom(" ", "  ", "\t"), { maxLength: 3 })
  .map((parts) => parts.join(""));
const markerArb = fc.constantFrom("-", "*", "+", "1.", "2)", "10.", "10)", "123456789.");
const gapArb = fc.constantFrom(" ", "  ", "\t", " \t");
const statusArb = fc.constantFrom(
  " ",
  "x",
  "X",
  "/",
  "-",
  ">",
  "<",
  "?",
  "!",
  "*",
  "✓",
  "é",
  "$",
  "[",
  "]",
  "\u2028",
);
const LONG = "a".repeat(400);
const wordArb = fc.constantFrom(
  "buy",
  "milk",
  "Call",
  "mom",
  "[[Daily/2026-09-24]]",
  "[[Note#Heading|alias]]",
  "![[img.png]]",
  "`code`",
  "#tag",
  "🎉",
  "👩‍💻",
  "שלום",
  "مرحبا",
  "日本語",
  "café",
  "e\u0301",
  "[ ]",
  "[x]",
  "- [ ]",
  "...",
  "…",
  "--",
  "\t",
  "\u00a0",
  "\u2028",
  "a\rb",
  "$1",
  "$&",
  LONG,
);
const textArb = fc.array(wordArb, { maxLength: 8 }).map((words) => words.join(" "));

const taskLineArb = fc
  .record({
    indent: indentArb,
    marker: markerArb,
    gap: gapArb,
    status: statusArb,
    rest: fc.option(fc.tuple(gapArb, textArb), { nil: undefined }),
  })
  .map(({ indent, marker, gap, status, rest }) => {
    const tail = rest ? `${rest[0]}${rest[1]}` : "";
    return `${indent}${marker}${gap}[${status}]${tail}`;
  });

const otherLineArb = fc
  .oneof(
    fc.constantFrom(
      "",
      "   ",
      "\t",
      "## [ ] heading with a box",
      "# - [ ] heading",
      "> - [ ] quoted task",
      ">   * [x] quoted done",
      "| a | - [ ] | b |",
      "|---|---|",
      "- [ ]foo",
      "-[ ] foo",
      "- [  ] foo",
      "- [xx] foo",
      "- [🎉] astral status",
      "1234567890. [ ] ten digits",
      "a. [ ] letter marker",
      "(1) [ ] parenthesized",
      "***",
      "* * *",
      "- - -",
      "``",
      "~~",
      "  continuation line",
      "\tindented note",
    ),
    textArb.map((t) => `# ${t}`),
    textArb.map((t) => `- ${t}`),
    textArb.map((t) => `  - ${t}`),
    textArb,
  )
  .map((line) => (line.endsWith("\r") ? `${line}.` : line))
  .filter((line) => !isStructural(line));

interface GenLine {
  text: string;
  inCode: boolean;
}

const normalBlockArb = fc
  .array(fc.oneof({ weight: 3, arbitrary: taskLineArb }, { weight: 2, arbitrary: otherLineArb }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((lines) => lines.map((text): GenLine => ({ text, inCode: false })));

const fenceArb = fc
  .record({
    char: fc.constantFrom("`", "~"),
    length: fc.integer({ min: 3, max: 5 }),
    indent: fc.constantFrom("", "  ", "\t"),
    // Never starts with the fence character: that would just lengthen the fence.
    info: fc.constantFrom("", "js", " ts title", " ~", "with spaces"),
    body: fc.array(
      fc.oneof(
        taskLineArb,
        otherLineArb,
        fc.constantFrom("```js", "~~~~~~ trailing", "``", "````x", "---", "..."),
      ),
      { maxLength: 6 },
    ),
    extra: fc.integer({ min: 0, max: 2 }),
    trail: fc.constantFrom("", " ", "\t"),
  })
  .map(({ char, length, indent, info, body, extra, trail }) => {
    const fence = { char, length };
    const open = `${indent}${char.repeat(length)}${info}`;
    const content = body.filter((line) => !closesFence(line, fence));
    const close = `${indent}${char.repeat(length + extra)}${trail}`;
    return { open, content, close };
  });

const closedFenceBlockArb = fenceArb.map(({ open, content, close }): GenLine[] => [
  { text: open, inCode: true },
  ...content.map((text) => ({ text, inCode: true })),
  { text: close, inCode: true },
]);

const unterminatedFenceArb = fenceArb.map(({ open, content }): GenLine[] => [
  { text: open, inCode: true },
  ...content.map((text) => ({ text, inCode: true })),
]);

const frontmatterArb = fc
  .record({
    open: fc.constantFrom("---", "---  "),
    yaml: fc.array(
      fc.oneof(
        taskLineArb,
        fc.constantFrom("tags: [daily]", "title: x", "- item", "  - [ ] nested"),
      ),
      { maxLength: 5 },
    ),
    close: fc.constantFrom("---", "...", "--- ", "...\t"),
  })
  .map(({ open, yaml, close }): GenLine[] => [
    { text: open, inCode: true },
    ...yaml.map((text) => ({ text, inCode: true })),
    { text: close, inCode: true },
  ]);

interface GeneratedDoc {
  doc: string;
  lines: GenLine[];
  bom: boolean;
}

const docArb: fc.Arbitrary<GeneratedDoc> = fc
  .record({
    bom: fc.boolean(),
    front: fc.option(frontmatterArb, { nil: undefined }),
    blocks: fc.array(fc.oneof({ weight: 3, arbitrary: normalBlockArb }, closedFenceBlockArb), {
      maxLength: 5,
    }),
    tail: fc.option(unterminatedFenceArb, { nil: undefined }),
    crlf: fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
    finalNewline: fc.boolean(),
  })
  .map(({ bom, front, blocks, tail, crlf, finalNewline }) => {
    const lines = [...(front ?? []), ...blocks.flat(), ...(tail ?? [])];
    let doc = bom ? "\uFEFF" : "";
    lines.forEach((line, i) => {
      doc += line.text;
      if (i < lines.length - 1 || finalNewline) doc += crlf[i % crlf.length] ? "\r\n" : "\n";
    });
    return { doc, lines, bom };
  });

// ── Invariants ───────────────────────────────────────────────────────────────────────────────

/** The parser's notion of a line: split on `\n`, one trailing `\r` dropped, leading BOM dropped. */
function sourceLines(doc: string): string[] {
  const body = doc.startsWith("\uFEFF") ? doc.slice(1) : doc;
  return body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function checkInvariants(doc: string, tasks: readonly ParsedTask[]): void {
  const source = sourceLines(doc);
  const byLine = new Map(tasks.map((t) => [t.line, t]));
  let previousLine = -1;
  for (const t of tasks) {
    expect(t.line).toBeGreaterThan(previousLine);
    previousLine = t.line;
    expect(t.raw).toBe(source[t.line]);
    expect(doc.slice(t.from, t.to)).toBe(t.raw);
    expect(t.from).toBeLessThanOrEqual(t.textFrom);
    expect(t.textFrom).toBeLessThanOrEqual(t.to);
    expect(doc.slice(t.textFrom, t.to).trim()).toBe(t.text);
    expect(t.text).toBe(t.text.trim());
    expect(isTaskLine(t.raw)).toBe(true);
    expect(t.status).toBe(statusFromChar(t.statusChar));
    const oracle = oracleTask(t.raw);
    expect(oracle).toMatchObject({
      indent: t.indent,
      marker: t.marker,
      statusChar: t.statusChar,
      text: t.text,
    });
    expect(t.depth).toBeGreaterThanOrEqual(0);
    if (t.depth === 0) expect(t.parentLine).toBeNull();
    if (t.parentLine !== null) {
      const parent = byLine.get(t.parentLine);
      expect(parent, `parent of line ${t.line}`).toBeDefined();
      expect(parent!.line).toBeLessThan(t.line);
      expect(parent!.indent).toBeLessThan(t.indent);
      expect(parent!.depth).toBeLessThan(t.depth);
    }
    for (const note of t.notes) {
      expect(note).toBe(note.trim());
      expect(note).not.toBe("");
      expect(note).not.toContain("\n");
    }
    expect(t.links).toEqual(parseWikiLinks(t.text).map((link) => link.target));
  }
}

// ── Properties ───────────────────────────────────────────────────────────────────────────────

describe("parseTasks (generated markdown)", () => {
  test.prop([docArb])(
    "reports exactly the task lines outside code fences and frontmatter",
    ({ doc, lines }) => {
      const tasks = parseTasks(doc);
      const expected = lines.flatMap((line, i) =>
        !line.inCode && oracleTask(line.text) ? [i] : [],
      );
      expect(tasks.map((t) => t.line)).toEqual(expected);
      checkInvariants(doc, tasks);
    },
  );

  test.prop([docArb])("line endings and a leading BOM change offsets only", ({ doc, bom }) => {
    const plain = (bom ? doc.slice(1) : doc).replace(/\r\n/g, "\n");
    const shape = (tasks: ParsedTask[]) =>
      tasks.map(({ from: _f, to: _t, textFrom: _x, ...rest }) => rest);
    const reference = parseTasks(plain);
    expect(shape(parseTasks(plain.replace(/\n/g, "\r\n")))).toEqual(shape(reference));
    const withBom = parseTasks(`\uFEFF${plain}`);
    expect(shape(withBom)).toEqual(shape(reference));
    expect(withBom.map((t) => t.from)).toEqual(reference.map((t) => t.from + 1));
  });

  test.prop([fc.string({ unit: "binary", maxLength: 400 })])(
    "never throws on arbitrary text and keeps its invariants",
    (doc) => {
      checkInvariants(doc, parseTasks(doc));
    },
  );

  test.prop([
    fc.array(fc.oneof(taskLineArb, otherLineArb, fc.constantFrom("```", "~~~", "---")), {
      maxLength: 30,
    }),
  ])("never throws on structure soup and keeps its invariants", (lines) => {
    const doc = lines.join("\n");
    checkInvariants(doc, parseTasks(doc));
  });
});

describe("parseTasks edge cases (decided behavior)", () => {
  const lines = (doc: string) => parseTasks(doc).map((t) => t.line);
  const only = (doc: string) => {
    const tasks = parseTasks(doc);
    expect(tasks).toHaveLength(1);
    return tasks[0]!;
  };

  it.each([
    ["- [ ]", ""],
    ["- [ ] ", ""],
    ["* [X] upper-case done", "upper-case done"],
    ["+ [/] in progress", "in progress"],
    ["10) [>] forwarded", "forwarded"],
    ["123456789. [ ] nine-digit marker", "nine-digit marker"],
    ["- [ ]\ttab before text", "tab before text"],
    ["\t- [ ] tab indent", "tab indent"],
    ["- [ ] trailing spaces   ", "trailing spaces"],
    ["- [ ] [ ] brackets in the text", "[ ] brackets in the text"],
    ["- [ ] line\u2028separator", "line\u2028separator"],
    ["- [ ] lone\rCR is not a line break", "lone\rCR is not a line break"],
    ["- []] bracket status", "bracket status"],
  ])("%j is a task with text %j", (doc, text) => {
    expect(only(doc).text).toBe(text);
  });

  it.each([
    ["-[ ] no space after the marker"],
    ["- [  ] two spaces in the box"],
    ["- [xx] two characters in the box"],
    ["- [ ]glued text"],
    ["- [🎉] astral status (two code units)"],
    ["1234567890. [ ] ten-digit marker"],
    ["a. [ ] letter marker"],
    ["# [ ] heading"],
    ["## - [ ] heading with a task-like tail"],
    ["| - [ ] | table cell |"],
    // The editor renders quoted tasks, but the orchestrator deliberately ignores them.
    ["> - [ ] quoted task"],
    ["[ ] no marker"],
  ])("%j is not a task", (doc) => {
    expect(parseTasks(doc)).toEqual([]);
  });

  it("maps every status character", () => {
    const statuses = [" ", "x", "X", "/", "-", ">", "<", "?"].map(
      (ch) => only(`- [${ch}] t`).status,
    );
    expect(statuses).toEqual([
      "open",
      "done",
      "done",
      "in_progress",
      "cancelled",
      "deferred",
      "deferred",
      "other",
    ]);
  });

  it("an accidentally indented task stays a task (indented code blocks are not a thing)", () => {
    const task = only("Some paragraph\n\n    - [ ] indented four spaces");
    expect(task).toMatchObject({ indent: 4, depth: 0, parentLine: null });
  });

  it("fences: shorter or different closers do not close, unterminated fences run to the end", () => {
    expect(lines("```\n- [ ] in code\n```\n- [ ] after")).toEqual([3]);
    expect(lines("~~~~\n- [ ] a\n~~~\n- [ ] b\n~~~~\n- [ ] c")).toEqual([5]);
    expect(lines("```\n- [ ] a\n~~~\n- [ ] b")).toEqual([]);
    expect(lines("- [ ] before\n  ```\n  - [ ] indented fence body")).toEqual([0]);
    expect(lines("````\n```\n- [ ] still code\n````\n- [ ] out")).toEqual([4]);
  });

  it("fences: a closing fence carries no info string (CommonMark)", () => {
    expect(lines("```js\n- [ ] a\n``` not a closer\n- [ ] b\n```\n- [ ] c")).toEqual([5]);
  });

  it("fences: backticks in a backtick info string mean inline code, not a fence", () => {
    expect(lines("```npm install``` fixed the build\n- [ ] ship it")).toEqual([1]);
    expect(lines("~~~ info with ` backtick\n- [ ] in code\n~~~\n- [ ] out")).toEqual([3]);
  });

  it("frontmatter: `---` … `---`/`...` on the first line only, like the editor", () => {
    expect(lines("---\ntags: [a]\n- [ ] yaml\n---\n- [ ] body")).toEqual([4]);
    expect(lines("---\n- [ ] yaml\n...\n- [ ] body")).toEqual([3]);
    expect(lines("--- \n- [ ] yaml\n---\t\n- [ ] body")).toEqual([3]);
    expect(lines("\n---\n- [ ] not frontmatter\n---")).toEqual([2]);
  });

  it("frontmatter: an unclosed `---` is a thematic break, not frontmatter", () => {
    expect(lines("---\n- [ ] one\n- [ ] two")).toEqual([1, 2]);
  });

  it("frontmatter: must close within 200 lines, like the editor", () => {
    const yaml = Array.from({ length: 199 }, (_, i) => `k${i}: v`);
    expect(lines(["---", ...yaml.slice(0, 198), "---", "- [ ] body"].join("\n"))).toEqual([200]);
    expect(lines(["---", ...yaml, "---", "- [ ] body"].join("\n"))).toEqual([201]);
  });

  it("a leading BOM is not part of the first line", () => {
    const task = only("\uFEFF- [ ] first");
    expect(task).toMatchObject({ line: 0, raw: "- [ ] first", from: 1, text: "first" });
    expect(lines("\uFEFF---\n- [ ] yaml\n---\n- [ ] body")).toEqual([3]);
  });

  it("CRLF documents keep offsets exact", () => {
    const doc = "- [ ] one\r\n  - [x] two\r\n";
    for (const t of parseTasks(doc)) expect(doc.slice(t.from, t.to)).toBe(t.raw);
    expect(parseTasks(doc).map((t) => [t.text, t.parentLine])).toEqual([
      ["one", null],
      ["two", 0],
    ]);
  });

  it("nesting: parents skip plain bullets, notes collect nested non-task lines", () => {
    const doc = [
      "- [ ] parent",
      "  - plain bullet",
      "    - [ ] grandchild under a plain bullet",
      "      deep note",
      "  1) numbered note",
      "- [ ] sibling",
      "lazy continuation at column 0",
    ].join("\n");
    const [parent, grandchild, sibling] = parseTasks(doc);
    expect(parent).toMatchObject({ depth: 0, notes: ["plain bullet", "numbered note"] });
    expect(grandchild).toMatchObject({ depth: 2, parentLine: 0, notes: ["deep note"] });
    expect(sibling).toMatchObject({ depth: 0, parentLine: null, notes: [] });
  });

  it("pathological lines parse in linear time", () => {
    const hostile = [
      `- [ ]${" ".repeat(100_000)}x\u2028`,
      `-${" \t".repeat(50_000)}`,
      `- ${" ".repeat(100_000)}\r\r`,
      `${"`".repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const line of hostile) parseTasks(`${line}\n- [ ] after`);
    expect(performance.now() - started).toBeLessThan(250 * TIME_SCALE);
  });
});

describe("task line edits", () => {
  const taskArb = taskLineArb.filter((line) => !line.includes("\n"));
  const lineArb = fc.oneof(taskArb, otherLineArb, fc.string({ unit: "binary", maxLength: 40 }));
  const charArb = fc.oneof(
    statusArb,
    fc.constantFrom("$", "$$", "$&", "$1", "$`", "$'"),
    fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }),
  );

  test.prop([lineArb, charArb])("non-task lines are never touched", (line, ch) => {
    fc.pre(!isTaskLine(line));
    expect(toggleTaskLine(line)).toBe(line);
    expect(setStatusCharOnLine(line, ch)).toBe(line);
  });

  test.prop([taskArb, statusArb])(
    "setStatusCharOnLine replaces exactly the status character, literally",
    (line, ch) => {
      const before = oracleTask(line)!;
      const after = setStatusCharOnLine(line, ch);
      expect(after).toBe(
        line.slice(0, before.statusOffset) + ch + line.slice(before.statusOffset + 1),
      );
      expect(oracleTask(after)?.statusChar).toBe(ch);
      expect(setStatusCharOnLine(after, ch)).toBe(after);
      expect(setStatusCharOnLine(line, before.statusChar)).toBe(line);
    },
  );

  test.prop([taskArb])("toggle checks anything not done and unchecks done", (line) => {
    const { statusChar } = oracleTask(line)!;
    const done = statusChar === "x" || statusChar === "X";
    const toggled = toggleTaskLine(line);
    expect(toggled).toBe(setStatusCharOnLine(line, done ? " " : "x"));
    expect(toggleTaskLine(toggled)).toBe(setStatusCharOnLine(line, done ? "x" : " "));
    if (statusChar === " " || statusChar === "x") expect(toggleTaskLine(toggled)).toBe(line);
  });

  it("replacement patterns in the status character are inserted literally", () => {
    expect(setStatusCharOnLine("- [ ] pay", "$")).toBe("- [$] pay");
    expect(setStatusCharOnLine("- [ ] pay", "$&")).toBe("- [$&] pay");
    expect(setStatusCharOnLine("1. [ ] a", "/")).toBe("1. [/] a");
  });

  it("toggling an alternate status marks it done, like the editor", () => {
    expect(toggleTaskLine("- [/] started")).toBe("- [x] started");
    expect(toggleTaskLine("- [-] cancelled")).toBe("- [x] cancelled");
    expect(toggleTaskLine("- [X] done")).toBe("- [ ] done");
  });
});

describe("isBlankTaskText", () => {
  const fillerArb = fc
    .array(fc.constantFrom(" ", "\t", ".", "…", "-", "\u00a0"), { maxLength: 6 })
    .map((parts) => parts.join(""));

  test.prop([fillerArb, fillerArb, fc.constantFrom("", "a", "猫")])(
    "filler around at most one character is blank",
    (left, right, core) => {
      expect(isBlankTaskText(`${left}${core}${right}`)).toBe(true);
    },
  );

  test.prop([fillerArb, fc.string({ unit: "grapheme-ascii", minLength: 2, maxLength: 20 })])(
    "two or more meaningful characters are not blank",
    (filler, word) => {
      fc.pre(word.replace(/[\s.…-]/g, "").length >= 2);
      expect(isBlankTaskText(`${filler}${word}${filler}`)).toBe(false);
    },
  );

  it("blank template tasks from the parser are blank", () => {
    for (const t of parseTasks("- [ ]\n- [ ] \n- [ ] …\n- [ ] - ")) {
      expect(isBlankTaskText(t.text)).toBe(true);
    }
  });

  it("counts UTF-16 code units: a lone astral emoji is not blank", () => {
    expect(isBlankTaskText("🎉")).toBe(false);
    expect(isBlankTaskText("é")).toBe(true);
  });
});
