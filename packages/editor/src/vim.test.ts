// @vitest-environment happy-dom
import { getCM } from "@replit/codemirror-vim";
import { expect, it } from "vitest";
import { createMarkdownEditor } from "./editor";
import { isVimLoaded, preloadVim } from "./vim";

it("enables vim once the lazily-loaded module arrives", async () => {
  expect(isVimLoaded()).toBe(false);
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, { doc: "hello", config: { vimMode: true } });
  expect(getCM(editor.view)).toBeFalsy();

  await preloadVim();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(isVimLoaded()).toBe(true);
  expect(getCM(editor.view)).toBeTruthy();

  editor.configure({ vimMode: false });
  expect(getCM(editor.view)).toBeFalsy();
  editor.destroy();
});
