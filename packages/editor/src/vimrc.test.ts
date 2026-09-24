import { describe, expect, it } from "vitest";
import { exMappingsCreatedBy, optionsSetBy, parseVimrc } from "./vimrc";

describe("parseVimrc", () => {
  it("keeps one ex command per line and skips blank and comment lines", () => {
    const { commands, problems } = parseVimrc(
      [
        '" insert-mode escape',
        "",
        "imap jj <Esc>",
        "   ",
        '  " indented comment',
        "nmap j gj",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(commands).toEqual([
      { kind: "ex", line: 2, input: "imap jj <Esc>" },
      { kind: "ex", line: 5, input: "nmap j gj" },
    ]);
  });

  it("accepts CRLF line endings and leading colons", () => {
    expect(parseVimrc(":set clipboard=unnamed\r\n::nmap Y y$\r\n").commands).toEqual([
      { kind: "ex", line: 0, input: "set clipboard=unnamed" },
      { kind: "ex", line: 1, input: "nmap Y y$" },
    ]);
  });

  it("expands <leader> with the latest mapleader, a backslash by default", () => {
    const { commands } = parseVimrc(
      [
        "nmap <leader>a x",
        'let mapleader = ","',
        "nmap <Leader>w :w<CR>",
        'let g:mapleader="\\<Space>"',
        "nmap <leader>q :q<CR>",
        "let mapleader=' '",
        "nmap <LEADER>e :e<CR>",
      ].join("\n"),
    );
    expect(commands.map((c) => c.kind === "ex" && c.input)).toEqual([
      "nmap \\a x",
      "nmap ,w :w<CR>",
      "nmap <Space>q :q<CR>",
      "nmap <Space>e :e<CR>",
    ]);
  });

  it("turns exmap into an ex alias and reports what it can't use", () => {
    const { commands, problems } = parseVimrc(
      ["exmap back obcommand app:go-back", "exmap", "let g:other = 1", "exmap tab :tabnext"].join(
        "\n",
      ),
    );
    expect(commands).toEqual([
      { kind: "exmap", line: 0, name: "back", command: "obcommand app:go-back" },
      { kind: "exmap", line: 3, name: "tab", command: "tabnext" },
    ]);
    expect(problems).toEqual([
      { line: 1, message: "exmap needs a name and a command" },
      { line: 2, message: "Only `let mapleader = …` is supported" },
    ]);
  });

  it("tracks the options and ex aliases a line creates", () => {
    expect(optionsSetBy("set clipboard=unnamed")).toEqual(["clipboard"]);
    expect(optionsSetBy("se nopcre")).toEqual(["pcre"]);
    expect(optionsSetBy("setlocal tw=40")).toEqual(["tw"]);
    expect(optionsSetBy("nmap j gj")).toEqual([]);
    expect(exMappingsCreatedBy({ kind: "exmap", line: 0, name: "back", command: "x" })).toEqual([
      ":back",
    ]);
    expect(exMappingsCreatedBy({ kind: "ex", line: 0, input: "map :del x" })).toEqual([":del"]);
    expect(exMappingsCreatedBy({ kind: "ex", line: 0, input: "noremap :k j" })).toEqual([":k"]);
    expect(exMappingsCreatedBy({ kind: "ex", line: 0, input: "nmap jj x" })).toEqual([]);
  });
});
