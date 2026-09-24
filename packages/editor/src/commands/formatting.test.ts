import { describe, expect, it } from "vitest";
import { markedState, run, runMarked } from "../test-helpers";
import { insertLink, toggleBold, toggleHighlight, toggleItalic } from "./formatting";

describe("inline formatting", () => {
  it("wraps and unwraps the selection in bold", () => {
    expect(runMarked("a «word» b", toggleBold)).toBe("a **«word»** b");
    expect(runMarked("a **«word»** b", toggleBold)).toBe("a «word» b");
    expect(runMarked("a «**word**» b", toggleBold)).toBe("a «word» b");
  });

  it("acts on the word at the caret, or inserts an empty pair", () => {
    expect(runMarked("a wo|rd b", toggleBold)).toBe("a **wo|rd** b");
    expect(runMarked("a **wo|rd** b", toggleBold)).toBe("a wo|rd b");
    expect(runMarked("a | b", toggleBold)).toBe("a **|** b");
    expect(runMarked("a **|** b", toggleBold)).toBe("a | b");
  });

  it("distinguishes italic from bold", () => {
    expect(runMarked("«x»", toggleItalic)).toBe("*«x»*");
    expect(runMarked("*«x»*", toggleItalic)).toBe("«x»");
    expect(runMarked("**«x»**", toggleItalic)).toBe("***«x»***");
    expect(runMarked("***«x»***", toggleItalic)).toBe("**«x»**");
    expect(runMarked("***«x»***", toggleBold)).toBe("*«x»*");
    expect(runMarked("*«x»*", toggleBold)).toBe("***«x»***");
  });

  it("supports other markers", () => {
    expect(runMarked("«x»", toggleHighlight)).toBe("==«x»==");
    expect(runMarked("==«x»==", toggleHighlight)).toBe("«x»");
  });

  it("does nothing in a read-only editor", () => {
    expect(run(markedState("«x»", { config: { readOnly: true } }), toggleBold)).toBeNull();
  });
});

describe("insertLink (Mod-k)", () => {
  it("wraps text, wraps URLs, or inserts an empty link", () => {
    expect(runMarked("see «docs» here", insertLink)).toBe("see [docs](|) here");
    expect(runMarked("«https://example.com»", insertLink)).toBe("[|](https://example.com)");
    expect(runMarked("x |", insertLink)).toBe("x [|]()");
  });

  it("keeps whitespace selected around a URL outside the link", () => {
    expect(runMarked("visit «https://x.com »today", insertLink)).toBe(
      "visit [|](https://x.com) today",
    );
    expect(runMarked("visit« https://x.com» today", insertLink)).toBe(
      "visit [|](https://x.com) today",
    );
    expect(runMarked("«www.x.com\n»next", insertLink)).toBe("[|](www.x.com)\nnext");
  });
});
