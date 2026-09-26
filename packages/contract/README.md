# @ddl/contract

Runtime schemas (zod 4) for every data contract of Daily Do List, kept in lockstep with the
TypeScript types in `@ddl/core` by type-level tests:

- **Wire** (`src/wire/`): the daemon protocol — every REST request/response body, every
  WebSocket `ServerEvent`/`ClientEvent`, the domain objects they carry (task records, threads,
  messages, approvals, artifacts, frames, settings), the error vocabulary, and `API_CONTRACT`,
  the route table. The human-readable reference is `docs/PROTOCOL.md`.
- **Persisted** (`src/persisted/`): the sidecar file formats under `.daily-do-list/` (owned
  separately; see that folder).

| Import | What |
| --- | --- |
| `@ddl/contract` | Everything (wire + persisted). |
| `@ddl/contract/wire` | Wire schemas, `API_CONTRACT`, `matchRoute`, `exact`, `WIRE_SCHEMAS`. |
| `@ddl/contract/testing` | fast-check arbitraries and invalid-value generators. **Tests only.** |

The web app must not import zod at runtime: it uses `@ddl/contract` in tests only (its event
guards in `apps/web/src/api/events.ts` are differential-tested against these schemas).

## Strict requests, tolerant responses

- **Requests are strict** — REST bodies and client WebSocket events reject unknown keys
  (`z.strictObject`). A typo (`baseversion`) or a setting this daemon doesn't know fails loudly
  with 400 `invalid_request` instead of being silently dropped.
- **Responses and server events are tolerant** — `z.looseObject`: unknown keys are accepted and
  preserved, so an older client keeps working against a newer daemon that added fields. Clients
  must also ignore server event `type`s they don't know.
- **Query strings** ignore unknown parameters (proxies and cache-busters add them).
- **Conformance tests use `exact(schema)`**, which makes every object strict recursively, so a
  producer (the daemon, the agent runtime) can't emit a key the contract
  doesn't declare. Tolerance is for consumers; producers are held to the exact shape.

The JSON Schema export reflects the rule: requests have `"additionalProperties": false`,
responses `"additionalProperties": {}`.

## Versioning and compatibility

`API_VERSION` (`@ddl/core`) is an integer **major** version. A client and a daemon interoperate
exactly when their versions are equal: clients check `GET /api/health` → `apiVersion`, both sides
exchange it in the WebSocket `hello`, and the daemon closes incompatible sockets with
`WS_CLOSE_CODES.incompatibleApiVersion` (4426). See `docs/PROTOCOL.md` for the handshake.

Within a major version only **additive** changes are allowed:

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

1. **Core type**: add or change the TypeScript shape in `packages/core/src/protocol.ts` (or
   `agent-types.ts` / `settings.ts`) and the route in `API_ROUTES`.
2. **Schema**: add the zod schema next to its peers in `src/wire/` with `named(id, description,
   schema)` — `strictObject` for requests, `looseObject` for responses/events — and list it in
   `WIRE_SCHEMAS` (`src/wire/catalog.ts`; add request schemas to `REQUEST_SCHEMA_NAMES`).
3. **Lockstep**: map the name to the core type in `test/wire/lockstep.test.ts`. `tsc` fails until
   `z.input`/`z.output` and the core type are mutually assignable.
4. **Route table**: add the route to `API_CONTRACT` (`src/wire/routes.ts`) with its `auth`
   (`bearer`; `pairing_code` for `/api/pair`, where the code in the body is the credential;
   `upgrade` for `/ws`), params, query, body and the response of every status it can answer
   (`{ kind: "empty" }` for a 204). `satisfies Record<ApiRouteName, …>` fails until every
   `API_ROUTES` entry has one.
5. **Arbitrary**: add a generator to `wireArbitraries` (`src/testing/arbitraries.ts`); the typed
   map fails to compile without one. Mix realistic values with edge cases.
6. **Fixtures**: add canonical `fixtures/wire/<Name>.valid.json` cases and tricky
   `<Name>.invalid.json` ones (with the expected issue `path` and `code`).
7. **Producers**: implement it in the daemon (validate requests with the contract schema) and in
   the web mock; the conformance suites (`apps/daemon/src/contract*.test.ts`,
   `packages/agent/test/contract.test.ts`, `apps/web/src/api/**/*.contract.test.ts`) must pass.
8. **Regenerate**: `pnpm --filter @ddl/contract generate` rewrites `schema/*.json` and the
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

- `arb.*` / `wireArbitraries[Name]()` generate valid values for every named schema: realistic
  text mixed with unicode (graphemes, astral code points, controls), empty-but-valid strings,
  maximum lengths, every enum value, epoch 0 and `MAX_SAFE_INTEGER`. Values are plain objects that
  survive a JSON round trip unchanged.
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
pnpm --filter @ddl/contract test       # schemas, lockstep, fixtures, properties, freshness
pnpm --filter @ddl/contract generate   # schema/*.json and docs/PROTOCOL.md
```
