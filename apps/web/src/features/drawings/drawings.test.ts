import {
  type DrawingBinaryFiles,
  type DrawingElement,
  emptyDrawingScene,
  type NoteResponse,
  parseDrawingFile,
  serializeDrawingFile,
  type WriteNoteRequest,
} from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError } from "../../api/errors";
import { type DrawingEditorPort, DrawingSession } from "./drawing-session";
import { Drawings, type DrawingsClient } from "./drawing-store";
import { ElementIds } from "./element-ids";
import { DrawingRenders } from "./render-cache";
import { editKey, sceneForFile } from "./scene";

const PATH = "Excalidraw/Plan.excalidraw.md";

function rect(id: string, version = 1, extra: Partial<DrawingElement> = {}): DrawingElement {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    version,
    versionNonce: 1,
    ...extra,
  };
}

function fileWith(
  elements: DrawingElement[],
  extra: Partial<ReturnType<typeof emptyDrawingScene>> = {},
) {
  return serializeDrawingFile({ ...emptyDrawingScene(), elements, ...extra });
}

class FakeFiles implements DrawingsClient {
  readonly files = new Map<string, { content: string; version: string }>();
  private next = 0;
  writes = 0;

  put(path: string, content: string): string {
    const version = `v${++this.next}`;
    this.files.set(path, { content, version });
    return version;
  }

  async readNote(path: string): Promise<NoteResponse> {
    const file = this.files.get(path);
    if (!file) throw new HttpError(404, "Note not found");
    return { path, ...file, mtime: 0 };
  }

  async writeNote(path: string, body: WriteNoteRequest) {
    const file = this.files.get(path);
    const stale =
      body.baseVersion === null ? file !== undefined : file?.version !== body.baseVersion;
    if (stale) {
      throw new ConflictError(file ? { path, ...file, mtime: 0 } : null);
    }
    this.writes++;
    return { path, version: this.put(path, body.content), mtime: 0 };
  }

  elements(path = PATH): DrawingElement[] {
    return parseDrawingFile(this.files.get(path)!.content).scene.elements;
  }
}

class FakeEditor implements DrawingEditorPort {
  elements: DrawingElement[];
  appState: Record<string, unknown> = { viewBackgroundColor: "#ffffff", zoom: { value: 1 } };
  files: DrawingBinaryFiles = {};
  editingIds = new Set<string>();
  replaced = 0;

  constructor(elements: readonly DrawingElement[]) {
    this.elements = [...elements];
  }

  scene() {
    return { elements: this.elements, appState: this.appState, files: this.files };
  }

  replace(elements: DrawingElement[], files: DrawingBinaryFiles): void {
    this.elements = elements;
    this.files = files;
    this.replaced++;
  }

  editing(): ReadonlySet<string> {
    return this.editingIds;
  }
}

async function open(files: FakeFiles, saveDelayMs = 0) {
  const drawings = new Drawings(files);
  const doc = await drawings.load(PATH);
  const onError = vi.fn();
  const session = new DrawingSession({ drawings, doc, saveDelayMs, onError });
  const editor = new FakeEditor(session.initialScene().elements);
  session.attach(editor);
  const edit = (change: (elements: DrawingElement[]) => DrawingElement[]) => {
    editor.elements = change(editor.elements);
    session.changed(editor.elements, editor.appState);
  };
  return { drawings, session, editor, edit, onError };
}

describe("ElementIds: the plugin's 8-character ids in the file", () => {
  it("gives Excalidraw's long ids short ones, and renames every reference", () => {
    let n = 0;
    const ids = new ElementIds(() => `short00${n++}`);
    const long = "q3Kf8x9aLmN0pQrStUvWx";
    const elements = ids.file([
      rect(long, 1, { boundElements: [{ id: "arrowAAAAAAAAAAAAAAAA", type: "arrow" }] }),
      {
        id: "arrowAAAAAAAAAAAAAAAA",
        type: "arrow",
        startBinding: { elementId: long, focus: 0, gap: 1 },
        endBinding: null,
      },
      { id: "keep1234", type: "text", containerId: long, frameId: null },
    ]);
    expect(elements.map((e) => e.id)).toEqual(["short000", "short001", "keep1234"]);
    expect(elements[0]!.boundElements).toEqual([{ id: "short001", type: "arrow" }]);
    expect(elements[1]!.startBinding).toEqual({ elementId: "short000", focus: 0, gap: 1 });
    expect(elements[2]!.containerId).toBe("short000");
  });

  it("keeps the same file id for the session, and translates file ids back", () => {
    const ids = new ElementIds();
    const long = "q3Kf8x9aLmN0pQrStUvWx";
    const first = ids.file([rect(long)])[0]!.id;
    expect(first).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(ids.file([rect(long, 2)])[0]!.id).toBe(first);
    expect(ids.local([rect(first, 3)])[0]!.id).toBe(long);
    expect(ids.local([rect("other123")])[0]!.id).toBe("other123");
  });

  it("returns untouched elements as they are", () => {
    const element = rect("abcd1234");
    expect(new ElementIds().file([element])[0]).toBe(element);
  });
});

describe("sceneForFile", () => {
  it("keeps live elements, the images they use and the view settings", () => {
    const image = (id: string) => ({
      id,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,",
    });
    const scene = sceneForFile(
      [
        rect("a1234567"),
        rect("b1234567", 2, { isDeleted: true }),
        { id: "i1234567", type: "image", fileId: "f1" },
      ],
      { viewBackgroundColor: "#fff", zoom: { value: 2 }, gridSize: null, selectedElementIds: {} },
      { f1: image("f1"), f2: image("f2") },
    );
    expect(scene.elements.map((e) => e.id)).toEqual(["a1234567", "i1234567"]);
    expect(scene.appState).toEqual({ viewBackgroundColor: "#fff", gridSize: null });
    expect(Object.keys(scene.files)).toEqual(["f1"]);
  });

  it("editKey changes with edits and view settings, not with the view", () => {
    const appState = { viewBackgroundColor: "#fff", zoom: { value: 1 } };
    const key = editKey([rect("a", 1)], appState);
    expect(editKey([rect("a", 1)], { ...appState, zoom: { value: 3 } })).toBe(key);
    expect(editKey([rect("a", 2)], appState)).not.toBe(key);
    expect(editKey([rect("a", 1)], { ...appState, viewBackgroundColor: "#000" })).not.toBe(key);
  });
});

describe("DrawingRenders: static renders by content hash", () => {
  it("renders once per hash and theme, and peeks at finished renders", async () => {
    const render = vi.fn(async () => ({ svg: null, width: 10, height: 5 }));
    const renders = new DrawingRenders(render);
    const scene = emptyDrawingScene();
    expect(renders.peek("h1", "light")).toBeNull();
    await Promise.all([renders.get("h1", scene, "light"), renders.get("h1", scene, "light")]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(renders.peek("h1", "light")).toEqual({ svg: null, width: 10, height: 5 });
    await renders.get("h1", scene, "dark");
    await renders.get("h2", scene, "light");
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("doesn't keep a failed render", async () => {
    const render = vi
      .fn()
      .mockRejectedValueOnce(new Error("no fonts"))
      .mockResolvedValue({ svg: null, width: 1, height: 1 });
    const renders = new DrawingRenders(render);
    await expect(renders.get("h", emptyDrawingScene(), "light")).rejects.toThrow("no fonts");
    await expect(renders.get("h", emptyDrawingScene(), "light")).resolves.toMatchObject({
      width: 1,
    });
  });

  it("evicts the least recently used", async () => {
    const render = vi.fn(async () => ({ svg: null, width: 1, height: 1 }));
    const renders = new DrawingRenders(render, 2);
    for (const hash of ["a", "b", "c"]) await renders.get(hash, emptyDrawingScene(), "light");
    expect(renders.peek("a", "light")).toBeNull();
    expect(renders.peek("c", "light")).not.toBeNull();
  });
});

describe("Drawings: the files, through the notes API", () => {
  it("loads once, and tells subscribers about new versions only", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567")]));
    const read = vi.spyOn(files, "readNote");
    const drawings = new Drawings(files);
    const [one, two] = await Promise.all([drawings.load(PATH), drawings.load(PATH)]);
    expect(one).toBe(two);
    expect(read).toHaveBeenCalledTimes(1);
    const seen: Array<string | null> = [];
    drawings.subscribe(PATH, (doc) => seen.push(doc?.version ?? null));
    drawings.adopt({ path: PATH, content: one.text, version: one.version });
    const version = files.put(PATH, fileWith([rect("b1234567")]));
    await drawings.handleRemoteChange(PATH, version);
    await drawings.handleRemoteChange(PATH, version);
    files.files.delete(PATH);
    await drawings.handleRemoteChange(PATH, "v99");
    expect(seen).toEqual([version, null]);
  });

  it("ignores changes to drawings nobody shows", async () => {
    const files = new FakeFiles();
    const read = vi.spyOn(files, "readNote");
    await new Drawings(files).handleRemoteChange(PATH, "v1");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("DrawingSession: saving and merging", () => {
  it("saves edits over the previous file, keeping what it doesn't know, with short ids", async () => {
    const files = new FakeFiles();
    const previous = fileWith([rect("a1234567", 1, { customField: "kept" })], {
      appState: { viewBackgroundColor: "#ffffff", theme: "dark" },
    });
    files.put(PATH, previous.replace("# Excalidraw Data", "Intro kept\n\n# Excalidraw Data"));
    const { session, edit } = await open(files);
    edit((elements) => [
      ...elements.map((e) => ({ ...e, version: 2, x: 5 })),
      rect("q3Kf8x9aLmN0pQrStUvWx"),
    ]);
    await session.flush();
    const saved = files.files.get(PATH)!.content;
    expect(saved).toContain("Intro kept");
    const scene = parseDrawingFile(saved).scene;
    expect(scene.elements[0]).toMatchObject({ id: "a1234567", x: 5, customField: "kept" });
    expect(scene.elements[1]!.id).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(scene.appState.theme).toBe("dark");
  });

  it("doesn't save when the editor only re-rendered or normalized the file", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567")]));
    const { session, editor } = await open(files);
    editor.appState = { ...editor.appState, zoom: { value: 2 }, scrollX: 40 };
    session.changed(editor.elements, editor.appState);
    await session.flush();
    expect(files.writes).toBe(0);
  });

  it("debounces saves", async () => {
    vi.useFakeTimers();
    try {
      const files = new FakeFiles();
      files.put(PATH, fileWith([rect("a1234567")]));
      const { edit } = await open(files, 300);
      edit((els) => els.map((e) => ({ ...e, version: 2 })));
      await vi.advanceTimersByTimeAsync(200);
      edit((els) => els.map((e) => ({ ...e, version: 3 })));
      await vi.advanceTimersByTimeAsync(200);
      expect(files.writes).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(files.writes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a conflict, merges the other version into the editor and saves both", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567"), rect("b1234567")]));
    const { session, editor, edit } = await open(files);
    files.put(PATH, fileWith([rect("a1234567"), rect("b1234567", 2, { x: 99 }), rect("theirs12")]));
    edit((els) => [
      ...els.map((e) => (e.id === "a1234567" ? { ...e, version: 2, y: 7 } : e)),
      rect("mine1234"),
    ]);
    await session.flush();
    const saved = files.elements();
    expect(saved.map((e) => e.id)).toEqual(["a1234567", "b1234567", "mine1234", "theirs12"]);
    expect(saved[0]).toMatchObject({ y: 7 });
    expect(saved[1]).toMatchObject({ x: 99 });
    expect(editor.elements.map((e) => e.id)).toContain("theirs12");
    expect(editor.replaced).toBe(1);
  });

  it("merges a change made elsewhere while editing, and saves only if it has edits of its own", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567")]));
    const { drawings, session, editor, edit } = await open(files);
    const version = files.put(PATH, fileWith([rect("a1234567"), rect("theirs12")]));
    await drawings.handleRemoteChange(PATH, version);
    expect(editor.elements.map((e) => e.id)).toEqual(["a1234567", "theirs12"]);
    await session.flush();
    expect(files.writes).toBe(0);
    edit((els) => [...els, rect("mine1234")]);
    await session.flush();
    expect(files.elements().map((e) => e.id)).toEqual(["a1234567", "theirs12", "mine1234"]);
  });

  it("deletes what the other side deleted, unless it was changed here", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567"), rect("b1234567")]));
    const { drawings, editor, edit, session } = await open(files);
    edit((els) => els.map((e) => (e.id === "b1234567" ? { ...e, version: 2 } : e)));
    const version = files.put(PATH, fileWith([]));
    await drawings.handleRemoteChange(PATH, version);
    expect(editor.elements.map((e) => e.id)).toEqual(["b1234567"]);
    await session.flush();
    expect(files.elements().map((e) => e.id)).toEqual(["b1234567"]);
  });

  it("recreates the file when it was deleted elsewhere", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567")]));
    const { session, edit } = await open(files);
    files.files.delete(PATH);
    edit((els) => [...els, rect("mine1234")]);
    await session.flush();
    expect(files.elements().map((e) => e.id)).toEqual(["a1234567", "mine1234"]);
  });

  it("never writes over a file it can't read", async () => {
    const files = new FakeFiles();
    files.put(
      PATH,
      "---\nexcalidraw-plugin: parsed\n---\n## Drawing\n```json\n{ not json\n```\n%%",
    );
    const { session, edit } = await open(files);
    expect(session.readable).toBe(false);
    edit((els) => [...els, rect("mine1234")]);
    await session.flush();
    expect(files.writes).toBe(0);
  });

  it("stops saving over a file that became unreadable elsewhere", async () => {
    const files = new FakeFiles();
    files.put(PATH, fileWith([rect("a1234567")]));
    const { drawings, session, edit, onError } = await open(files);
    const version = files.put(PATH, "## Drawing\n```json\n{ broken\n```");
    await drawings.handleRemoteChange(PATH, version);
    edit((els) => [...els, rect("mine1234")]);
    await session.flush();
    expect(files.writes).toBe(0);
    expect(onError).toHaveBeenCalled();
  });
});
