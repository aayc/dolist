# Spec: drawings in notes (Excalidraw-compatible)

Status: built (`052dcc8`).

Read `AGENTS.md` first (invariants: keystroke path O(line), `@ddl/core` pure, plain Obsidian
files, the safety gate, wire changes in core + contract + Swift together, web and macOS control
rules, vim vectors as a model for shared behavior data).

## Decided with the user (2026-09-25)

- Free-form diagrams on notes, as fun and easy as Excalidraw, **fully Obsidian-compatible**.
- **Anchored in the note, text flows around them.** A drawing floats left or right with the text
  wrapping around it (or sits full width), anchored at a line; drag it to move it (to another
  line or the other side) and drag its corner to resize. Typing never collides with a drawing.
  Default for a new drawing: float right with wrap.
- **The web app embeds the real Excalidraw editor** (`@excalidraw/excalidraw`, MIT, React 19
  compatible), loaded only when needed.
- **The Mac app gets a native drawing engine written from scratch**, optimized, with the core
  set: selection (move, resize, delete, duplicate), rectangle, ellipse, diamond, arrow, line,
  freehand, text, stroke and background colors, stroke width, stroke style (solid, dashed,
  dotted), sloppiness, undo and redo, and Excalidraw's keyboard shortcuts for those tools. It
  keeps the hand-drawn look (a port of Rough.js, seeded like Excalidraw) and Excalidraw's palette.
  Elements or fields it doesn't support are preserved untouched and still render where possible.
- **The orchestrator always sees drawings**: a text description of every drawing embedded in the
  notes it reads (labels, shapes, which arrow connects what, freehand strokes counted), plus a
  rendered image for vision-capable models.

## Files (Obsidian Excalidraw plugin format)

- A drawing is `Excalidraw/<Name>.excalidraw.md` (the plugin's default folder), new ones named
  like the plugin names them (`Drawing 2026-09-25 11.52.33.excalidraw.md`).
- Content: frontmatter `excalidraw-plugin: parsed` (and `tags: [excalidraw]`), the plugin's notice
  line, `# Excalidraw Data`, `## Text Elements` (each text element's text followed by
  ` ^<elementId>`), then `%%`, `## Drawing`, a fenced ```` ```json ```` block with the scene
  (`type: "excalidraw"`, `version: 2`, `elements`, `appState` subset, `files`), and `%%`. We write
  uncompressed `json` (diffable, readable); we read both `json` and `compressed-json` (LZ-String
  base64, as the plugin writes by default). Unknown sections, frontmatter keys and element fields
  survive a round trip.
- Embedding in a note, exactly the plugin's syntax: `![[Name.excalidraw|<width>|right-wrap]]`,
  `|left-wrap`, `|left`, `|right`, `|center`, `|<width>x<height>`; no modifier = full width. The
  embed line is the anchor.
- Images inside drawings (`files`) are preserved but not required to render on the Mac yet.

## Editing experience (web and Mac)

- **Insert drawing** (command palette, the editor's context menu, a toolbar button, and a
  shortcut from the command table): creates the file, inserts the embed at the cursor's line
  (right-wrap, 360 px wide) and starts editing it in place.
- **In place:** clicking a drawing selects it (handles for move and resize); double-clicking, or
  Enter while selected, edits it in place with the tool bar floating next to it; Escape or a
  click outside ends editing. Changes save debounced, like notes.
- **Moving:** dragging a drawing shows where it will land (between lines, left or right side);
  dropping moves the embed line and sets `left-wrap`/`right-wrap`/full width. Resizing updates
  the width modifier. These are the user's own edits to the note.
- **Live preview:** the embed renders as the drawing unless the cursor is on its line (then the
  syntax shows, as for other embeds). Source mode shows the syntax.
- **Performance:** drawings never render or measure on the keystroke path. Rendered previews are
  cached by content hash; wrapping updates only when the anchor's line or a drawing changes.

## The orchestrator sees drawings

- `@ddl/core` (pure) parses drawing files and produces a compact **description**: title, text
  elements, shapes with their text, arrows as "A → B" through bindings (or "from/to near" when
  unbound), lines, freehand stroke count, frames, and size. Shared by the agent and the clients.
- Wherever the agent reads a note (the orchestrator's digest, `read_note`, subagent context), each
  embedded drawing is expanded into its description with a pointer to the drawing file.
- A new read-only tool `read_drawing(path)` returns the description and, for vision-capable
  models, a PNG. The daemon renders drawings to PNG with the agent's headless Chromium
  (Playwright, already a dependency) and a small self-hosted render page built with Excalidraw's
  export; renders are cached by content hash in `DDL_HOME` (machine-local). Without a browser, the
  description alone is returned and readiness says so.
- Drawings are user content: agents don't write drawing files in this scope (any write goes
  through the gate as a vault write, which asks).

## Web specifics

- `@excalidraw/excalidraw` pinned in the catalog; loaded lazily (dynamic import) the first time a
  note shows a drawing; the initial bundle budget holds. Fonts and assets self-hosted
  (`EXCALIDRAW_ASSET_PATH`), never a CDN (local-first, CSP `font-src 'self'`). The app's theme
  maps to Excalidraw's theme.
- Floats in CodeMirror 6: the embed line renders a widget with `float: left/right` and a width;
  following lines wrap around it (the approach Obsidian's live preview uses). Measure it against
  CodeMirror's viewport and height map so scrolling stays stable.

## Mac specifics

- A new Swift package `DailyDoListDrawing` (Foundation + CoreGraphics model, renderer and tools;
  AppKit only in its view layer), with the scene model, JSON codec, the file format (sharing the
  web's fixtures), the Rough.js port, the renderer and the canvas view. Excalifont (OFL) bundled
  with its license.
- `DailyDoListEditor` wraps text around drawings with TextKit exclusion paths and hosts the canvas
  in place for editing.

## Shared fixtures

`packages/core/test/drawings/` holds drawing files (ours and plugin-style, compressed and not,
with unknown fields) and expected descriptions. TypeScript and Swift both parse, round-trip and
describe them; a new fixture is added whenever either side finds a case.

## Streams

- **X0 format and description** (core, contract if a route is needed, fixtures): parse and
  serialize `.excalidraw.md` (vendored LZ-String for `compressed-json`, MIT, with its notice),
  the embed modifiers, the element types (typed subset plus passthrough), the description
  generator, fixtures.
- **X1 web editor** (packages/editor, apps/web): floats and wrapping, move and resize, insert
  drawing, in-place editing with Excalidraw, saving, previews, e2e.
- **X2 Mac drawing engine** (`DailyDoListDrawing`): model, codec, file format against the shared
  fixtures, Rough.js port, renderer, tools, canvas view, tests.
- **X3 Mac editor integration** (`DailyDoListEditor`, app): exclusion-path wrapping, move and
  resize, insert drawing, in-place editing with the X2 canvas, saving.
- **X4 the agent sees drawings** (agent, daemon): descriptions in the digest and `read_note`,
  `read_drawing` with the Playwright renderer and cache, safety hints, eval cases, docs.

Order: X0 and X2 start together (X2 writes its own Swift model from Excalidraw's schema and
adopts X0's fixtures when they land); X1 and X4 start from X0; X3 starts when X2's canvas works.
