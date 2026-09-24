import { describe, expect, it, vi } from "vitest";
import { setAnnotationsEffect } from "./annotations/field";
import { findLinkAt, followLinkAtCursor, urlTarget } from "./links";
import { apply, parsedState, run } from "./test-helpers";
import type { EditorCallbacks } from "./types";

describe("findLinkAt", () => {
  const doc =
    "[[Note#Plan|alias]] [site](https://example.com) <mailto:a@b.co> www.x.org [rel](Daily/2026-06-19.md#Tasks)";
  const state = parsedState(doc);
  const at = (text: string) => findLinkAt(state, doc.indexOf(text) + 1);

  it("resolves wikilinks without subpath or alias in the target", () => {
    expect(at("Note")).toMatchObject({ kind: "wiki", target: "Note", subpath: "Plan" });
    expect(at("alias")).toMatchObject({ kind: "wiki", target: "Note" });
  });

  it("resolves inline links, autolinks and bare URLs", () => {
    expect(at("site")).toMatchObject({ kind: "external", url: "https://example.com" });
    expect(at("mailto")).toMatchObject({ kind: "external", url: "mailto:a@b.co" });
    expect(at("www.x")).toMatchObject({ kind: "external", url: "https://www.x.org" });
  });

  it("treats scheme-less destinations as note links", () => {
    expect(at("rel")).toMatchObject({
      kind: "wiki",
      target: "Daily/2026-06-19.md",
      subpath: "Tasks",
    });
  });

  it("returns null away from links", () => {
    expect(findLinkAt(parsedState("plain text"), 3)).toBeNull();
  });
});

describe("urlTarget", () => {
  it("refuses unsafe schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "vbscript:x",
    ]) {
      expect(urlTarget(url, 0, 1), url).toBeNull();
    }
  });

  it("normalizes emails, protocol-relative URLs and angle brackets", () => {
    expect(urlTarget("sam@example.com", 0, 1)).toMatchObject({ url: "mailto:sam@example.com" });
    expect(urlTarget("//cdn.example.com/x", 0, 1)).toMatchObject({
      url: "https://cdn.example.com/x",
    });
    expect(urlTarget("<My%20Note.md>", 0, 1)).toMatchObject({ kind: "wiki", target: "My Note.md" });
  });
});

describe("followLinkAtCursor (Alt-Enter)", () => {
  function callbacks(): Required<
    Pick<EditorCallbacks, "onWikiLinkClick" | "onExternalLinkClick" | "onAnnotationClick">
  > {
    return { onWikiLinkClick: vi.fn(), onExternalLinkClick: vi.fn(), onAnnotationClick: vi.fn() };
  }

  it("follows the link under the cursor", () => {
    const cb = callbacks();
    const state = parsedState("go [[Home]] now", { callbacks: cb, selection: { anchor: 6 } });
    expect(followLinkAtCursor({ state, dispatch: vi.fn() })).toBe(true);
    expect(cb.onWikiLinkClick).toHaveBeenCalledWith("Home", { newPane: false });
  });

  it("opens the agent thread of the cursor's line when there is no link", () => {
    const cb = callbacks();
    let state = parsedState("- [ ] task", { callbacks: cb, selection: { anchor: 8 } });
    const annotation = {
      id: "t1",
      line: 0,
      status: "working" as const,
      label: "Researching…",
      unread: 1,
      threadId: "th1",
    };
    state = apply(state, { effects: setAnnotationsEffect.of([annotation]) });
    expect(followLinkAtCursor({ state, dispatch: vi.fn() })).toBe(true);
    expect(cb.onAnnotationClick).toHaveBeenCalledWith(annotation);
    expect(run(parsedState("plain"), followLinkAtCursor)).toBeNull();
  });

  it("opens the thread that wrote the line when it has no badge", () => {
    const onAgentLineClick = vi.fn();
    const doc = "\t- Trattoria Sole at 7 %%agent:thr_ab12%%\n- noted %%agent%%";
    const at = (anchor: number) =>
      followLinkAtCursor({
        state: parsedState(doc, { callbacks: { onAgentLineClick }, selection: { anchor } }),
        dispatch: vi.fn(),
      });
    expect(at(4)).toBe(true);
    expect(onAgentLineClick).toHaveBeenCalledWith("thr_ab12");
    expect(at(doc.length)).toBe(false);
    expect(onAgentLineClick).toHaveBeenCalledTimes(1);
  });
});
