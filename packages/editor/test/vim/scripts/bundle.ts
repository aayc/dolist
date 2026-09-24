/**
 * Bundles a Chromium page entry with esbuild. The oracle build also instruments vim.js with three
 * observation-only hooks (listed below) that report the default keymap, the ex command table and
 * which entries each case exercised, for the catalog's coverage check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const COVERAGE_HOOKS: ReadonlyArray<{ anchor: string; inject: string; before: boolean }> = [
  {
    anchor: "var langmap = parseLangmap('');",
    inject:
      "globalThis.__ddlVimTables = { keymap: defaultKeymap.slice(), exCommands: defaultExCommandMap.slice() };",
    before: false,
  },
  {
    anchor: "return {type: 'full', command: bestMatch};",
    inject: "globalThis.__ddlVimCoverage?.key(bestMatch, context);",
    before: true,
  },
  {
    anchor: "exCommands[commandName](cm, params);",
    inject: "globalThis.__ddlVimCoverage?.ex(commandName);",
    before: true,
  },
];

const coveragePlugin: Plugin = {
  name: "vim-coverage-hooks",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /codemirror-vim-core[\\/]vim\.js$/ }, (args) => {
      let source = readFileSync(args.path, "utf8");
      for (const { anchor, inject, before } of COVERAGE_HOOKS) {
        const at = source.indexOf(anchor);
        if (at === -1 || source.indexOf(anchor, at + 1) !== -1) {
          throw new Error(`vim.js coverage anchor not found exactly once: ${anchor}`);
        }
        const replacement = before ? `${inject} ${anchor}` : `${anchor} ${inject}`;
        source = source.slice(0, at) + replacement + source.slice(at + anchor.length);
      }
      return { contents: source, loader: "js" };
    });
  },
};

export interface BundleOptions {
  instrumentVim?: boolean;
}

export async function bundlePage(entry: string, options: BundleOptions = {}): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../pages/${entry}`, import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    legalComments: "none",
    logLevel: "warning",
    loader: { ".css": "text" },
    plugins: options.instrumentVim ? [coveragePlugin] : [],
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}
