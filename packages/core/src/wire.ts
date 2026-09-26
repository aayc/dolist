/**
 * The wire protocol's types, inferred from the zod schemas in `@ddl/contract` (their one source).
 * Type-only: neither contract nor zod exists at runtime here. The path is relative because
 * contract depends on core, so core can't declare contract as a dependency (turbo rejects the
 * cycle); `turbo.json` in this package adds contract's schemas to core's inputs instead.
 */
export type * from "../../contract/src/wire/types";
