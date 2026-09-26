import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianImporter } from "./importer";
import {
  ALL_BYTES,
  currentSettings,
  link,
  makeTestbed,
  OBSIDIAN_DAILY,
  OBSIDIAN_FILES,
  PNG_BYTES,
  snapshotTree,
  type Testbed,
  TODAY,
  type VaultOptions,
} from "./test-vaults";

let bed: Testbed;

async function setup(options: { obsidian?: VaultOptions; current?: VaultOptions } = {}) {
  bed = await makeTestbed(options);
  return importerFor(bed);
}

function importerFor(testbed: Testbed, settings = currentSettings()) {
  return new ObsidianImporter({
    places: { home: testbed.home, vault: testbed.vault, homedir: testbed.dir },
    settings: () => settings,
    now: () => TODAY,
  });
}

afterEach(async () => {
  await bed?.cleanup();
});

describe("the preview report", () => {
  let importer: ObsidianImporter;

  beforeEach(async () => {
    importer = await setup();
  });

  it("inventories the Obsidian vault", async () => {
    const report = await importer.preview(bed.source);
    const bytes = Object.values(OBSIDIAN_FILES).reduce((sum, c) => sum + Buffer.byteLength(c), 0);
    const pdf = Buffer.byteLength(OBSIDIAN_FILES["Attachments/scan.pdf"]!);
    expect(report).toMatchObject({
      source: bed.source,
      isObsidianVault: true,
      files: Object.keys(OBSIDIAN_FILES).length,
      bytes,
      notes: 9,
      folders: 14,
      attachments: {
        count: 4,
        bytes: PNG_BYTES.length + ALL_BYTES.length * 2 + pdf,
        byType: [
          { type: "image", count: 1, bytes: PNG_BYTES.length },
          { type: "pdf", count: 1, bytes: pdf },
          { type: "audio", count: 1, bytes: ALL_BYTES.length },
          { type: "other", count: 1, bytes: ALL_BYTES.length },
        ],
      },
      templates: { folder: "Templates", count: 2 },
      canvases: { count: 1, paths: ["Boards/Plan.canvas"] },
      drawings: { count: 1, paths: ["Excalidraw/Sketch.excalidraw.md"] },
      skipped: { count: 0, items: [] },
    });
  });

  it("lists the settings it found and what it will import from them", async () => {
    const { settings } = await importer.preview(bed.source);
    expect(settings).toEqual({
      files: [
        ".obsidian/daily-notes.json",
        ".obsidian/app.json",
        ".obsidian/appearance.json",
        ".obsidian.vimrc",
      ],
      dailyNotes: OBSIDIAN_DAILY,
      editor: { vimMode: true, livePreview: true, showLineNumbers: true, spellcheck: false },
      vimrc: true,
      theme: "dark",
    });
  });

  it("says how each enabled plugin fares here", async () => {
    const { plugins } = await importer.preview(bed.source);
    expect(plugins).toEqual([
      { id: "dataview", name: "Dataview", support: "partial", note: "Queries show as text." },
      {
        id: "obsidian-excalidraw-plugin",
        name: "Excalidraw",
        support: "supported",
        note: "Drawings open and edit here.",
      },
      {
        id: "templater-obsidian",
        support: "partial",
        note: "Templates insert as plain text; Templater commands don't run.",
      },
      {
        id: "obsidian-tasks-plugin",
        support: "partial",
        note: "Task lines work; query blocks show as text.",
      },
      {
        id: "homemade-widget",
        support: "unknown",
        note: "Doesn't run here; its files are kept and it still works in Obsidian.",
      },
    ]);
  });

  it("plans the carry-over of the current vault", async () => {
    const { carryOver, defaultDestination, warnings } = await importer.preview(bed.source);
    expect(carryOver).toEqual({
      vault: bed.vault,
      dailyNotes: OBSIDIAN_DAILY,
      dailyNotesFrom: "obsidian",
      notes: {
        count: 6,
        items: [
          { from: ".trash/Deleted note.md", to: ".trash/Deleted note.md" },
          { from: "Attachments/receipt.png", to: "Attachments/receipt.png" },
          { from: "Excalidraw/Flow.excalidraw.md", to: "Excalidraw/Flow.excalidraw.md" },
          { from: "Notes/Groceries.md", to: "Notes/Groceries.md" },
          { from: "Routines/Morning briefing.md", to: "Routines/Morning briefing.md" },
          { from: "ideas.md", to: "ideas (Daily Do List).md" },
        ],
      },
      daily: {
        count: 3,
        merged: 1,
        items: [
          {
            date: "2026-09-22",
            from: "Daily/2026-09-22.md",
            to: "Journal/Daily/2026/09/2026-09-22.md",
            merged: false,
          },
          {
            date: "2026-09-23",
            from: "Daily/2026-09-23.md",
            to: "Journal/Daily/2026/09/2026-09-23.md",
            merged: false,
          },
          {
            date: "2026-09-24",
            from: "Daily/2026-09-24.md",
            to: "Journal/Daily/2026/09/2026-09-24.md",
            merged: true,
          },
        ],
      },
      collisions: { count: 1, items: [{ from: "ideas.md", to: "ideas (Daily Do List).md" }] },
      routines: 1,
      drawings: 1,
      agent: {
        threads: 5,
        detached: 1,
        records: 4,
        approvals: 1,
        routines: 1,
        trackedNotes: 2,
        journal: 5,
      },
      watchedOpenTasks: 2,
      actOnExistingTasks: false,
      leftBehind: { count: 1, paths: [".obsidian"] },
    });
    expect(defaultDestination).toBe(join(bed.dir, "Obsidian Notebook (Daily Do List)"));
    expect(warnings).toEqual([
      '1 file has the same name as one in the Obsidian vault and gets "(Daily Do List)" added; links to it lead to the Obsidian one.',
    ]);
  });

  it("writes nothing: both vaults are byte for byte and time for time as they were", async () => {
    const before = [await snapshotTree(bed.source), await snapshotTree(bed.vault)];
    await importer.preview(bed.source);
    expect([await snapshotTree(bed.source), await snapshotTree(bed.vault)]).toEqual(before);
  });

  it("warns that the agent will act on Obsidian's open tasks when it acts on existing ones", async () => {
    const acting = importerFor(bed, currentSettings({ actOnExistingTasks: true }));
    const report = await acting.preview(bed.source);
    expect(report.carryOver).toMatchObject({ watchedOpenTasks: 2, actOnExistingTasks: true });
    expect(report.warnings).toContain(
      'After the switch the agent looks at 2 open tasks in Obsidian\'s daily notes for the days it watches, because "Act on existing tasks" is on.',
    );
  });

  it("warns when this device syncs its vault", async () => {
    const syncing = new ObsidianImporter({
      places: { home: bed.home, vault: bed.vault, homedir: bed.dir },
      settings: () => currentSettings(),
      syncing: () => true,
      now: () => TODAY,
    });
    expect((await syncing.preview(bed.source)).warnings).toContain(
      "This device syncs its vault: turn sync off before switching to the new vault, or the old notes sync back into it.",
    );
  });
});

describe("links and special files in the Obsidian vault", () => {
  it("counts links to files inside it, and skips the rest without following them", async () => {
    const importer = await setup();
    const outside = join(bed.dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "not for the vault\n");
    await link(bed.source, "Links/inside.md", join(bed.source, "Ideas.md"));
    await link(bed.source, "Links/outside.md", join(outside, "secret.md"));
    await link(bed.source, "Links/outside-folder", outside);
    await link(bed.source, "Links/inside-folder", join(bed.source, "Projects"));
    await link(bed.source, "Links/dangling.md", join(bed.source, "missing.md"));
    await mkdir(join(bed.source, ".daily-do-list/threads"), { recursive: true });
    await writeFile(join(bed.source, ".daily-do-list/threads/thr_x.json"), "{}");

    const report = await importer.preview(bed.source);
    expect(report.skipped).toEqual({
      count: 5,
      items: [
        { path: ".daily-do-list", reason: "sidecar" },
        { path: "Links/dangling.md", reason: "unreadable" },
        { path: "Links/inside-folder", reason: "symlink_folder" },
        { path: "Links/outside-folder", reason: "symlink_outside" },
        { path: "Links/outside.md", reason: "symlink_outside" },
      ],
    });
    expect(report.notes).toBe(10);
    expect(report.warnings).toContain("2 links lead outside the vault and aren't copied.");
  });
});

describe("daily-note settings for the new vault", () => {
  it("uses Obsidian's defaults when its Daily notes plugin is on without a config file", async () => {
    const importer = await setup({ obsidian: { files: { ".obsidian/daily-notes.json": null } } });
    const { settings, carryOver } = await importer.preview(bed.source);
    expect(settings.dailyNotes).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
    expect(carryOver.dailyNotesFrom).toBe("obsidian_defaults");
    expect(carryOver.daily.items.map((item) => item.to)).toEqual([
      "2026-09-22.md",
      "2026-09-23.md",
      "2026-09-24.md",
    ]);
  });

  it("keeps this vault's when Obsidian's plugin is off", async () => {
    const importer = await setup({
      obsidian: {
        files: {
          ".obsidian/daily-notes.json": null,
          ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": false }),
        },
      },
    });
    const { settings, carryOver } = await importer.preview(bed.source);
    expect(settings.dailyNotes).toBeNull();
    expect(carryOver.dailyNotesFrom).toBe("daily_do_list");
    expect(carryOver.daily.items.every((item) => item.to === item.from)).toBe(true);
  });

  it("keeps this vault's, and says why, when Obsidian's format can't be read back", async () => {
    const importer = await setup({
      obsidian: {
        files: {
          ".obsidian/daily-notes.json": JSON.stringify({ folder: "Days", format: "[Day] X" }),
        },
      },
    });
    const { carryOver, warnings } = await importer.preview(bed.source);
    expect(carryOver.dailyNotesFrom).toBe("daily_do_list");
    expect(carryOver.dailyNotes).toEqual({ folder: "Daily", format: "YYYY-MM-DD", template: "" });
    expect(warnings[0]).toBe(
      "Obsidian's daily-note format \"[Day] X\" can't be read here, so daily notes keep Daily Do List's folder and format.",
    );
  });

  it("treats a folder without .obsidian as plain notes", async () => {
    const importer = await setup();
    await rm(join(bed.source, ".obsidian"), { recursive: true });
    const report = await importer.preview(bed.source);
    expect(report).toMatchObject({
      isObsidianVault: false,
      plugins: [],
      templates: { folder: null },
      settings: { dailyNotes: null, files: [".obsidian.vimrc"] },
      carryOver: { dailyNotesFrom: "daily_do_list" },
    });
    expect(report.warnings[0]).toBe(
      "This folder has no .obsidian folder: it's copied as a plain folder of notes.",
    );
  });
});

describe("where the Obsidian vault may be", () => {
  it.each([
    ["a relative path", () => "Obsidian Notebook", /absolute path/],
    ["a missing folder", () => join(bed.dir, "nope"), /There's no folder at/],
    ["a file", () => join(bed.source, "Ideas.md"), /is a file, not a vault folder/],
    ["Daily Do List's own folder", () => bed.home, /Daily Do List's own folder/],
    ["inside Daily Do List's folder", () => join(bed.home, "inner"), /Daily Do List's own folder/],
    ["the current vault", () => bed.vault, /current Daily Do List vault/],
    ["inside the current vault", () => join(bed.vault, "Notes"), /current Daily Do List vault/],
    ["a folder holding Daily Do List's folder", () => bed.dir, /Daily Do List's own folder/],
  ])("refuses %s", async (_name, path, message) => {
    const importer = await setup();
    await mkdir(join(bed.home, "inner"), { recursive: true });
    await expect(importer.preview(path())).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: expect.stringMatching(message),
    });
  });

  it("refuses a folder that holds the current vault", async () => {
    await setup();
    const vault = join(bed.source, "Projects");
    const importer = new ObsidianImporter({
      places: { home: bed.home, vault, homedir: bed.dir },
      settings: () => currentSettings(),
    });
    await expect(importer.preview(bed.source)).rejects.toMatchObject({
      message: "The Obsidian vault can't be in or hold the current Daily Do List vault",
    });
  });

  it("refuses a link that leads into the current vault", async () => {
    const importer = await setup();
    await link(bed.dir, "sneaky", bed.vault);
    await expect(importer.preview(join(bed.dir, "sneaky"))).rejects.toMatchObject({
      message: expect.stringMatching(/current Daily Do List vault/),
    });
  });

  it("expands ~/ against the home directory", async () => {
    const importer = await setup();
    expect((await importer.preview("~/Obsidian Notebook")).source).toBe(bed.source);
  });
});
