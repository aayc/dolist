# @ddl/sync

The sync service: devices share a vault through it. Per vault, a SQLite database (`node:sqlite`)
holds the live files, folders, an append-only change log and the agent lease; an HTTP API (Hono)
serves them with conditional writes, and a WebSocket stream pushes every accepted change. The
protocol is in `packages/core/src/sync-service.ts`; the client is `RemoteStorageProvider` in
`@ddl/storage`. Design, security model and self-hosting: [docs/SYNC.md](../../docs/SYNC.md).

```bash
pnpm --filter @ddl/sync build        # dist/main.js: one file, dependencies bundled
mkdir -p ~/ddl-sync && chmod 700 ~/ddl-sync
node apps/sync/dist/main.js vault create --name "Personal" --db ~/ddl-sync/sync.db
node apps/sync/dist/main.js serve --db ~/ddl-sync/sync.db          # 127.0.0.1:7332
pnpm --filter @ddl/sync test         # API, stream, leases, interleavings property, CLI
pnpm --filter @ddl/sync dev serve --db /tmp/ddl-sync-dev.db --port 17332   # tsx watch
```

| File | Role |
| --- | --- |
| `src/store.ts` | `SyncStore`: schema, transactions, files/folders/changes/leases, vaults and token hashes |
| `src/app.ts` | The HTTP API: authentication, rate limit, body limits, validation, routes |
| `src/stream.ts` | `StreamHub`: per-vault WebSockets, pushes, heartbeats, token re-checks |
| `src/server.ts` | `createSyncServer`: HTTP server, WebSocket upgrades, traffic summary, shutdown |
| `src/cli.ts`, `src/main.ts` | `serve`, `vault create / list / rotate-token` |
| `src/paths.ts`, `src/tokens.ts`, `src/rate-limit.ts`, `src/errors.ts` | Validation and helpers |

Tests start the server in process with a `:memory:` database on an ephemeral loopback port
(`startTestServer` in `src/test-helpers.ts`; `@ddl/storage` and `@ddl/daemon` use
`createSyncServer` the same way). The package exports `createSyncServer` and `SyncStore` for them.
