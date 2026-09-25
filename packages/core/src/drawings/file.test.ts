import { describe, expect, it } from "vitest";
import { SceneBuilder } from "../testing/drawing-scenes";
import {
  DRAWING_NOTICE,
  DrawingUnreadableError,
  drawingPathForName,
  drawingTitleFromPath,
  isDrawingMarkdown,
  isDrawingPath,
  newDrawingName,
  parseDrawingFile,
  serializeDrawingFile,
  uniqueDrawingPath,
} from "./file";
import { compressToBase64 } from "./lz-string";
import { DRAWING_SCENE_SOURCE, type DrawingScene, emptyDrawingScene } from "./types";

const FRONTMATTER = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";

function flowchart(): DrawingScene {
  return new SceneBuilder()
    .rect("api", 0, 0)
    .label("api", "apiLabel", "API")
    .rect("db", 300, 0)
    .label("db", "dbLabel", "DB")
    .arrow("a1", [160, 40], [300, 40], { start: "api", end: "db" })
    .text("note", 0, 150, "Draft\nv2")
    .build();
}

/** The plugin's file around a scene JSON string (as `generateMDBase` + `getMarkdownDrawingSection` write it). */
function pluginFile(json: string, texts = "", compressed = false): string {
  const drawing = compressed
    ? `\`\`\`compressed-json\n${compressToBase64(json)}\n\`\`\`\n%%`
    : `\`\`\`json\n${json}\n\`\`\`\n%%`;
  return `${FRONTMATTER}${DRAWING_NOTICE}\n\n# Excalidraw Data\n\n## Text Elements\n${texts}%%\n## Drawing\n${drawing}`;
}

describe("serializeDrawingFile", () => {
  it("writes an empty drawing exactly like the plugin lays it out", () => {
    const json = JSON.stringify(emptyDrawingScene(), null, "\t");
    expect(serializeDrawingFile(emptyDrawingScene())).toBe(
      `${FRONTMATTER}${DRAWING_NOTICE}\n\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%\n`,
    );
  });

  it("lists every live text element under Text Elements with a block reference", () => {
    const scene = new SceneBuilder()
      .rect("box", 0, 0)
      .label("box", "boxLabel", "Inside")
      .text("free", 0, 100, "Two\nlines")
      .text("gone", 0, 200, "Deleted")
      .delete("gone")
      .build();
    const text = serializeDrawingFile(scene);
    expect(text).toContain(
      "## Text Elements\nInside ^boxLabel\n\nTwo\nlines ^free\n\n%%\n## Drawing\n",
    );
    expect(text).not.toContain("^gone");
  });

  it("writes the scene's keys in the plugin's order with tab indentation", () => {
    const scene = { ...flowchart(), extraKey: 1 };
    const parsed = JSON.parse(
      parseDrawingFile(serializeDrawingFile(scene)).sections.at(-1)!.body.slice(8, -8),
    );
    expect(Object.keys(parsed)).toEqual([
      "type",
      "version",
      "source",
      "elements",
      "appState",
      "files",
      "extraKey",
    ]);
    expect(serializeDrawingFile(scene)).toContain(
      '```json\n{\n\t"type": "excalidraw",\n\t"version": 2,',
    );
  });

  it("names the plugin format in `source`, keeping a plugin version already there", () => {
    const from = (source?: string) => {
      const scene = { ...flowchart(), ...(source === undefined ? {} : { source }) };
      if (source === undefined) delete scene.source;
      return parseDrawingFile(serializeDrawingFile(scene)).scene.source;
    };
    expect(from(undefined)).toBe(DRAWING_SCENE_SOURCE);
    expect(from("https://excalidraw.com")).toBe(DRAWING_SCENE_SOURCE);
    const old = "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/1.8.10";
    expect(from(old)).toBe(old);
    const previous = serializeDrawingFile({ ...flowchart(), source: old });
    const edited = { ...flowchart(), source: "http://127.0.0.1:7331" };
    expect(parseDrawingFile(serializeDrawingFile(edited, previous)).scene.source).toBe(old);
  });

  it("writes compressed-json in 256-character lines separated by blank lines", () => {
    const scene = flowchart();
    const text = serializeDrawingFile(scene, undefined, { compressed: true });
    const block = /```compressed-json\n([\s\S]*?)\n```\n%%\n$/.exec(text)![1]!;
    const lines = block.split("\n\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((line) => line.length === 256)).toBe(true);
    expect(lines.join("")).toBe(compressToBase64(JSON.stringify(scene, null, "\t")));
    expect(parseDrawingFile(text).scene).toEqual(
      parseDrawingFile(serializeDrawingFile(scene)).scene,
    );
  });

  it("refuses to write over a file whose scene couldn't be read", () => {
    const broken = `${FRONTMATTER}## Drawing\n\`\`\`json\n{"type": "excal\n\`\`\`\n%%\n`;
    expect(() => serializeDrawingFile(flowchart(), broken)).toThrow(DrawingUnreadableError);
  });
});

describe("parseDrawingFile", () => {
  it("reads back what it writes", () => {
    const scene = flowchart();
    const parsed = parseDrawingFile(serializeDrawingFile(scene));
    expect(parsed.problems).toEqual([]);
    expect(parsed.readable).toBe(true);
    expect(parsed.compressed).toBe(false);
    expect(parsed.scene).toEqual(scene);
    expect(parsed.frontmatter.entries).toEqual({
      "excalidraw-plugin": "parsed",
      tags: "[excalidraw]",
    });
    expect(parsed.textElements).toEqual([
      { id: "apiLabel", text: "API" },
      { id: "dbLabel", text: "DB" },
      { id: "note", text: "Draft\nv2" },
    ]);
    expect(parsed.sections.map((s) => s.heading)).toEqual([
      "",
      "# Excalidraw Data",
      "## Text Elements",
      "## Drawing",
    ]);
  });

  it("reads the plugin's compressed-json and json forms to the same scene", () => {
    const json = JSON.stringify(flowchart(), null, "\t");
    const plain = parseDrawingFile(pluginFile(json, "API ^apiLabel\n\n"));
    const packed = parseDrawingFile(pluginFile(json, "API ^apiLabel\n\n", true));
    expect(packed.compressed).toBe(true);
    expect(packed.problems).toEqual([]);
    expect(packed.scene).toEqual(plain.scene);
    expect(plain.scene).toEqual(flowchart());
  });

  it("reads the plugin's blank drawing, which has no data sections and no final newline", () => {
    const blank =
      '{"type":"excalidraw","version":2,"source":"https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.27.3","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"}}';
    const text = `${FRONTMATTER}${DRAWING_NOTICE}\n\n\n## Drawing\n\`\`\`compressed-json\n${compressToBase64(blank)}\n\`\`\`\n%%`;
    const parsed = parseDrawingFile(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.scene.elements).toEqual([]);
    expect(parsed.scene.files).toEqual({});
    expect(parsed.sections.map((s) => s.heading)).toEqual(["", "## Drawing"]);

    const written = serializeDrawingFile(
      new SceneBuilder().text("t1", 0, 0, "Hello").build(),
      parsed,
    );
    expect(written).toBe(
      `${FRONTMATTER}${DRAWING_NOTICE}\n\n\n# Excalidraw Data\n\n## Text Elements\nHello ^t1\n\n%%\n## Drawing\n${written.slice(written.indexOf("```json"))}`,
    );
    expect(parseDrawingFile(written).textElements).toEqual([{ id: "t1", text: "Hello" }]);
  });

  it("reads CRLF files and a byte order mark", () => {
    const text = `\uFEFF${serializeDrawingFile(flowchart()).replace(/\n/g, "\r\n")}`;
    const parsed = parseDrawingFile(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.scene).toEqual(flowchart());
  });

  it("uses the last Drawing heading followed by a scene fence", () => {
    const scene = new SceneBuilder().text("t1", 0, 0, "## Drawing\n```json\n{}\n```").build();
    const parsed = parseDrawingFile(serializeDrawingFile(scene));
    expect(parsed.problems).toEqual([]);
    expect(parsed.scene).toEqual(scene);
    expect(parsed.textElements).toEqual([{ id: "t1", text: "## Drawing\n```json\n{}\n```" }]);
  });

  it("keeps `#` lines inside a text element's text", () => {
    const scene = new SceneBuilder()
      .text("t1", 0, 0, "# Title\nbody")
      .text("t2", 0, 60, "## Notes")
      .build();
    const parsed = parseDrawingFile(serializeDrawingFile(scene));
    expect(parsed.textElements.map((t) => t.text)).toEqual(["# Title\nbody", "## Notes"]);
    expect(parsed.sections.map((s) => s.heading)).toEqual([
      "",
      "# Excalidraw Data",
      "## Text Elements",
      "## Drawing",
    ]);
  });

  it("splits Text Elements only at references to elements, or the plugin's 8-character ids", () => {
    const scene = new SceneBuilder().text("t1", 0, 0, "x").text("t2", 0, 0, "y").build();
    const json = JSON.stringify(scene, null, "\t");
    const texts = "\n^_dummy!_\n\nsee ^note\nx ^t1\n\ny ^t2\n\n";
    const parsed = parseDrawingFile(pluginFile(json, texts));
    expect(parsed.textElements).toEqual([
      { id: "t1", text: "see ^note\nx" },
      { id: "t2", text: "y" },
    ]);
  });

  it("lets an edited Text Elements entry win over the scene, like the plugin", () => {
    const scene = new SceneBuilder()
      .text("t1", 0, 0, "Old", { rawText: "Old" })
      .text("t2", 0, 60, "Same")
      .build();
    const text = serializeDrawingFile(scene).replace("Old ^t1", "New ^t1");
    const parsed = parseDrawingFile(text);
    const [t1, t2] = parsed.scene.elements;
    expect(t1).toMatchObject({ text: "New", originalText: "New", rawText: "New" });
    expect(t2).toMatchObject({ text: "Same", originalText: "Same" });
  });

  it("keeps a container's wrapped text when its entry matches the unwrapped text", () => {
    const scene = new SceneBuilder()
      .rect("box", 0, 0, 80, 80)
      .label("box", "l1", "A long label", { text: "A long\nlabel" })
      .build();
    const parsed = parseDrawingFile(serializeDrawingFile(scene));
    expect(parsed.textElements).toEqual([{ id: "l1", text: "A long label" }]);
    expect(parsed.scene.elements[1]).toMatchObject({
      text: "A long\nlabel",
      originalText: "A long label",
    });
  });

  it.each([
    ["no drawing section", `${FRONTMATTER}# Excalidraw Data\n\n## Text Elements\n`, "no-drawing"],
    [
      "invalid JSON",
      `${FRONTMATTER}## Drawing\n\`\`\`json\n{"elements": [\n\`\`\`\n%%\n`,
      "invalid-json",
    ],
    ["an empty block", `${FRONTMATTER}## Drawing\n\`\`\`json\n\`\`\`\n%%\n`, "invalid-json"],
    [
      "garbage compressed data",
      `## Drawing\n\`\`\`compressed-json\n////\n\`\`\`\n%%\n`,
      "decompress-failed",
    ],
    [
      "JSON that isn't a scene",
      `## Drawing\n\`\`\`json\n{"elements": 3}\n\`\`\`\n%%\n`,
      "not-a-scene",
    ],
    ["a JSON array", `## Drawing\n\`\`\`json\n[1, 2]\n\`\`\`\n%%\n`, "not-a-scene"],
    ["an empty file", "", "no-drawing"],
  ])("reports %s as an unreadable scene without throwing", (_name, text, code) => {
    const parsed = parseDrawingFile(text);
    expect(parsed.readable).toBe(false);
    expect(parsed.problems.map((p) => [p.code, p.severity])).toEqual([[code, "error"]]);
    expect(parsed.scene).toEqual(emptyDrawingScene());
  });

  it("drops elements without an id or type, with a warning", () => {
    const json = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "a", type: "rectangle" },
        { id: 3, type: "text" },
        "x",
        null,
        { type: "line" },
      ],
    });
    const parsed = parseDrawingFile(pluginFile(json));
    expect(parsed.readable).toBe(true);
    expect(parsed.scene.elements).toEqual([{ id: "a", type: "rectangle" }]);
    expect(parsed.problems.map((p) => [p.code, p.severity])).toEqual([
      ["invalid-element", "warning"],
    ]);
  });

  it("reads a scene whose fence isn't closed, with a warning", () => {
    const text = `${FRONTMATTER}## Drawing\n\`\`\`json\n${JSON.stringify(flowchart())}\n%%\n`;
    const parsed = parseDrawingFile(text);
    expect(parsed.readable).toBe(true);
    expect(parsed.scene).toEqual(flowchart());
    expect(parsed.problems.map((p) => p.code)).toEqual(["unclosed-fence"]);
  });

  it("ignores text after the scene's last brace, as the plugin does", () => {
    const text = pluginFile(`${JSON.stringify(flowchart())}\ntrailing junk`);
    expect(parseDrawingFile(text).scene).toEqual(flowchart());
  });
});

describe("serializeDrawingFile with the previous file", () => {
  const PLUGIN_FILE = [
    "---",
    "",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "excalidraw-export-dark: true",
    "project: garden",
    "",
    "---",
    DRAWING_NOTICE,
    "",
    "Notes on the back of the drawing.",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "Old ^t1",
    "",
    "## Element Links",
    "r1: [[Garden plan]]",
    "",
    "## Embedded Files",
    "f1: [[seedling.png]]",
    "",
    "%%",
    "## Drawing",
    "```json",
    JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.20.0",
        elements: [
          { id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, customData: { a: 1 } },
          {
            id: "t1",
            type: "text",
            text: "Old",
            originalText: "Old",
            rawText: "Old",
            hasTextLink: false,
          },
        ],
        appState: { theme: "dark", viewBackgroundColor: "#fff", currentStrokeOptions: null },
        files: {
          f1: { id: "f1", mimeType: "image/png", dataURL: "data:x", created: 1, custom: true },
        },
        pluginOnly: { x: 1 },
      },
      null,
      "\t",
    ),
    "```",
    "%%",
    "",
    "# Markdown Images",
    "",
  ].join("\n");

  /** What an editor that drops unknown fields hands back after an edit. */
  function edited(): DrawingScene {
    return {
      type: "excalidraw",
      version: 2,
      source: "http://127.0.0.1:5173",
      elements: [
        { id: "r1", type: "rectangle", x: 5, y: 0, width: 10, height: 10 },
        { id: "t1", type: "text", text: "New", originalText: "New" },
        { id: "t2", type: "text", text: "Added", originalText: "Added" },
      ],
      appState: { viewBackgroundColor: "#fff" },
      files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:x" } },
    };
  }

  it("keeps frontmatter, the back of the drawing, other sections and the trailer verbatim", () => {
    const written = serializeDrawingFile(edited(), PLUGIN_FILE);
    const head = PLUGIN_FILE.slice(0, PLUGIN_FILE.indexOf("## Text Elements"));
    expect(written.startsWith(head)).toBe(true);
    expect(written).toContain(
      "## Text Elements\nNew ^t1\n\nAdded ^t2\n\n## Element Links\nr1: [[Garden plan]]\n\n## Embedded Files\nf1: [[seedling.png]]\n\n%%\n## Drawing\n```json\n",
    );
    expect(written.endsWith("```\n%%\n\n# Markdown Images\n")).toBe(true);
  });

  it("keeps the fields the new scene lacks, in their previous order", () => {
    const scene = parseDrawingFile(serializeDrawingFile(edited(), PLUGIN_FILE)).scene;
    expect(scene.source).toBe(
      "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.20.0",
    );
    expect(scene.pluginOnly).toEqual({ x: 1 });
    expect(scene.appState).toEqual({
      theme: "dark",
      viewBackgroundColor: "#fff",
      currentStrokeOptions: null,
    });
    expect(scene.files.f1).toEqual({
      id: "f1",
      mimeType: "image/png",
      dataURL: "data:x",
      created: 1,
      custom: true,
    });
    expect(scene.elements[0]).toEqual({
      id: "r1",
      type: "rectangle",
      x: 5,
      y: 0,
      width: 10,
      height: 10,
      customData: { a: 1 },
    });
    expect(scene.elements[2]).toEqual({
      id: "t2",
      type: "text",
      text: "Added",
      originalText: "Added",
    });
  });

  it("brings the plugin's rawText up to date when the text changed", () => {
    const scene = parseDrawingFile(serializeDrawingFile(edited(), PLUGIN_FILE)).scene;
    expect(scene.elements[1]).toEqual({
      id: "t1",
      type: "text",
      text: "New",
      originalText: "New",
      rawText: "New",
      hasTextLink: false,
    });
  });

  it("keeps rawText (the text with its links) while the text is unchanged", () => {
    const previous = serializeDrawingFile(
      new SceneBuilder().text("t1", 0, 0, "Garden plan", { rawText: "[[Garden plan]]" }).build(),
    );
    expect(previous).toContain("[[Garden plan]] ^t1");
    const moved = parseDrawingFile(previous).scene;
    moved.elements[0]!.x = 40;
    const written = serializeDrawingFile(moved, previous);
    expect(written).toContain("[[Garden plan]] ^t1");
    expect(parseDrawingFile(written).scene.elements[0]).toMatchObject({
      x: 40,
      rawText: "[[Garden plan]]",
      text: "Garden plan",
    });
  });

  it("keeps a commented-out data section commented out", () => {
    const text = serializeDrawingFile(flowchart())
      .replace("# Excalidraw Data", "%%\n# Excalidraw Data")
      .replace("%%\n## Drawing", "## Drawing");
    const written = serializeDrawingFile(flowchart(), text);
    expect(written).toBe(text);
    expect(written).toContain(`${DRAWING_NOTICE}\n\n%%\n# Excalidraw Data\n\n## Text Elements\n`);
    expect(written).toContain("^note\n\n## Drawing\n");
  });

  it("adds the plugin's frontmatter key, or the whole frontmatter, when missing", () => {
    const base = serializeDrawingFile(flowchart());
    const other = base
      .replace("excalidraw-plugin: parsed\n", "")
      .replace("tags:", "aliases: [x]\ntags:");
    expect(serializeDrawingFile(flowchart(), other)).toContain(
      "---\nexcalidraw-plugin: parsed\n\naliases: [x]\ntags: [excalidraw]\n",
    );
    const bare = base.slice(FRONTMATTER.length);
    expect(
      serializeDrawingFile(flowchart(), bare).startsWith(`${FRONTMATTER}${DRAWING_NOTICE}`),
    ).toBe(true);
  });

  it("is a fixed point: writing a parsed file back changes nothing", () => {
    const first = serializeDrawingFile(parseDrawingFile(PLUGIN_FILE).scene, PLUGIN_FILE);
    expect(serializeDrawingFile(parseDrawingFile(first).scene, first)).toBe(first);
  });
});

describe("drawing paths and names", () => {
  it("recognizes drawing files by name", () => {
    expect(isDrawingPath("Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md")).toBe(true);
    expect(isDrawingPath("Plan.Excalidraw.MD")).toBe(true);
    expect(isDrawingPath("Plan.excalidraw")).toBe(false);
    expect(isDrawingPath("Daily/2026-09-25.md")).toBe(false);
  });

  it("recognizes drawings by their frontmatter, whatever the name", () => {
    expect(isDrawingMarkdown(serializeDrawingFile(emptyDrawingScene()))).toBe(true);
    expect(isDrawingMarkdown("---\ntitle: x\n'excalidraw-plugin': raw\n---\n- [ ] task")).toBe(
      true,
    );
    expect(isDrawingMarkdown("---\r\nexcalidraw-plugin: parsed\r\n---\r\n")).toBe(true);
    expect(isDrawingMarkdown("---\ntags: [excalidraw]\n---\n")).toBe(false);
    expect(isDrawingMarkdown("excalidraw-plugin: parsed\n")).toBe(false);
    expect(isDrawingMarkdown("---\nexcalidraw-plugin: parsed\n")).toBe(false);
    expect(isDrawingMarkdown("- [ ] Buy milk\n---\nexcalidraw-plugin: parsed\n---\n")).toBe(false);
  });

  it("names new drawings like the plugin, in local time", () => {
    expect(newDrawingName(new Date(2026, 8, 25, 11, 52, 33))).toBe("Drawing 2026-09-25 11.52.33");
    expect(newDrawingName(new Date(2026, 0, 2, 3, 4, 5))).toBe("Drawing 2026-01-02 03.04.05");
  });

  it("puts drawings in the Excalidraw folder with a safe file name", () => {
    expect(drawingPathForName("Drawing 2026-09-25 11.52.33")).toBe(
      "Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md",
    );
    expect(drawingPathForName("API / DB: v2?")).toBe("Excalidraw/API DB v2.excalidraw.md");
    expect(drawingPathForName("Plan.excalidraw.md", "Projects")).toBe(
      "Projects/Plan.excalidraw.md",
    );
    expect(drawingPathForName("  #^[]  ", "")).toBe("Drawing.excalidraw.md");
  });

  it("appends _0, _1, … to a taken name, as the plugin does", () => {
    const taken = new Set(["Excalidraw/A.excalidraw.md", "Excalidraw/A_0.excalidraw.md"]);
    expect(uniqueDrawingPath("A", (p) => taken.has(p))).toBe("Excalidraw/A_1.excalidraw.md");
    expect(uniqueDrawingPath("B", (p) => taken.has(p))).toBe("Excalidraw/B.excalidraw.md");
  });

  it("titles a drawing by its file name", () => {
    expect(drawingTitleFromPath("Excalidraw/Garden plan.excalidraw.md")).toBe("Garden plan");
    expect(drawingTitleFromPath("Garden plan.excalidraw")).toBe("Garden plan");
  });
});
