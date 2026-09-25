# Drawing fixtures

Shared test cases for drawing files (`*.excalidraw.md`, the Obsidian Excalidraw plugin's format).
`@ddl/core` (`packages/core/src/drawings/`) is the reference implementation, the way vim.js is for
vim mode: the Swift drawing engine (`DailyDoListDrawing`) replays every fixture here and must
produce the same results, byte for byte where this README says so. When either side finds a case
the other gets wrong, add a fixture.

## Files

Everything lives in `fixtures/` (byte-exact: the hygiene check doesn't touch that folder).

| File | What |
| --- | --- |
| `<name>.excalidraw.md` | The input, verbatim. Plugin-style files end without a line break, as the plugin writes them. |
| `<name>.expected.json` | What reading, describing and writing it back give (below). |
| `<name>.roundtrip.excalidraw.md` | The exact bytes of writing the parsed file back, when they differ from the input. |

Names start with `ours-` (written by `serializeDrawingFile`) or `plugin-` (written the way the
plugin writes: `src/shared/ExcalidrawData.ts` `generateMDBase`, `src/shared/excalidrawMarkdownParsing.ts`
`getMarkdownDrawingSection`, `src/utils/sceneDataUtils.ts` `compress`); others are edge cases.

## `<name>.expected.json`

```jsonc
{
  "about": "What the fixture covers",           // by hand
  "title": "ours-flowchart",                     // by hand: the title passed to describeDrawing
  "sameSceneAs": "plugin-json.excalidraw.md",    // by hand, optional: must parse to that fixture's scene
  "parse": {
    "readable": true,                            // ParsedDrawingFile.readable
    "compressed": false,                         // the scene was compressed-json
    "problems": [{ "code": "invalid-json", "severity": "error" }],  // in order
    "frontmatter": { "excalidraw-plugin": "parsed", "tags": "[excalidraw]" },
    "sections": ["", "# Excalidraw Data", "## Text Elements", "## Drawing"],  // headings in order
    "textElements": [{ "id": "tBrowser", "text": "Browser" }],   // entries under ## Text Elements
    "elements": [{ "id": "client", "type": "rectangle" }],       // every element, "isDeleted": true only when deleted
    "texts": [{ "id": "tBrowser", "text": "Browser" }],          // live text elements' `text` after parsing
    "files": ["4f1c0e9a7b2d"]                                    // keys of the scene's files, in order
  },
  "description": "Drawing “ours-flowchart” (520×365 px, 11 elements)\n…",  // exact
  "roundTrip": "ours-flowchart.excalidraw.md"    // or "<name>.roundtrip.excalidraw.md", or null
}
```

## Replaying a fixture

1. **Parse** the input and compare every `parse` field.
2. **Describe** the parsed scene with `title` and compare `description` exactly.
3. **Write it back**: serialize the parsed scene with the parsed input as the previous file. The
   bytes must equal the file `roundTrip` names. `null` means the scene is unreadable and the writer
   must refuse to write over it.
4. **Write the round trip back** the same way: nothing changes, and it parses to the input's scene.
5. With `sameSceneAs`, the two parsed scenes are equal as JSON values.

## The rules, briefly

The code is the full statement (`file.ts`, `describe.ts`, `embed.ts`); these are the parts a port
gets wrong most easily.

**Reading**

- Line breaks are normalized (`\r\n` and `\r` → `\n`) and a leading byte order mark dropped.
- Frontmatter: a first line `---` up to the next line `---`. `entries` are top-level
  `key: value` lines (not indented, not starting with `-` or `#`), value trimmed, as written.
- The scene is in the **last** `# Drawing` or `## Drawing` heading whose next non-blank line is
  the fence `` ```json `` or `` ```compressed-json ``, up to the next line that is exactly
  `` ``` `` (then an optional `%%` line). No closing fence: read to the end (minus a trailing
  `%%` line), with the warning `unclosed-fence`.
- `compressed-json`: remove all whitespace, then LZ-String `decompressFromBase64`.
- JSON: parse the text up to its last `}`. The scene must be an object with an `elements` array;
  elements without a string `id` and `type` are dropped (`invalid-element`, a warning). A missing
  `appState` or `files` reads as `{}`, a missing `type` as `"excalidraw"`, `version` as `2`.
- Sections: the text before the drawing data (`# Excalidraw Data`, else `## Text Elements`) is the
  section with heading `""`. From there a line of 1–6 `#` followed by a space, a tab or the end
  of the line starts a section, except inside `## Text Elements`, which runs until `## Element Links`,
  `## Embedded Files` or the drawing (text elements may contain `#` lines).
- Text entries: a block reference is `^` + non-space characters at the end of a line, after
  whitespace or at the start. It ends an entry when its id is an element of the scene, or is 8
  characters long (the plugin's rule; it skips its `^_dummy!_`). An entry's text is what comes
  before it, without leading line breaks and without one space or tab before the `^`.
- An entry that differs from its live text element's text (its `rawText`, else `originalText`,
  else `text`; leading line breaks ignored) replaces `text`, `originalText` and, if present,
  `rawText`: the plugin treats `## Text Elements` as the truth.

**Writing**

- JSON is `JSON.stringify(scene, null, "\t")`: keys in their order, numbers as ECMAScript prints
  them (shortest round trip, `1e+21`), strings escaping only `"`, `\`, control characters
  (`\b \f \n \r \t`, others `\u00XX` lowercase) and lone surrogates; `/` and non-ASCII are
  written as is. Scene keys: `type`, `version`, `source`, `elements`, `appState`, `files`, then
  any others.
- `source` stays when it starts with the plugin's release URL
  (`https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/`), else the previous
  file's if that one does, else `DRAWING_SCENE_SOURCE`.
- Fields of the scene, its `appState`, each file and each element (by id) that the new scene
  lacks come from the previous file, in the previous file's key order; new keys follow.
- `rawText` follows the text when the text differs from the previous file's element.
- `## Text Elements` lists live text elements in scene order as `<text> ^<id>` plus a blank line;
  the text is `rawText`, else `originalText`, else `text`. What followed the last entry (usually
  `%%`) stays. Everything else keeps its bytes. A file without data sections gets
  `# Excalidraw Data`, `## Text Elements` and `%%` before `## Drawing`.
- The drawing section's body is the fence `` ```json ``, the JSON, `` ``` ``, `%%` and a line
  break, then whatever followed `%%` before. Compressed: LZ-String base64 in 256-character lines
  joined by blank lines.

**Describing** (`describe.ts`)

- Deleted elements don't count. Text is `originalText`, else `text`, with whitespace runs (JS
  `\s`, spelled out in `WHITESPACE`) turned into one space and trimmed.
- Labels are clipped to 60 code points and the title to 100: the first `n - 1`, trailing spaces
  removed, then `…`. The limit (2000) counts code points.
- A shape's label is its bound texts joined with ` / `. An unbound arrow end is "near" the
  closest shape, free text or image within 50 px of its bounding box (ties: smaller area, then
  scene order).
- Location is the third of the drawing's bounding box (unrotated) the element's center falls in.
- Too long: every section lists at most `k` items plus `… and N more`, with the largest `k` that
  fits under the limit less the note; then the note line.

## Adding a fixture

1. Put `<name>.excalidraw.md` in `fixtures/` (synthetic content only: this repository is public).
2. Optionally write `<name>.expected.json` with just `about`, `title` and `sameSceneAs`.
3. Run `pnpm --filter @ddl/core drawings:fixtures`, review the generated expectation and
   round trip, and commit them with the fixture. The generator never rewrites a fixture that
   exists; `--inputs` regenerates the ones it makes itself (`generate.ts`).
