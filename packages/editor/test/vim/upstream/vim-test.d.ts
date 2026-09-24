declare module "@replit/codemirror-vim-core/test/vim_test.js" {
  /** Defines vim.js's test suite by calling `test(name, fn)` for every test. */
  export function vimTests(
    CodeMirror: unknown,
    test: (name: string, fn: () => unknown, expectedFail?: unknown) => unknown,
  ): void;
}
