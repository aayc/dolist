/**
 * Test utilities for anything that speaks the wire protocol: fast-check arbitraries derived from
 * every named schema (`arb.thread()`, `arb.serverEvent()`, `wireArbitraries.ThreadResponse()`) and
 * a mutation-based generator of invalid values (`invalidFor(schema, arb)`). Tests only: it depends
 * on fast-check, which production bundles must not include.
 */
export { arb, arbitraryFor, wireArbitraries } from "./arbitraries";
export { invalidFor, mutate, withExtraKey } from "./mutate";
export { TINY_JPEG_BASE64 } from "./primitives";
