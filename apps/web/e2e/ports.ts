/**
 * The e2e harness's control port (packages/agent/scripts/e2e-daemons.ts); its daemons take free
 * ports. Set DDL_E2E_PORT so two checkouts can run their suites side by side.
 */
export const E2E_PORT = Number(process.env.DDL_E2E_PORT ?? 4173);
