# @ddl/contract

Runtime schemas (zod 4) for every data contract of Daily Do List. The wire schemas are the single
source of the protocol's TypeScript types: `src/wire/types.ts` infers them (`WireType<Name>`, the
parsed output minus the index signatures of tolerant objects), and `@ddl/core` re-exports that
module type-only, so code imports `Thread` or `ServerEvent` from `@ddl/core` and zod never ships
with it. Enums whose values core owns (`AGENT_HARNESS_KINDS`, `APPROVAL_POLICIES`,
`ORCHESTRATOR_THREAD_ID`) are declared in core and passed to the schemas.

- **Wire** (`src/wire/`): the daemon protocol — every REST request/response body, every
  WebSocket `ServerEvent`/`ClientEvent`, the domain objects they carry (task records, threads,
  messages, approvals, artifacts, frames, settings), the error vocabulary, and `API_CONTRACT`,
  the route table. The human-readable reference is `docs/PROTOCOL.md`.
- **Persisted** (`src/persisted/`): the sidecar file formats under `.daily-do-list/` (see
  `docs/DATA_FORMATS.md`).

| Import | What |
| --- | --- |
| `@ddl/contract` | Everything (wire + persisted). |
| `@ddl/contract/wire` | Wire schemas, `API_CONTRACT`, `matchRoute`, `exact`, `WIRE_SCHEMAS`. |
| `@ddl/contract/testing` | fast-check arbitraries derived from the schemas, and invalid-value generators. **Tests only.** |

The web app must not import zod at runtime: it uses `@ddl/contract` in tests only (its event
guards in `apps/web/src/api/events.ts` are differential-tested against these schemas).

## Strict requests, tolerant responses

The rule is in `docs/PROTOCOL.md`; here it's `z.strictObject` for requests (unknown keys fail with
400 `invalid_request`) and `z.looseObject` for responses and server events (unknown keys accepted
and preserved), and the JSON Schema export says `"additionalProperties": false` or `{}`
accordingly. **Conformance tests use `exact(schema)`**, which makes every object strict
recursively, so a producer (the daemon, the agent runtime) can't emit a key the contract doesn't
declare: tolerance is for consumers, producers are held to the exact shape.

## Versioning and compatibility

`API_VERSION` (`@ddl/core`) is an integer **major** version; a client and a daemon interoperate
exactly when their versions are equal (the handshake is in `docs/PROTOCOL.md`). Within a major
version only **additive** changes are allowed:

| Change | Compatible? |
| --- | --- |
| New optional field in a response or event | Yes (old clients ignore it) |
| New event type | Yes (old clients ignore it) |
| New route or method | Yes |
| New optional request field | Yes for old clients; a new client must not send it to an older daemon (strict requests reject it) — check `version` from `/api/health` |
| New `ApiErrorCode` | Yes (clients treat unknown codes by HTTP status) |
| Relaxing a request constraint (wider range, longer max) | Yes |
| New value in an existing enum or union inside a payload (task status, message kind, category) | **No** — strict decoders (Swift `Codable`) and the web guards reject it |
| Removing/renaming a field, changing its type, making it required, tightening a constraint | **No** |

Breaking changes bump `API_VERSION`. To evolve a shape without breaking: add the new field as
optional next to the old one, have producers send both, migrate consumers, and only remove the old
field together with a major bump.

## How to add a route or event

1. **Schema**: add the zod schema next to its peers in `src/wire/` with `named(id, description,
   schema)` — `strictObject` for requests, `looseObject` for responses/events — and export it:
   `WIRE_SCHEMAS` (`src/wire/catalog.ts`) collects every exported named schema. Add request
   schemas to `REQUEST_SCHEMA_NAMES`.
2. **Type**: export `type Name = WireType<"Name">` from `src/wire/types.ts`; `@ddl/core` re-exports
   it. A new route also goes in `API_PATHS` (`packages/core/src/protocol.ts`), the one route
   table: the daemon registers its pattern and `API_ROUTES` builds its URLs from it.
3. **Route table**: add the route to `API_CONTRACT` (`src/wire/routes.ts`) with its `auth`
   (`bearer`; `pairing_code` for `/api/pair`, where the code in the body is the credential;
   `upgrade` for `/ws`), params, query, body and the response of every status it can answer
   (`{ kind: "empty" }` for a 204); its path comes from `API_PATHS`. `satisfies
   Record<ApiRouteName, …>` fails until every route has one.
4. **Generator**: none to write: `wireArbitraries` and `arb` derive one from the schema. A field
   whose refinement or format a generic value can't satisfy makes it throw, naming the field: give
   it realistic values in `BY_SCHEMA` (a shared schema) or `BY_PATH` (`Schema.field`) in
   `src/testing/arbitraries.ts`.
5. **Fixtures**: add canonical `fixtures/wire/<Name>.valid.json` cases and tricky
   `<Name>.invalid.json` ones (with the expected issue `path` and `code`).
6. **Producers and clients**: implement it in the daemon (validate requests with the contract
   schema), the web client and `DailyDoListModels` (Swift); the conformance suites
   (`apps/daemon/src/contract*.test.ts`, `packages/agent/test/contract.test.ts`,
   `apps/web/src/api/**/*.contract.test.ts`, the Swift fixture decoding tests) must pass.
7. **Regenerate**: `pnpm --filter @ddl/contract generate` rewrites `schema/*.json` and the
   reference in `docs/PROTOCOL.md`; tests fail while either is stale.

## Testing utilities

```ts
import { arb, invalidFor, wireArbitraries } from "@ddl/contract/testing";
import { exact, ServerEventSchema, WIRE_SCHEMAS } from "@ddl/contract/wire";
import { test } from "@fast-check/vitest";

test.prop([arb.serverEvent()])("reducer handles any event", (event) => { /* … */ });
test.prop([invalidFor(WIRE_SCHEMAS.WriteNoteRequest, arb.writeNoteRequest())])("rejects", (body) => {
  /* the daemon answers 400 invalid_request */
});
expect(exact(ServerEventSchema).safeParse(message).success).toBe(true);
```

- `arb.*` / `wireArbitraries[Name]()` generate valid values for every named schema, derived from
  it by `arbitraryFor(schema)`: every enum value and union member, optional keys present and
  absent, text mixed with unicode (graphemes, astral code points, controls), empty-but-valid
  strings, maximum lengths and numeric bounds, plus realistic values for ids, paths, URLs and
  names. Values are plain objects that parse unchanged and survive a JSON round trip.
- `invalidFor(schema, arb)` derives values that `schema` rejects by one mutation (dropped key,
  wrong type, out-of-range value, unknown key).
- `exact(schema)` — see above. `matchRoute(pathname)` resolves a URL to its `API_CONTRACT` entry
  (handy for fake daemons: see `apps/web/src/api/http-client.contract.test.ts`).

## JSON Schema for other clients

`schema/wire.schema.json` holds every named schema under `$defs` (draft 2020-12);
`schema/routes.json` describes every route and references those definitions
(`wire.schema.json#/$defs/Name`). Generate client models from them, e.g. for Swift:

```sh
npx quicktype --src-lang schema --lang swift -o Wire.swift packages/contract/schema/wire.schema.json
```

Treat `fixtures/wire/*.valid.json` as golden vectors (a client must decode every case) and
`*.invalid.json` as inputs a validating client must refuse. Refinements that JSON Schema can't
express (canonical vault paths) are described in each field's `description`.

## Commands

```sh
pnpm --filter @ddl/contract test       # schemas, fixtures, properties, freshness
pnpm --filter @ddl/contract generate   # schema/*.json and docs/PROTOCOL.md
```
