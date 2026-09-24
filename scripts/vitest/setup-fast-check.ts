/**
 * Shared Vitest setup: property-based tests (fast-check) run with a bounded number of cases so the
 * whole suite stays fast. Reproduce a failure with the seed fast-check prints:
 *   FC_SEED=<seed> pnpm --filter <pkg> test
 * Run a deeper sweep locally with FC_NUM_RUNS=2000.
 */
import fc from "fast-check";

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

fc.configureGlobal({
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(seed === undefined || Number.isNaN(seed) ? {} : { seed }),
});
