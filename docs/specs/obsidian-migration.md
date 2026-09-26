# Spec: moving from Obsidian

Status: M (the merge race, `6750f36`) and I0/I1 (Import from Obsidian, `e2fd3ce`) built; B0 and P
not started.

Read `AGENTS.md` first (invariants: plain files, soft deletes, agents never silently change the
user's words, time is local, wire changes in the contract + Swift together, the keystroke path).
Related: `docs/SYNC.md`, `docs/DATA_FORMATS.md`, `packages/editor/README.md` (embeds).

## Decided with the user (2026-09-25)

- The user is switching from Obsidian (synced with Obsidian Sync). **They copy the vault; they
  don't share the folder** — no double sync. Their Obsidian vault is only ever read.
- Build all of: the editor merge-race fix, an import flow with a report first, carrying over the
  current Daily Do List notes, routines and agent history, the display gaps (images, tables,
  callouts, a backlinks panel), and syncing images and PDFs between devices.

## Built

- **M — the editor merge race.** An open editor re-saved lines deleted outside it after an agent
  edit (a deleted task came back and the orchestrator ran it again). Fixed on the web and the Mac;
  the guarantee and its property tests are in "Saving and merging",
  [packages/editor/README.md](../../packages/editor/README.md#saving-and-merging).
- **I0/I1 — Import from Obsidian** (engine, daemon, web and Mac): preview report, a new vault from
  a byte-for-byte copy with the current vault carried over, switching vaults, Update from Obsidian.
  How it works: [apps/daemon/README.md](../../apps/daemon/README.md#importing-from-obsidian); the
  user's steps: the root README, "Moving from Obsidian".

## B0 — binary files and attachment sync (after the always-on work lands)

`StorageProvider` gains binary reads and writes (local-fs, memory, remote) under the shared
contract tests; the sync service stores attachments
(content-addressed, size-limited) and the sync engine syncs them (newest wins, the other kept as a
conflict copy); the daemon serves vault files to clients (`GET /api/files/*`, bearer-authenticated,
correct content type, never executable content inline — the artifact policy applies). This is
also what the editors need to show images.

## P — the display gaps (after the drawings' embed layer, X1/X3)

On the web and the Mac, in live preview: **images** (`![[photo.png|300]]`, `![alt](path)`, with
Obsidian's size and alignment modifiers, sharing the drawings' embed layer and B0's file route),
**tables** (rendered; editing a cell shows the source row), **callouts** (`> [!note] Title`, the
standard types, foldable with `+`/`-`), and a **backlinks panel** (linked mentions with context,
plus unlinked mentions). Keystroke path stays O(line); performance budgets hold.
