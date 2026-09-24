import type { CitedSource } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import {
  findSource,
  type LinkPreviewDeps,
  LinkPreviews,
  notePreviewLines,
  uncitedLinks,
} from "./link-previews";

const SOURCES: CitedSource[] = [
  {
    url: "https://tables.example/r/trattoria-sole",
    title: "Trattoria Sole — Book a table",
    snippet: "Tables for 2 at 7:00 PM on Friday.",
  },
  { url: "https://www.reviews.example/sole/", title: "Trattoria Sole reviews" },
];

describe("notePreviewLines", () => {
  it("takes the first non-empty lines, without frontmatter or agent markers", () => {
    const note = [
      "---",
      "tags: [food]",
      "---",
      "# Restaurants",
      "",
      "- Trattoria Sole — fresh pasta %%agent:thr_1%%",
      "\t- book ahead on Fridays",
      "   ",
      ...Array.from({ length: 10 }, (_, i) => `- place ${i}`),
    ].join("\n");
    expect(notePreviewLines(note)).toEqual([
      "# Restaurants",
      "- Trattoria Sole — fresh pasta",
      "  - book ahead on Fridays",
      "- place 0",
      "- place 1",
      "- place 2",
      "- place 3",
      "- place 4",
    ]);
    expect(notePreviewLines("---\nnot closed\ntext", 2)).toEqual(["---", "not closed"]);
    expect(notePreviewLines("")).toEqual([]);
  });
});

describe("findSource", () => {
  it("matches the same address, then the same page", () => {
    expect(findSource(SOURCES, "https://tables.example/r/trattoria-sole")).toBe(SOURCES[0]);
    expect(findSource(SOURCES, "https://reviews.example/sole#menu")).toBe(SOURCES[1]);
    expect(findSource(SOURCES, "https://www.tables.example/r/trattoria-sole/")).toBe(SOURCES[0]);
    expect(findSource(SOURCES, "https://tables.example/r/other")).toBeUndefined();
    expect(findSource(SOURCES, "not a url")).toBeUndefined();
  });
});

describe("uncitedLinks", () => {
  it("lists web links whose sources the thread doesn't have yet", () => {
    const text =
      "Sole has a table [1](https://tables.example/r/trattoria-sole) and good reviews [2](https://reviews.example/sole). See [[Restaurants]] and [the map](https://maps.example/x).";
    expect(uncitedLinks(text, SOURCES)).toEqual(["https://maps.example/x"]);
    expect(uncitedLinks("no links, just [[Notes]]")).toEqual([]);
  });
});

describe("LinkPreviews", () => {
  function setup(overrides: Partial<LinkPreviewDeps> = {}) {
    const deps: LinkPreviewDeps = {
      files: () => ["Restaurants.md", "Projects/Garden Redesign.md"],
      openContent: () => null,
      readNote: vi.fn(async (path: string) => `# ${path}\n\n- first`),
      sources: vi.fn(async () => SOURCES),
      ...overrides,
    };
    return { deps, previews: new LinkPreviews(deps) };
  }

  it("describes web links on agent lines from their thread's sources", async () => {
    const { deps, previews } = setup();
    const url = "https://tables.example/r/trattoria-sole";
    expect(
      await previews.forEditor({
        link: { kind: "external", url, from: 0, to: 1 },
        label: "1",
        threadId: "thr_1",
      }),
    ).toEqual({
      kind: "web",
      url,
      title: "Trattoria Sole — Book a table",
      hostname: "tables.example",
      snippet: "Tables for 2 at 7:00 PM on Friday.",
    });
    expect(deps.sources).toHaveBeenCalledWith("thr_1");
    // The user's own lines have no thread: label, host and URL only.
    expect(await previews.web(url, "their site", null)).toEqual({
      kind: "web",
      url,
      title: "their site",
      hostname: "tables.example",
    });
    expect(deps.sources).toHaveBeenCalledTimes(1);
  });

  it("previews notes by name from the open text or one cached read", async () => {
    const readNote = vi.fn(async () => "# Garden Redesign\n\nGoals for the spring refresh.");
    const { previews } = setup({
      readNote,
      openContent: (path) => (path === "Restaurants.md" ? "# Restaurants\n- Sole %%agent%%" : null),
    });
    expect(await previews.note("garden redesign")).toEqual({
      kind: "note",
      title: "Garden Redesign",
      lines: ["# Garden Redesign", "Goals for the spring refresh."],
    });
    await previews.note("Garden Redesign");
    expect(readNote).toHaveBeenCalledOnce();
    previews.invalidate("Projects/Garden Redesign.md");
    await previews.note("Garden Redesign");
    expect(readNote).toHaveBeenCalledTimes(2);

    expect(await previews.note("Restaurants")).toEqual({
      kind: "note",
      title: "Restaurants",
      lines: ["# Restaurants", "- Sole"],
    });
    expect(readNote).toHaveBeenCalledTimes(2);
  });

  it("reports missing notes, and retries a failed read next time", async () => {
    const readNote = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("hi");
    const { previews } = setup({ readNote });
    expect(await previews.note("Nowhere")).toEqual({
      kind: "note",
      title: "Nowhere",
      lines: [],
      missing: true,
    });
    expect(await previews.note("Restaurants")).toMatchObject({ missing: true });
    expect(await previews.note("Restaurants")).toEqual({
      kind: "note",
      title: "Restaurants",
      lines: ["hi"],
    });
  });
});
