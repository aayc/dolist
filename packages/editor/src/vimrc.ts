/**
 * vimrc parsing: one ex command per line, `"` comment lines, blank lines, optional leading `:`.
 * Also understood: `let mapleader = "x"` (then `<leader>` in later lines) and Obsidian's
 * `exmap name command` (an ex command alias, typically for `:obcommand`).
 */
import type { VimrcProblem } from "./types";

export type VimrcCommand =
  | { kind: "ex"; line: number; input: string }
  | { kind: "exmap"; line: number; name: string; command: string };

export interface ParsedVimrc {
  commands: VimrcCommand[];
  problems: VimrcProblem[];
}

const LEADER_RE = /^let\s+(?:g:)?mapleader\s*=\s*(["'])(.*)\1$/;
const DEFAULT_LEADER = "\\";

/** A leader in key notation: vim.js reads `<Space>`, not a literal space, in mappings. */
function leaderKeys(value: string): string {
  if (value === " " || /^\\<space>$/i.test(value)) return "<Space>";
  if (value === "<") return "<lt>";
  return value;
}

export function parseVimrc(text: string): ParsedVimrc {
  const commands: VimrcCommand[] = [];
  const problems: VimrcProblem[] = [];
  let leader = DEFAULT_LEADER;
  text.split(/\r\n?|\n/).forEach((raw, line) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith('"')) return;
    const input = trimmed.replace(/^:+\s*/, "");
    if (input === "") return;
    if (/^let\s/.test(input)) {
      const match = LEADER_RE.exec(input);
      if (match) leader = leaderKeys(match[2]!);
      else problems.push({ line, message: "Only `let mapleader = …` is supported" });
      return;
    }
    const expanded = input.replace(/<leader>/gi, leader);
    const exmap = /^exmap\s+(\S+)\s+(.+)$/.exec(expanded);
    if (exmap) {
      commands.push({ kind: "exmap", line, name: exmap[1]!, command: exmap[2]!.replace(/^:/, "") });
    } else if (/^exmap\b/.test(expanded)) {
      problems.push({ line, message: "exmap needs a name and a command" });
    } else {
      commands.push({ kind: "ex", line, input: expanded });
    }
  });
  return { commands, problems };
}

/** Option names a `set` line changes (`set noic`, `setlocal tw=40`, `se clipboard=unnamed`). */
export function optionsSetBy(input: string): string[] {
  const match = /^(?:se|set|setl|setlocal|setg|setglobal)\s+(.+)$/.exec(input);
  if (!match) return [];
  const name = /^(?:no)?([A-Za-z]\w*)/.exec(match[1]!.trim())?.[1];
  return name ? [name] : [];
}

/** Ex-command aliases (`:map :name …`) a vimrc line creates. */
export function exMappingsCreatedBy(command: VimrcCommand): string[] {
  if (command.kind === "exmap") return [`:${command.name}`];
  const match = /^(?:map|no|nor|nore|norem|norema|noremap)!?\s+(:\S+)/.exec(command.input);
  return match ? [match[1]!] : [];
}
