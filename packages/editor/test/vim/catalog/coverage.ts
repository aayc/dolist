/**
 * Every entry of vim.js's `defaultKeymap` and every `defaultExCommandMap` command must be
 * exercised by at least one catalog case (observed at runtime by the instrumented engine), or be
 * listed here with the reason it can't be pinned down by vectors (README "Exclusions").
 */
import type { CaseCoverage, ExCommandEntry, KeymapEntry } from "../pages/coverage-hook";

/** Keyed by `<context>:<keys>` (`*` when the entry has no context). */
export const KEYMAP_EXCLUSIONS: Readonly<Record<string, string>> = {
  "*:=": "`=` re-indents through the language's indentation rules; the oracle has no language",
  "*:gc": "`gc` toggles comments with the language's comment tokens; the oracle has no language",
};

export const EX_EXCLUSIONS: Readonly<Record<string, string>> = {};

export function keymapId(entry: KeymapEntry): string {
  return `${entry.context ?? "*"}:${entry.keys}`;
}

export interface CoverageReport {
  uncoveredKeys: string[];
  uncoveredEx: string[];
  /** Exclusions that name nothing in the current engine (stale entries). */
  staleExclusions: string[];
  coveredKeys: number;
  coveredEx: number;
}

export function checkCoverage(
  tables: { keymap: readonly KeymapEntry[]; exCommands: readonly ExCommandEntry[] },
  perCase: readonly CaseCoverage[],
): CoverageReport {
  const keysHit = new Set<number>();
  const exHit = new Set<string>();
  for (const coverage of perCase) {
    for (const index of coverage.keys) keysHit.add(index);
    for (const name of coverage.ex) exHit.add(name);
  }
  const keymapIds = tables.keymap.map(keymapId);
  const uncoveredKeys = keymapIds.filter(
    (id, index) => !keysHit.has(index) && KEYMAP_EXCLUSIONS[id] === undefined,
  );
  const exNames = tables.exCommands.map((entry) => entry.name);
  const uncoveredEx = exNames.filter(
    (name) => !exHit.has(name) && EX_EXCLUSIONS[name] === undefined,
  );
  const staleExclusions = [
    ...Object.keys(KEYMAP_EXCLUSIONS).filter((id) => !keymapIds.includes(id)),
    ...Object.keys(EX_EXCLUSIONS).filter((name) => !exNames.includes(name)),
  ];
  return {
    uncoveredKeys,
    uncoveredEx,
    staleExclusions,
    coveredKeys: keysHit.size,
    coveredEx: exNames.filter((name) => exHit.has(name)).length,
  };
}
