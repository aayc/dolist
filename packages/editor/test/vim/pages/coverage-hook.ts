/**
 * Receives the observation hooks of the instrumented vim.js (scripts/bundle.ts): the default
 * keymap and ex command table captured when the engine initializes, and every keymap entry / ex
 * command the engine then dispatches.
 */

export interface KeymapEntry {
  keys: string;
  type: string;
  context?: string;
  motion?: string;
  operator?: string;
  action?: string;
}

export interface ExCommandEntry {
  name: string;
  shortName?: string;
}

export interface CaseCoverage {
  keys: number[];
  ex: string[];
}

declare global {
  var __ddlVimTables: { keymap: KeymapEntry[]; exCommands: ExCommandEntry[] } | undefined;
  var __ddlVimCoverage: CoverageRecorder | undefined;
}

export class CoverageRecorder {
  readonly keymap: KeymapEntry[];
  readonly exCommands: ExCommandEntry[];
  private readonly index = new Map<object, number>();
  private matchedKeys = new Set<number>();
  private matchedEx = new Set<string>();

  constructor() {
    const tables = globalThis.__ddlVimTables;
    if (!tables) throw new Error("vim.js was bundled without the coverage hooks");
    tables.keymap.forEach((entry, i) => {
      this.index.set(entry, i);
    });
    this.keymap = tables.keymap.map(({ keys, type, context, motion, operator, action }) => ({
      keys,
      type,
      ...(context === undefined ? {} : { context }),
      ...(motion === undefined ? {} : { motion }),
      ...(operator === undefined ? {} : { operator }),
      ...(action === undefined ? {} : { action }),
    }));
    this.exCommands = tables.exCommands.map(({ name, shortName }) => ({
      name,
      ...(shortName === undefined ? {} : { shortName }),
    }));
    globalThis.__ddlVimCoverage = this;
  }

  key(entry: object): void {
    const i = this.index.get(entry);
    if (i !== undefined) this.matchedKeys.add(i);
  }

  ex(name: string): void {
    this.matchedEx.add(name);
  }

  take(): CaseCoverage {
    const result = {
      keys: [...this.matchedKeys].sort((a, b) => a - b),
      ex: [...this.matchedEx].sort(),
    };
    this.matchedKeys = new Set();
    this.matchedEx = new Set();
    return result;
  }
}
