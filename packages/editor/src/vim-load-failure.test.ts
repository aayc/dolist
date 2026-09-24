// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { createMarkdownEditor } from "./editor";
import { isVimLoaded, preloadVim } from "./vim";

const chunk = vi.hoisted(() => ({ failures: 1 }));

vi.mock("@replit/codemirror-vim", async (importOriginal) => {
  if (chunk.failures > 0) {
    chunk.failures--;
    throw new Error("Failed to fetch dynamically imported module");
  }
  return importOriginal();
});

it("a failed vim chunk load is not an unhandled rejection and is retried later", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, { doc: "x", config: { vimMode: true } });
  await expect(preloadVim()).rejects.toThrow();
  expect(isVimLoaded()).toBe(false);
  expect(editor.getDocument()).toBe("x");

  // Toggling vim again (or the host preloading it) retries the import.
  editor.configure({ vimMode: false });
  editor.configure({ vimMode: true });
  await preloadVim();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(isVimLoaded()).toBe(true);
  editor.destroy();
});
