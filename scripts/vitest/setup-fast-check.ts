/**
 * Shared Vitest setup: property-based tests (fast-check) run with a bounded number of cases so the
 * whole suite stays fast. Reproduce a failure with the seed fast-check prints:
 *   FC_SEED=<seed> pnpm --filter <pkg> test
 * Run a deeper sweep locally with FC_NUM_RUNS=2000.
 *
 * TEST_TIME_SCALE (1 by default) stretches Vitest's default timeouts here and the timing budgets of
 * the tests that assert an algorithm stays fast; CI sets it because shared runners are several times
 * slower than a dev machine.
 */
import fc from "fast-check";
import { vi } from "vitest";

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

fc.configureGlobal({
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(seed === undefined || Number.isNaN(seed) ? {} : { seed }),
});

const timeScale = Number(process.env.TEST_TIME_SCALE) || 1;
if (timeScale !== 1)
  vi.setConfig({ testTimeout: 5_000 * timeScale, hookTimeout: 10_000 * timeScale });
