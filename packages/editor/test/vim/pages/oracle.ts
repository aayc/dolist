/** Page entry that generates vectors: the harness against the plain CM6 oracle editor. */
import type { CaseSpec, VectorCase } from "../format";
import { VimHarness } from "../harness/harness";
import { createOracleEditor } from "../harness/oracle-editor";
import {
  type CaseCoverage,
  CoverageRecorder,
  type ExCommandEntry,
  type KeymapEntry,
} from "./coverage-hook";

export interface OracleRun {
  vectors: VectorCase[];
  coverage: CaseCoverage[];
  errors: Array<{ name: string; error: string }>;
}

export interface OracleApi {
  engineTables(): { keymap: KeymapEntry[]; exCommands: ExCommandEntry[] };
  runCases(cases: CaseSpec[]): OracleRun;
}

declare global {
  interface Window {
    __vimOracle: OracleApi;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

const root = document.getElementById("root")!;
const harness = new VimHarness((spec) => createOracleEditor(root, spec));
const coverage = new CoverageRecorder();

window.__vimOracle = {
  engineTables: () => ({ keymap: coverage.keymap, exCommands: coverage.exCommands }),
  runCases(cases) {
    const run: OracleRun = { vectors: [], coverage: [], errors: [] };
    for (const spec of cases) {
      coverage.take();
      try {
        const vector = harness.run(spec);
        run.vectors.push(vector);
        run.coverage.push(coverage.take());
      } catch (error) {
        coverage.take();
        run.errors.push({ name: spec.name, error: describeError(error) });
      }
    }
    return run;
  },
};
