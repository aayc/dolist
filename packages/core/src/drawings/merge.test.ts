import { describe, expect, it } from "vitest";
import { mergeDrawingElements, mergeDrawingFiles, newerDrawingElement } from "./merge";
import type { DrawingElement } from "./types";

function el(id: string, version: number, extra: Partial<DrawingElement> = {}): DrawingElement {
  return { id, type: "rectangle", version, versionNonce: 100, ...extra };
}

const ids = (elements: readonly DrawingElement[]) =>
  elements.map((e) => `${e.id}@${e.version}${e.isDeleted ? "x" : ""}`);

describe("newerDrawingElement: Excalidraw's rule", () => {
  it("takes the higher version, then the lower nonce, then the remote copy", () => {
    expect(newerDrawingElement(el("a", 3), el("a", 2)).version).toBe(3);
    expect(newerDrawingElement(el("a", 2), el("a", 3)).version).toBe(3);
    const low = el("a", 2, { versionNonce: 1, x: 1 });
    const high = el("a", 2, { versionNonce: 9, x: 2 });
    expect(newerDrawingElement(low, high)).toBe(low);
    expect(newerDrawingElement(high, low)).toBe(low);
    const remote = el("a", 2, { x: 3 });
    expect(newerDrawingElement(el("a", 2), remote)).toBe(remote);
  });
});

describe("mergeDrawingElements: base, local and remote", () => {
  const base = [el("a", 1), el("b", 1), el("c", 1)];

  it("keeps both sides' changes to different elements", () => {
    const local = [el("a", 2), el("b", 1), el("c", 1)];
    const remote = [el("a", 1), el("b", 1), el("c", 2)];
    expect(ids(mergeDrawingElements(base, local, remote))).toEqual(["a@2", "b@1", "c@2"]);
  });

  it("keeps elements either side added", () => {
    const local = [...base, el("mine", 1)];
    const remote = [el("theirs", 1), ...base];
    expect(ids(mergeDrawingElements(base, local, remote))).toEqual([
      "theirs@1",
      "a@1",
      "b@1",
      "c@1",
      "mine@1",
    ]);
  });

  it("places a local addition after the element before it locally", () => {
    const local = [el("a", 1), el("new", 1), el("b", 1), el("c", 1)];
    expect(ids(mergeDrawingElements(base, local, base))).toEqual(["a@1", "new@1", "b@1", "c@1"]);
    const first = [el("new", 1), ...base];
    expect(ids(mergeDrawingElements(base, first, base))[0]).toBe("new@1");
  });

  it("drops what one side deleted and the other didn't change", () => {
    const remoteDeleted = [el("a", 1), el("c", 1)];
    expect(ids(mergeDrawingElements(base, base, remoteDeleted))).toEqual(["a@1", "c@1"]);
    const localDropped = [el("a", 1), el("c", 1)];
    expect(ids(mergeDrawingElements(base, localDropped, base))).toEqual(["a@1", "c@1"]);
  });

  it("keeps an element one side changed while the other deleted it", () => {
    const local = [el("a", 1), el("b", 2), el("c", 1)];
    const remote = [el("a", 1), el("c", 1)];
    expect(ids(mergeDrawingElements(base, local, remote))).toEqual(["a@1", "b@2", "c@1"]);
    const remoteChanged = [el("a", 1), el("b", 5), el("c", 1)];
    expect(ids(mergeDrawingElements(base, [el("a", 1), el("c", 1)], remoteChanged))).toEqual([
      "a@1",
      "b@5",
      "c@1",
    ]);
  });

  it("lets a newer local deletion win over the unchanged remote copy", () => {
    const local = [el("a", 1), el("b", 2, { isDeleted: true }), el("c", 1)];
    expect(ids(mergeDrawingElements(base, local, base))).toEqual(["a@1", "b@2x", "c@1"]);
  });

  it("keeps the local copy of an element being edited", () => {
    const local = [el("a", 2, { text: "typing" }), el("b", 1), el("c", 1)];
    const remote = [el("a", 7), el("b", 1), el("c", 1)];
    const merged = mergeDrawingElements(base, local, remote, { editing: new Set(["a"]) });
    expect(merged[0]?.text).toBe("typing");
  });

  it("orders by fractional index when every element has one", () => {
    const local = [el("a", 1, { index: "a0" }), el("n", 1, { index: "a2" })];
    const remote = [el("r", 1, { index: "a1" }), el("a", 1, { index: "a0" })];
    expect(ids(mergeDrawingElements([el("a", 1, { index: "a0" })], local, remote))).toEqual([
      "a@1",
      "r@1",
      "n@1",
    ]);
  });

  it("merges images from both sides", () => {
    const file = (id: string, dataURL: string) => ({ id, mimeType: "image/png", dataURL });
    expect(
      mergeDrawingFiles(
        { one: file("one", "data:local"), two: file("two", "data:2") },
        { one: file("one", "data:remote"), three: file("three", "data:3") },
      ),
    ).toEqual({
      one: file("one", "data:local"),
      two: file("two", "data:2"),
      three: file("three", "data:3"),
    });
  });
});
