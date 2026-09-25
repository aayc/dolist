/**
 * Drawing files in the Obsidian Excalidraw plugin's markdown format (`Name.excalidraw.md`):
 *
 *     ---
 *
 *     excalidraw-plugin: parsed
 *     tags: [excalidraw]
 *
 *     ---
 *     ==⚠  Switch to EXCALIDRAW VIEW … ⚠== …
 *
 *     # Excalidraw Data
 *
 *     ## Text Elements
 *     API ^k3JwQm9a
 *
 *     %%
 *     ## Drawing
 *     ```json
 *     { "type": "excalidraw", "version": 2, "source": …, "elements": […], "appState": {…}, "files": {…} }
 *     ```
 *     %%
 *
 * We write `json`; we read `json` and `compressed-json` (LZ-String base64 in 256-character lines
 * separated by blank lines, the plugin's default). Everything we don't regenerate (frontmatter
 * keys, the text above `# Excalidraw Data`, `## Element Links`, `## Embedded Files`, unknown
 * sections and fields) is kept when the previous file is given.
 */
import { formatDate } from "../dates";
import { basename } from "../paths";
import { compressToBase64, decompressFromBase64 } from "./lz-string";
import {
  DRAWING_PLUGIN_SOURCE_PREFIX,
  DRAWING_SCENE_SOURCE,
  type DrawingAppState,
  type DrawingBinaryFiles,
  type DrawingElement,
  type DrawingScene,
  emptyDrawingScene,
} from "./types";

/** The plugin's default folder for new drawings. */
export const DRAWINGS_FOLDER = "Excalidraw";
export const DRAWING_FILE_EXTENSION = ".excalidraw.md";

/** The line the plugin writes under the frontmatter, for readers without the plugin. */
export const DRAWING_NOTICE =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'";

const DEFAULT_FRONTMATTER = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";
const COMPRESSED_LINE_CHARS = 256;

export type DrawingProblemCode =
  /** No `## Drawing` block with a json or compressed-json fence. */
  | "no-drawing"
  | "decompress-failed"
  | "invalid-json"
  /** The JSON isn't an object with an `elements` array. */
  | "not-a-scene"
  /** Elements without a string `id` and `type` were dropped. */
  | "invalid-element"
  /** The fence isn't closed; the rest of the file was read as the scene. */
  | "unclosed-fence";

export interface DrawingProblem {
  code: DrawingProblemCode;
  /** `error`: the scene couldn't be read (see `ParsedDrawingFile.readable`). */
  severity: "error" | "warning";
  message: string;
}

export interface DrawingFrontmatter {
  /** The whole block with its `---` fences and final line break; `""` when there is none. */
  raw: string;
  /** Top-level `key: value` lines, values as written (`tags` → `"[excalidraw]"`). */
  entries: Record<string, string>;
}

/** One `## Text Elements` entry: the text, then ` ^<element id>` (an Obsidian block reference). */
export interface DrawingTextEntry {
  id: string;
  text: string;
}

/** A part of the file after the frontmatter, split at headings. */
export interface DrawingFileSection {
  /** The heading line (`## Embedded Files`); `""` for the text above the drawing data. */
  heading: string;
  /** Everything after the heading line, up to the next section, verbatim. */
  body: string;
}

export interface ParsedDrawingFile {
  /** The scene; empty when it couldn't be read. */
  scene: DrawingScene;
  frontmatter: DrawingFrontmatter;
  /** As listed under `## Text Elements`. Where one differs from its element, it was applied to the scene. */
  textElements: DrawingTextEntry[];
  sections: DrawingFileSection[];
  /** The scene was stored as `compressed-json`. */
  compressed: boolean;
  /** False when the scene couldn't be read: show the problem and don't save over the file. */
  readable: boolean;
  problems: DrawingProblem[];
}

/** Thrown by `serializeDrawingFile` when asked to write over a file whose scene couldn't be read. */
export class DrawingUnreadableError extends Error {
  readonly problems: readonly DrawingProblem[];

  constructor(problems: readonly DrawingProblem[]) {
    super(
      `The previous drawing couldn't be read (${problems.map((p) => p.code).join(", ")}); writing would lose it`,
    );
    this.name = "DrawingUnreadableError";
    this.problems = problems;
  }
}

// ── Paths and names ──────────────────────────────────────────────────────────

export function isDrawingPath(path: string): boolean {
  return path.toLowerCase().endsWith(DRAWING_FILE_EXTENSION);
}

/**
 * True when a markdown file's frontmatter has the plugin's `excalidraw-plugin` key, whatever the
 * file is called (the plugin can turn any note into a drawing). Reads only the frontmatter.
 */
export function isDrawingMarkdown(text: string): boolean {
  const block = splitFrontmatter(text);
  return block !== null && /^["']?excalidraw-plugin["']?[ \t]*:/m.test(block.inner);
}

/** The plugin's name for a drawing made at `date` (local time): `Drawing 2026-09-25 11.52.33`. */
export function newDrawingName(date: Date = new Date()): string {
  return `Drawing ${formatDate(date, "YYYY-MM-DD HH.mm.ss")}`;
}

/** Characters Obsidian refuses in file names, or that break wikilinks. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** `Excalidraw/<name>.excalidraw.md`, with characters that don't belong in a file name removed. */
export function drawingPathForName(name: string, folder: string = DRAWINGS_FOLDER): string {
  const clean =
    name
      .replace(/(\.excalidraw)?(\.md)?$/i, "")
      .replace(UNSAFE_NAME_CHARS, " ")
      .replace(/\s+/g, " ")
      .trim() || "Drawing";
  return folder
    ? `${folder}/${clean}${DRAWING_FILE_EXTENSION}`
    : `${clean}${DRAWING_FILE_EXTENSION}`;
}

/** `drawingPathForName`, then `<name>_0`, `<name>_1`, … while `exists` says it's taken (the plugin's rule). */
export function uniqueDrawingPath(
  name: string,
  exists: (path: string) => boolean,
  folder: string = DRAWINGS_FOLDER,
): string {
  const path = drawingPathForName(name, folder);
  if (!exists(path)) return path;
  const stemPath = path.slice(0, -DRAWING_FILE_EXTENSION.length);
  for (let i = 0; ; i++) {
    const candidate = `${stemPath}_${i}${DRAWING_FILE_EXTENSION}`;
    if (!exists(candidate)) return candidate;
  }
}

const ELEMENT_ID_ALPHABET = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * A new element id as the plugin makes them: 8 characters from [0-9a-zA-Z]. The plugin reads
 * `## Text Elements` references as exactly 8 characters and gives longer ids (Excalidraw's) new
 * ones when it opens the file; Obsidian block references allow no `_`.
 */
export function newDrawingElementId(): string {
  const bytes = new Uint8Array(8);
  const crypto = (globalThis as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } })
    .crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let id = "";
  for (const byte of bytes) id += ELEMENT_ID_ALPHABET[byte % ELEMENT_ID_ALPHABET.length];
  return id;
}

/** The drawing's name, for titles: `Excalidraw/Plan.excalidraw.md` → `Plan`. */
export function drawingTitleFromPath(path: string): string {
  return basename(path).replace(/(\.excalidraw)?(\.md)?$/i, "");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const DRAWING_HEADINGS = /^##? Drawing[ \t]*$/gm;
const DRAWING_HEADING = /^##? Drawing[ \t]*$/;
const SCENE_FENCE = /^```(json|compressed-json)[ \t]*$/;
const CLOSING_FENCE = /^```[ \t]*$/m;
const DATA_HEADING = /^# Excalidraw Data[ \t]*$/m;
const TEXT_HEADING = /^##? Text Elements[ \t]*$/;
const TEXT_HEADING_M = /^##? Text Elements[ \t]*$/m;
/** Headings that end `## Text Elements` (text elements may themselves contain `#` lines). */
const AFTER_TEXT_HEADING = /^##? (?:Element Links|Embedded [Ff]iles)[ \t]*$/;
const HEADING = /^#{1,6}(?:[ \t].*)?$/;
const COMMENT_LINE = /^%%[ \t]*(?:\n|$)/;
/** ` ^id` at the end of a line: the end of one text entry. */
const BLOCK_REF = /(?<=^|\s)\^(\S+)[ \t]*(?:\n+|$)/g;

interface DrawingBlock {
  /** Where the `## Drawing` heading line starts. */
  start: number;
  heading: string;
  /** After the heading line. */
  bodyStart: number;
  /** After the closing fence and the `%%` line that follows it. */
  end: number;
  format: "json" | "compressed-json";
  content: string;
  closed: boolean;
}

/**
 * Reads a drawing file. Never throws: what it can't read is reported in `problems`, and a file
 * whose scene is unreadable comes back with an empty scene and `readable: false`.
 */
export function parseDrawingFile(text: string): ParsedDrawingFile {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const problems: DrawingProblem[] = [];
  const block = splitFrontmatter(source);
  const frontmatter: DrawingFrontmatter = {
    raw: block?.raw ?? "",
    entries: block ? frontmatterEntries(block.inner) : {},
  };
  const body = source.slice(frontmatter.raw.length);
  const drawing = findDrawingBlock(body);

  let scene: DrawingScene | null = null;
  if (!drawing) {
    problems.push({
      code: "no-drawing",
      severity: "error",
      message: "The file has no `## Drawing` section with the scene.",
    });
  } else {
    if (!drawing.closed) {
      problems.push({
        code: "unclosed-fence",
        severity: "warning",
        message: "The scene's code block isn't closed; read it to the end of the file.",
      });
    }
    scene = readScene(drawing, problems);
  }

  const sections = splitSections(body, drawing);
  const drawingIndex = drawing ? findDrawingSection(sections) : sections.length;
  const textIndex = findSection(sections, TEXT_HEADING, drawingIndex);
  const ids = scene ? new Set(scene.elements.map((element) => element.id)) : null;
  const textElements =
    textIndex === -1 ? [] : readTextEntries(sections[textIndex]!.body, ids).entries;
  if (scene) applyTextEntries(scene, textElements);

  return {
    scene: scene ?? emptyDrawingScene(),
    frontmatter,
    textElements,
    sections,
    compressed: drawing?.format === "compressed-json",
    readable: scene !== null,
    problems,
  };
}

function splitFrontmatter(text: string): { raw: string; inner: string } | null {
  if (!text.startsWith("---")) return null;
  const first = text.indexOf("\n");
  if (first === -1 || text.slice(0, first).trimEnd() !== "---") return null;
  for (let pos = first + 1; pos < text.length; ) {
    const newline = text.indexOf("\n", pos);
    const end = newline === -1 ? text.length : newline;
    if (text.slice(pos, end).trimEnd() === "---") {
      return {
        raw: text.slice(0, newline === -1 ? end : newline + 1),
        inner: text.slice(first + 1, pos),
      };
    }
    pos = end + 1;
  }
  return null;
}

function frontmatterEntries(inner: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of inner.split("\n")) {
    if (line === "" || /^[\s#-]/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line
      .slice(0, colon)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key) setOwn(entries, key, line.slice(colon + 1).trim());
  }
  return entries;
}

/** The last `## Drawing` heading followed (after blank lines) by a json or compressed-json fence. */
function findDrawingBlock(body: string): DrawingBlock | null {
  let found: DrawingBlock | null = null;
  for (const match of body.matchAll(DRAWING_HEADINGS)) {
    const block = readDrawingBlock(body, match.index, match[0]);
    if (block) found = block;
  }
  return found;
}

function readDrawingBlock(body: string, start: number, heading: string): DrawingBlock | null {
  const bodyStart = Math.min(body.length, start + heading.length + 1);
  let pos = bodyStart;
  for (;;) {
    if (pos >= body.length) return null;
    const newline = body.indexOf("\n", pos);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(pos, lineEnd);
    if (line.trim() !== "") {
      const fence = SCENE_FENCE.exec(line);
      if (!fence) return null;
      const contentStart = Math.min(body.length, lineEnd + 1);
      const rest = body.slice(contentStart);
      const close = CLOSING_FENCE.exec(rest);
      const format = fence[1] as DrawingBlock["format"];
      if (!close) {
        return {
          start,
          heading,
          bodyStart,
          end: body.length,
          format,
          content: rest.replace(/\n%%[ \t]*\n*$/, "\n"),
          closed: false,
        };
      }
      let end = contentStart + close.index + close[0].length;
      if (body[end] === "\n") end++;
      const comment = COMMENT_LINE.exec(body.slice(end));
      if (comment) end += comment[0].length;
      return {
        start,
        heading,
        bodyStart,
        end,
        format,
        content: rest.slice(0, close.index),
        closed: true,
      };
    }
    pos = lineEnd + 1;
  }
}

function readScene(block: DrawingBlock, problems: DrawingProblem[]): DrawingScene | null {
  let json = block.content;
  if (block.format === "compressed-json") {
    const packed = block.content.replace(/\s+/g, "");
    const unpacked = packed ? decompressFromBase64(packed) : null;
    if (!unpacked) {
      problems.push({
        code: "decompress-failed",
        severity: "error",
        message: "The compressed scene couldn't be decompressed.",
      });
      return null;
    }
    json = unpacked;
  }
  // Like the plugin: ignore anything after the last brace (a sync merge can leave some behind).
  const last = json.lastIndexOf("}");
  let value: unknown;
  try {
    value = JSON.parse(last === -1 ? json : json.slice(0, last + 1));
  } catch (error) {
    problems.push({
      code: "invalid-json",
      severity: "error",
      message: `The scene isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.elements)) {
    problems.push({
      code: "not-a-scene",
      severity: "error",
      message: "The scene isn't an object with an `elements` list.",
    });
    return null;
  }
  const elements: DrawingElement[] = [];
  let dropped = 0;
  for (const element of value.elements) {
    if (isRecord(element) && typeof element.id === "string" && typeof element.type === "string") {
      elements.push(element as DrawingElement);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    problems.push({
      code: "invalid-element",
      severity: "warning",
      message: `${dropped} element${dropped === 1 ? "" : "s"} without an id and a type were dropped.`,
    });
  }
  return {
    ...value,
    type: typeof value.type === "string" ? value.type : "excalidraw",
    version: typeof value.version === "number" ? value.version : 2,
    elements,
    appState: isRecord(value.appState) ? (value.appState as DrawingAppState) : {},
    files: isRecord(value.files) ? (value.files as DrawingBinaryFiles) : {},
  };
}

/**
 * The text after the frontmatter as sections: the part above the drawing data (heading `""`), then
 * one per heading from `# Excalidraw Data` on. `## Text Elements` runs to `## Element Links`,
 * `## Embedded Files` or the drawing, since text elements may contain `#` lines.
 */
function splitSections(body: string, drawing: DrawingBlock | null): DrawingFileSection[] {
  const limit = drawing ? drawing.start : body.length;
  const before = body.slice(0, limit);
  const data = DATA_HEADING.exec(before) ?? TEXT_HEADING_M.exec(before);
  const dataStart = data ? data.index : limit;
  const sections: DrawingFileSection[] = [{ heading: "", body: body.slice(0, dataStart) }];
  splitAtHeadings(body.slice(dataStart, limit), sections, true);
  if (drawing) {
    sections.push({ heading: drawing.heading, body: body.slice(drawing.bodyStart, drawing.end) });
    splitAtHeadings(body.slice(drawing.end), sections, false);
  }
  return sections;
}

/** Appends `text`'s sections; text before its first heading joins the last section. */
function splitAtHeadings(text: string, sections: DrawingFileSection[], dataArea: boolean): void {
  if (text === "") return;
  let inText = false;
  let current = sections[sections.length - 1]!;
  let pos = 0;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(pos, newline === -1 ? text.length : newline);
    const starts = inText ? AFTER_TEXT_HEADING.test(line) : HEADING.test(line);
    if (starts) {
      current = { heading: line, body: "" };
      sections.push(current);
      inText = dataArea && TEXT_HEADING.test(line);
    } else {
      current.body += text.slice(pos, end);
    }
    pos = end;
  }
}

/**
 * The entries of a `## Text Elements` body, and where the text after the last one starts. A block
 * reference ends an entry when it names an element of the scene, or when it has the plugin's
 * 8-character ids (which is how the plugin itself splits them).
 */
function readTextEntries(
  body: string,
  ids: ReadonlySet<string> | null,
): { entries: DrawingTextEntry[]; tail: number } {
  const entries: DrawingTextEntry[] = [];
  let chunk = 0;
  let tail = 0;
  for (const match of body.matchAll(BLOCK_REF)) {
    const id = match[1]!;
    const known = ids === null || ids.has(id);
    if (!known && id.length !== 8) continue;
    if (known) {
      const text = body
        .slice(chunk, match.index)
        .replace(/^\n+/, "")
        .replace(/[ \t]$/, "");
      entries.push({ id, text });
    }
    chunk = match.index + match[0].length;
    tail = chunk;
  }
  return { entries, tail };
}

/** The plugin treats `## Text Elements` as the truth: an entry that differs updates its element. */
function applyTextEntries(scene: DrawingScene, entries: readonly DrawingTextEntry[]): void {
  if (entries.length === 0) return;
  const texts = new Map<string, DrawingElement>();
  for (const element of scene.elements) {
    if (element.type === "text" && element.isDeleted !== true) texts.set(element.id, element);
  }
  for (const entry of entries) {
    const element = texts.get(entry.id);
    if (!element || entry.text === sectionText(element).replace(/^\n+/, "")) continue;
    element.text = entry.text;
    element.originalText = entry.text;
    if (Object.hasOwn(element, "rawText")) element.rawText = entry.text;
  }
}

/** What `## Text Elements` lists for a text element: the plugin's raw text, else the text as typed. */
function sectionText(element: DrawingElement): string {
  if (typeof element.rawText === "string" && element.rawText !== "") return element.rawText;
  return displayText(element);
}

function displayText(element: DrawingElement): string {
  if (typeof element.originalText === "string" && element.originalText !== "") {
    return element.originalText;
  }
  return typeof element.text === "string" ? element.text : "";
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface SerializeDrawingOptions {
  /** Write `compressed-json` like the plugin's default, instead of readable `json`. */
  compressed?: boolean;
}

/**
 * The file for `scene`. With the `previous` file (its text or its parse), everything we don't
 * regenerate is kept: frontmatter, the text above the drawing data, other sections, and the fields
 * of the scene, its `appState`, its files and its elements (matched by id) that `scene` lacks.
 * `## Text Elements` is regenerated from the scene's text elements. Throws
 * `DrawingUnreadableError` when `previous` couldn't be read, rather than overwrite it.
 */
export function serializeDrawingFile(
  scene: DrawingScene,
  previous?: string | ParsedDrawingFile,
  options: SerializeDrawingOptions = {},
): string {
  const before = typeof previous === "string" ? parseDrawingFile(previous) : previous;
  if (before && !before.readable) throw new DrawingUnreadableError(before.problems);
  const written = sceneForWriting(scene, before?.scene);
  const entries = textEntries(written.elements as DrawingElement[]);
  const json = JSON.stringify(written, null, "\t");
  const block = options.compressed
    ? `\`\`\`compressed-json\n${chunkLines(compressToBase64(json))}\n\`\`\`\n%%\n`
    : `\`\`\`json\n${json}\n\`\`\`\n%%\n`;
  const entriesText = entries.map((entry) => `${entry.text} ^${entry.id}\n\n`).join("");

  if (!before) {
    return [
      DEFAULT_FRONTMATTER,
      `${DRAWING_NOTICE}\n\n`,
      "# Excalidraw Data\n\n",
      `## Text Elements\n${entriesText}%%\n`,
      `## Drawing\n${block}`,
    ].join("");
  }

  const sections = before.sections.map((section) => ({ ...section }));
  if (findDrawingSection(sections) === -1) sections.push({ heading: "## Drawing", body: "" });
  const drawingIndex = findDrawingSection(sections);
  const drawingSection = sections[drawingIndex]!;
  drawingSection.body = block + afterSceneBlock(drawingSection.body);

  const textIndex = findSection(sections, TEXT_HEADING, drawingIndex);
  if (textIndex !== -1) {
    const old = sections[textIndex]!.body;
    const ids = new Set(before.scene.elements.map((element) => element.id));
    sections[textIndex]!.body = entriesText + old.slice(readTextEntries(old, ids).tail);
  } else {
    const dataIndex = findSection(sections, DATA_HEADING, drawingIndex);
    if (dataIndex !== -1 && dataIndex + 1 < drawingIndex) {
      sections.splice(dataIndex + 1, 0, { heading: "## Text Elements", body: entriesText });
    } else {
      // The plugin's layout: the data, then `%%` to hide the scene in reading view.
      const last = sections[drawingIndex - 1]!;
      if (last.body.endsWith("%%\n")) last.body = last.body.slice(0, -3);
      const inserted = [
        ...(dataIndex === -1 ? [{ heading: "# Excalidraw Data", body: "\n" }] : []),
        { heading: "## Text Elements", body: `${entriesText}%%\n` },
      ];
      sections.splice(drawingIndex, 0, ...inserted);
    }
  }

  return frontmatterForWriting(before.frontmatter) + sections.map(sectionSource).join("");
}

/** The section holding the scene: the last `## Drawing` whose body opens with its fence; -1 if none. */
function findDrawingSection(sections: readonly DrawingFileSection[]): number {
  for (let i = sections.length - 1; i > 0; i--) {
    const section = sections[i]!;
    if (!DRAWING_HEADING.test(section.heading)) continue;
    const firstLine = section.body.replace(/^(?:[ \t]*\n)+/, "").split("\n", 1)[0]!;
    if (SCENE_FENCE.test(firstLine)) return i;
  }
  return -1;
}

/** The first section before `end` whose heading matches. */
function findSection(
  sections: readonly DrawingFileSection[],
  heading: RegExp,
  end: number,
): number {
  for (let i = 1; i < end; i++) if (heading.test(sections[i]!.heading)) return i;
  return -1;
}

/** What follows the scene's closing fence and `%%` line in the drawing section's body. */
function afterSceneBlock(body: string): string {
  const open = /^```(?:json|compressed-json)[ \t]*$/m.exec(body);
  if (!open) return "";
  const rest = body.slice(open.index + open[0].length);
  const close = CLOSING_FENCE.exec(rest);
  if (!close) return "";
  let after = rest.slice(close.index + close[0].length).replace(/^\n/, "");
  const comment = COMMENT_LINE.exec(after);
  if (comment) after = after.slice(comment[0].length);
  return after;
}

function sectionSource(section: DrawingFileSection): string {
  return section.heading === "" ? section.body : `${section.heading}\n${section.body}`;
}

function frontmatterForWriting(frontmatter: DrawingFrontmatter): string {
  if (frontmatter.raw === "") return DEFAULT_FRONTMATTER;
  if (Object.hasOwn(frontmatter.entries, "excalidraw-plugin")) return frontmatter.raw;
  // The plugin recognizes drawings by this key; add it the way the plugin does.
  return frontmatter.raw.replace(/^---[ \t]*\n/, "---\nexcalidraw-plugin: parsed\n");
}

function chunkLines(text: string): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += COMPRESSED_LINE_CHARS) {
    lines.push(text.slice(i, i + COMPRESSED_LINE_CHARS));
  }
  return lines.join("\n\n");
}

/** The scene as written: fields `scene` lacks come from `previous`, in the previous order. */
function sceneForWriting(scene: DrawingScene, previous?: DrawingScene): Record<string, unknown> {
  const merged = previous ? mergeFields(scene, previous) : { ...scene };
  const previousElements = new Map(previous?.elements.map((element) => [element.id, element]));
  const elements = scene.elements.map((element) => {
    const old = previousElements.get(element.id);
    return withFreshRawText(old ? mergeFields(element, old) : { ...element }, old);
  });
  const appState = mergeFields(
    isRecord(scene.appState) ? scene.appState : {},
    previous?.appState ?? {},
  );
  const files = isRecord(scene.files)
    ? mergeFiles(scene.files, previous?.files)
    : (previous?.files ?? {});
  const { type, version, source: _source, elements: _e, appState: _a, files: _f, ...rest } = merged;
  return {
    type: typeof type === "string" ? type : "excalidraw",
    version: typeof version === "number" ? version : 2,
    source: sourceForWriting(scene.source, previous?.source),
    elements,
    appState,
    files,
    ...rest,
  };
}

function sourceForWriting(source: unknown, previous: unknown): string {
  if (typeof source === "string" && source.startsWith(DRAWING_PLUGIN_SOURCE_PREFIX)) return source;
  if (typeof previous === "string" && previous.startsWith(DRAWING_PLUGIN_SOURCE_PREFIX)) {
    return previous;
  }
  return DRAWING_SCENE_SOURCE;
}

/**
 * Editors that don't know the plugin's `rawText` keep it unchanged when the text changes; the plugin
 * would then restore the old text from `## Text Elements`. Once the text differs from the previous
 * file's, `rawText` follows it.
 */
function withFreshRawText(
  element: DrawingElement,
  old: DrawingElement | undefined,
): DrawingElement {
  if (element.type !== "text" || typeof element.rawText !== "string") return element;
  const text = displayText(element);
  const unchanged = old !== undefined && displayText(old) === text;
  if (!unchanged && old !== undefined && element.rawText !== text) element.rawText = text;
  return element;
}

function textEntries(elements: readonly DrawingElement[]): DrawingTextEntry[] {
  return elements
    .filter((element) => element.type === "text" && element.isDeleted !== true)
    .map((element) => ({ id: element.id, text: sectionText(element) }));
}

function mergeFiles(files: DrawingBinaryFiles, previous: DrawingBinaryFiles | undefined) {
  const out: Record<string, unknown> = {};
  for (const [id, file] of Object.entries(files)) {
    const old = previous && Object.hasOwn(previous, id) ? previous[id] : undefined;
    setOwn(out, id, isRecord(file) && isRecord(old) ? mergeFields(file, old) : file);
  }
  return out;
}

function mergeFields<T extends Record<string, unknown>>(
  next: T,
  previous: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(previous)) {
    setOwn(out, key, Object.hasOwn(next, key) ? next[key] : previous[key]);
  }
  for (const key of Object.keys(next)) if (!Object.hasOwn(out, key)) setOwn(out, key, next[key]);
  return out as T;
}

/** Assignment that keeps a `__proto__` key a plain field, as `JSON.parse` does. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key !== "__proto__") target[key] = value;
  else
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
