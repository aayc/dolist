/**
 * Wire protocol between the daemon and UI clients (web today; desktop/mobile shells later).
 *
 * Transport:
 *  - REST/JSON under `/api/*` for request/response.
 *  - One WebSocket at `/ws` for server push (`ServerEvent`) and light client signals (`ClientEvent`).
 *
 * Auth: every request carries `Authorization: Bearer <token>` (the daemon's own token, or a paired
 * device's); the WebSocket takes the same header, or `?token=` on loopback Hosts only. A browser
 * on a remote host uses the HttpOnly device cookie it got when pairing instead. The exception is
 * `POST /api/pair`, where the pairing code in the body is the credential. The daemon binds to
 * 127.0.0.1 and rejects foreign `Host`/`Origin` headers (DNS-rebinding/CSRF); remote hosts are
 * configured names reached through a private-network proxy.
 *
 * The shapes are the zod schemas in `@ddl/contract`; their inferred types are re-exported from
 * `./wire`. The generated reference is `docs/PROTOCOL.md`.
 */

/**
 * Major version of the protocol, bumped only for breaking changes (everything else is additive).
 * A client and a daemon interoperate exactly when their API versions are equal.
 */
export const API_VERSION = 1;

export function isCompatibleApiVersion(apiVersion: number): boolean {
  return apiVersion === API_VERSION;
}

/** Application close codes (4000–4999) the daemon may use on `/ws`. */
export const WS_CLOSE_CODES = {
  /** The client's `hello.apiVersion` is not compatible with the daemon's `API_VERSION`. */
  incompatibleApiVersion: 4426,
} as const;

/** Header clients send so the daemon can tag the origin of a change and skip echoing it back. */
export const CLIENT_ID_HEADER = "x-ddl-client-id";

/**
 * Every route's path: `:name` is one segment, a trailing `*` the rest (a vault path). The daemon
 * registers these patterns and clients build URLs from them (`API_ROUTES`); what each route
 * accepts and answers is `API_CONTRACT` in `@ddl/contract`, rendered in docs/PROTOCOL.md.
 */
export const API_PATHS = {
  health: "/api/health",
  tree: "/api/vault/tree",
  note: "/api/notes/*",
  rename: "/api/notes-rename",
  folders: "/api/folders",
  daily: "/api/daily/:date",
  search: "/api/search",
  settings: "/api/settings",
  agentStatus: "/api/agent/status",
  agentEnabled: "/api/agent/enabled",
  tasks: "/api/tasks",
  threads: "/api/threads",
  thread: "/api/threads/:id",
  threadMessages: "/api/threads/:id/messages",
  threadCancel: "/api/threads/:id/cancel",
  threadRetry: "/api/threads/:id/retry",
  approvals: "/api/approvals",
  approval: "/api/approvals/:id",
  artifact: "/api/artifacts/:threadId/:artifactId",
  routines: "/api/routines",
  routine: "/api/routines/:id",
  routineRun: "/api/routines/:id/run",
  routinePause: "/api/routines/:id/pause",
  routineResume: "/api/routines/:id/resume",
  connectors: "/api/connectors",
  syncStatus: "/api/sync/status",
  computerPermissionsOpen: "/api/computer/permissions/open",
  device: "/api/device",
  deviceSync: "/api/device/sync",
  deviceVault: "/api/device/vault",
  importObsidianPreview: "/api/import/obsidian/preview",
  importObsidian: "/api/import/obsidian",
  importObsidianCancel: "/api/import/obsidian/cancel",
  importObsidianUpdate: "/api/import/obsidian/update",
  pairingCodes: "/api/pairing-codes",
  pair: "/api/pair",
  devices: "/api/devices",
  pairedDevice: "/api/devices/:id",
  machine: "/api/machine",
  machinePair: "/api/machine/pair",
  machineCheck: "/api/machine/check",
  machinePairing: "/api/machine/pairing",
  ws: "/ws",
} as const;

export type ApiRouteName = keyof typeof API_PATHS;

type PathArgs<P> = P extends `${string}/:${string}/${infer Rest}`
  ? [string, ...PathArgs<`/${Rest}`>]
  : P extends `${string}/:${string}` | `${string}/*`
    ? [string]
    : [];

type RouteUrls = {
  readonly [K in ApiRouteName]: PathArgs<(typeof API_PATHS)[K]> extends []
    ? (typeof API_PATHS)[K]
    : (...args: PathArgs<(typeof API_PATHS)[K]>) => string;
};

const urls = Object.fromEntries(
  Object.entries(API_PATHS).map(([name, path]) => [
    name,
    /[:*]/.test(path)
      ? (...args: string[]) =>
          path.replace(/:\w+|\*/g, (param) =>
            (param === "*" ? encodeVaultPath : encodeURIComponent)(args.shift() as string),
          )
      : path,
  ]),
) as RouteUrls;

/**
 * Every route's URL (relative to the daemon's base URL): a static route is its path, a pattern a
 * builder taking its parameters in order (percent-encoded; a note path keeps its `/`). `daily`,
 * `search` and `tasks` add their query.
 */
export const API_ROUTES = {
  ...urls,
  /** `create` (the default) makes the note from its template when it doesn't exist. */
  daily: (date: string, create = true) => `${urls.daily(date)}${create ? "?create=1" : ""}`,
  search: (q: string) => `${urls.search}?q=${encodeURIComponent(q)}`,
  tasks: (notePath: string) => `${urls.tasks}?notePath=${encodeURIComponent(notePath)}`,
};

/** Encodes each path segment but keeps `/` separators readable. */
export function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function decodeVaultPath(encoded: string): string {
  return encoded.split("/").map(decodeURIComponent).join("/");
}

/** Lists in import reports hold at most this many entries (their `count` is the full number). */
export const IMPORT_REPORT_LIMIT = 200;
