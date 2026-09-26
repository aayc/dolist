# Spec: drawings in notes (Excalidraw-compatible)

Status: built (`052dcc8`).

Decided with the user (2026-09-25):

- Free-form diagrams on notes, as fun and easy as Excalidraw and **fully Obsidian-compatible**:
  the Obsidian Excalidraw plugin's file format and embed syntax, so either app opens them.
- **Anchored in the note, text flows around them**: a drawing floats left or right with the text
  wrapping around it (or sits full width), anchored at a line; drag it to move it, drag a corner
  to resize. Typing never collides with a drawing. A new drawing floats right with wrap.
- **The web app embeds the real Excalidraw** (`@excalidraw/excalidraw`), loaded only when needed.
- **The Mac app gets a native engine written from scratch** (for speed) with Excalidraw's core
  tools and shortcuts, its hand-drawn look (a port of Rough.js, seeded like Excalidraw) and
  palette. Elements or fields it doesn't support are preserved untouched.
- **The orchestrator always sees drawings**: a text description of every drawing in the notes it
  reads, plus a rendered image for models that see images. Agents never write drawings.

Where it is now: the file format in [DATA_FORMATS.md](../DATA_FORMATS.md#drawings--excalidrawnameexcalidrawmd-vault-content-owned-by-ddlcore)
and the shared fixtures in `packages/core/test/drawings/`; the embed layer in
[packages/editor](../../packages/editor/README.md#embeds); the web editor in
[apps/web](../../apps/web/README.md#drawings); the Mac engine in
`apps/macos/Packages/DailyDoListDrawing`; what agents see in
[AGENT_SYSTEM.md](../AGENT_SYSTEM.md#how-agents-see-drawings). Images inside drawings (`files`)
are preserved but not yet drawn on the Mac.
