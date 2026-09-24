// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostnameOf,
  LinkPopover,
  linkPreviewAt,
  renderLinkPreview,
  webLinkPreview,
} from "./link-preview";
import { linkAt } from "./links";
import { parsedState } from "./test-helpers";
import type { EditorCallbacks, LinkPreview } from "./types";

describe("hostnameOf", () => {
  it("names the web host without www, and nothing for other links", () => {
    expect(hostnameOf("https://www.tables.example/r/sole?x=1")).toBe("tables.example");
    expect(hostnameOf("http://Sub.Example.com:8080/")).toBe("sub.example.com");
    expect(hostnameOf("mailto:sam@example.com")).toBe("");
    expect(hostnameOf("not a url")).toBe("");
  });
});

describe("webLinkPreview", () => {
  const url = "https://www.tables.example/r/trattoria-sole";

  it("uses the cited source's title and snippet", () => {
    expect(
      webLinkPreview(url, "OpenTable", {
        url,
        title: " Trattoria Sole — Book a table ",
        snippet: "Tables for 2 at 7:00 PM.",
      }),
    ).toEqual({
      kind: "web",
      url,
      title: "Trattoria Sole — Book a table",
      hostname: "tables.example",
      snippet: "Tables for 2 at 7:00 PM.",
    });
  });

  it("falls back to the link text, or the host when the text is a number or the URL", () => {
    expect(webLinkPreview(url, "the menu")).toMatchObject({ title: "the menu" });
    expect(webLinkPreview(url, "2")).toMatchObject({ title: "tables.example" });
    expect(webLinkPreview(url, url, { url, title: "  " })).toMatchObject({
      title: "tables.example",
    });
    expect(webLinkPreview("mailto:sam@example.com", "mailto:sam@example.com")).toEqual({
      kind: "web",
      url: "mailto:sam@example.com",
      title: "sam@example.com",
      hostname: "",
    });
  });
});

describe("renderLinkPreview", () => {
  const texts = (el: HTMLElement) =>
    [...el.children].map((child) => [child.className.replace("cm-ddl-link-preview-", ""), child]);

  it("renders a web card: title, host, snippet and the full URL", () => {
    const card = renderLinkPreview(document, {
      kind: "web",
      url: "https://a.example/x",
      title: "<img src=x onerror=alert(1)>",
      hostname: "a.example",
      snippet: "What the agent saw.",
    });
    expect(card.className).toBe("cm-ddl-link-preview cm-ddl-link-preview-web");
    expect(texts(card).map(([name, el]) => [name, (el as HTMLElement).textContent])).toEqual([
      ["title", "<img src=x onerror=alert(1)>"],
      ["host", "a.example"],
      ["snippet", "What the agent saw."],
      ["url", "https://a.example/x"],
    ]);
    expect(card.querySelector("img")).toBeNull();
  });

  it("renders a note card with its first lines, or says it's missing or empty", () => {
    const note = (preview: Omit<Extract<LinkPreview, { kind: "note" }>, "kind">) =>
      renderLinkPreview(document, { kind: "note", ...preview });
    const card = note({ title: "Restaurants", lines: ["# Restaurants", "- Trattoria Sole"] });
    expect(card.querySelector(".cm-ddl-link-preview-title")?.textContent).toBe("Restaurants");
    expect(
      [...card.querySelectorAll(".cm-ddl-link-preview-line")].map((el) => el.textContent),
    ).toEqual(["# Restaurants", "- Trattoria Sole"]);
    expect(note({ title: "Nope", lines: [], missing: true }).textContent).toBe(
      "NopeNo note with this name yet",
    );
    expect(note({ title: "Blank", lines: [] }).textContent).toBe("BlankEmpty note");
  });
});

describe("linkAt", () => {
  const doc =
    "[[Note#Plan|the plan]] [[Other]] [menu](https://a.example) <https://b.example> https://c.example";
  const state = parsedState(doc);
  const at = (text: string) => linkAt(state, doc.indexOf(text) + 1, 1);

  it("returns the link with its visible text", () => {
    expect(at("the plan")).toMatchObject({ label: "the plan", link: { target: "Note" } });
    expect(at("Other")).toMatchObject({ label: "Other", link: { target: "Other" } });
    expect(at("menu")).toMatchObject({ label: "menu", link: { url: "https://a.example" } });
    expect(at("https://b")).toMatchObject({ label: "https://b.example" });
    expect(at("https://c")).toMatchObject({ label: "https://c.example" });
    expect(linkAt(state, doc.indexOf("]] [[") + 2, 1)).toBeNull();
  });
});

describe("linkPreviewAt", () => {
  const at = (doc: string, text: string, callbacks: EditorCallbacks = {}) =>
    linkPreviewAt(parsedState(doc, { callbacks }), doc.indexOf(text) + 1, 1);

  it("asks the host, passing the thread named by the line's agent marker", async () => {
    const card: LinkPreview = { kind: "web", url: "https://a.example", title: "A", hostname: "" };
    const onLinkPreview = vi.fn(async () => card);
    const doc = "- Found [it](https://a.example) %%agent:thr_1%%";
    const found = await at(doc, "it]", { onLinkPreview });
    expect(onLinkPreview).toHaveBeenCalledWith({
      link: expect.objectContaining({ kind: "external", url: "https://a.example" }),
      label: "it",
      threadId: "thr_1",
    });
    expect(found).toEqual({
      link: { kind: "external", url: "https://a.example", from: 8, to: doc.indexOf(" %%") },
      preview: card,
    });
  });

  it("falls back to the label, host and URL for web links, and to nothing for notes", async () => {
    const doc = "see [the menu](https://www.a.example/menu) and [[Ideas]]";
    const fallback = {
      kind: "web",
      url: "https://www.a.example/menu",
      title: "the menu",
      hostname: "a.example",
    };
    expect((await at(doc, "the menu", { onLinkPreview: () => null }))?.preview).toEqual(fallback);
    expect((await at(doc, "the menu"))?.preview).toEqual(fallback);
    const failing = { onLinkPreview: () => Promise.reject(new Error("offline")) };
    expect((await at(doc, "the menu", failing))?.preview).toEqual(fallback);
    expect(await at(doc, "Ideas")).toBeNull();
    expect(await at(doc, "see")).toBeNull();
  });

  it("uses the host's note preview for wikilinks, with no thread on the user's lines", async () => {
    const note: LinkPreview = { kind: "note", title: "Ideas", lines: ["# Ideas"] };
    const onLinkPreview = vi.fn(() => note);
    const found = await at("see [[Ideas|my ideas]]", "my ideas", { onLinkPreview });
    expect(onLinkPreview).toHaveBeenCalledWith({
      link: expect.objectContaining({ kind: "wiki", target: "Ideas" }),
      label: "my ideas",
      threadId: null,
    });
    expect(found?.preview).toBe(note);
  });
});

describe("LinkPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows one card below its anchor, inside the window, and hides it", () => {
    const popover = new LinkPopover(document);
    const preview: LinkPreview = { kind: "note", title: "Ideas", lines: ["# Ideas"] };
    popover.show(preview, { left: 40, top: 100, bottom: 120 });
    popover.show(preview, { left: 50, top: 100, bottom: 120 });
    const cards = document.querySelectorAll<HTMLElement>(".cm-ddl-link-popover");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("role")).toBe("tooltip");
    expect(cards[0]?.style.top).toBe("126px");
    expect(cards[0]?.style.left).toBe("50px");
    expect(cards[0]?.textContent).toBe("Ideas# Ideas");
    popover.hide();
    expect(document.querySelector(".cm-ddl-link-popover")).toBeNull();
  });
});
