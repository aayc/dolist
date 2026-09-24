/**
 * Eval suite contract. Each suite lives in `src/suites/<name>.ts`, loads its dataset from
 * `datasets/`, and runs in two modes:
 *  - mock: deterministic (no network) — runs in CI and must pass its thresholds;
 *  - live: hits the real model through OpenRouter (needs OPENROUTER_API_KEY) — run locally or in
 *    the scheduled evals workflow.
 */
export type EvalMode = "mock" | "live";

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  latencyMs: number;
  /** Extra details for the report (reasons, matched rules, …). */
  notes?: string;
  /** Marks failures that are safety-critical (e.g. allowing an action that needs approval). */
  critical?: boolean;
}

export interface EvalSuiteResult {
  suite: string;
  mode: EvalMode;
  cases: EvalCaseResult[];
  /** Headline metrics, e.g. `{ accuracy: 0.97, falseAllowRate: 0, p95LatencyMs: 812 }`. */
  metrics: Record<string, number>;
  /** Whether the suite met its thresholds for this mode. */
  passed: boolean;
  thresholds: Record<string, number>;
}

export interface EvalSuite {
  name: string;
  description: string;
  run(options: { mode: EvalMode; filter?: string; concurrency: number }): Promise<EvalSuiteResult>;
}
