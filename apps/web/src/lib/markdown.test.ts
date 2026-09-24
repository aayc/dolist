import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { wikiLinks } from "./markdown";

// DOMPurify needs a real browser (happy-dom's output is wrong): the sanitized result, citations
// included, is checked in apps/web/e2e/markdown.spec.ts.
const marked = new Marked({ gfm: true, async: false, extensions: [wikiLinks] });
const html = (source: string) => marked.parse(source, { async: false }).trim();

describe("wikilinks in agent markdown", () => {
  it("become note links carrying the target and subpath", () => {
    expect(html("See [[Restaurants]] and [[Projects/Garden Redesign#Beds|the beds]].")).toBe(
      '<p>See <a href="#" data-wikilink="Restaurants">Restaurants</a> and ' +
        '<a href="#" data-wikilink="Projects/Garden Redesign" data-subpath="Beds">the beds</a>.</p>',
    );
    expect(html("an embed ![[Ideas]]")).toBe(
      '<p>an embed <a href="#" data-wikilink="Ideas">Ideas</a></p>',
    );
  });

  it("leave same-note links and code alone", () => {
    expect(html("same note [[#Heading]] and `[[Nope]]`")).toBe(
      "<p>same note [[#Heading]] and <code>[[Nope]]</code></p>",
    );
  });

  it("escape targets and labels", () => {
    expect(html('[[a"><img src=x>|<b>x</b>]]')).toBe(
      '<p><a href="#" data-wikilink="a&quot;&gt;&lt;img src=x&gt;">&lt;b&gt;x&lt;/b&gt;</a></p>',
    );
  });
});
