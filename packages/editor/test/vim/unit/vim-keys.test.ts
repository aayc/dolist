import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIM_CTRL_KEYS } from "../../../src/vim-keys";

/** vim.js's `defaultKeymap` array literal (plain objects, strings and booleans only). */
function engineKeymap(): Array<{ keys: string; context?: string }> {
  const require = createRequire(import.meta.url);
  const adapter = require.resolve("@replit/codemirror-vim");
  const core = createRequire(adapter).resolve("@replit/codemirror-vim-core");
  const source = readFileSync(core, "utf8");
  const start = source.indexOf("var defaultKeymap = [");
  const end = source.indexOf("];", start);
  return new Function(`return ${source.slice(start + "var defaultKeymap = ".length, end + 1)}`)();
}

describe("vim's Ctrl keys", () => {
  it("lists exactly the Ctrl keys vim.js binds outside insert mode", () => {
    const engine = new Set(
      engineKeymap()
        .filter((entry) => entry.context !== "insert")
        .map((entry) => /^<C-[^>]+>/.exec(entry.keys)?.[0])
        .filter((key): key is string => key !== undefined),
    );
    expect([...DEFAULT_VIM_CTRL_KEYS].sort()).toEqual([...engine].sort());
  });
});
