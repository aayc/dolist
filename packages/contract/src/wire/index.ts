/** Wire protocol schemas (REST bodies, WebSocket events, domain objects). */
export * from "./catalog";
export * from "./domain";
export * from "./errors";
export * from "./events";
export * from "./exact";
export * from "./imports";
export * from "./primitives";
export { namedWireSchemas, type WireSchemaMeta, wireRegistry } from "./registry";
export * from "./remote";
export * from "./rest";
export * from "./routes";
export * from "./settings";
export type * from "./types";
