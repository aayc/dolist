import type { SearchHit } from "@ddl/core";

/** Returns at most `limit` hits for `query` (see `searchVault` in @ddl/storage). */
export type VaultSearch = (query: string, limit: number) => Promise<SearchHit[]>;
