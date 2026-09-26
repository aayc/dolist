# Spec: the agent anywhere — always-on machine, placement per device, pairing, relay, Settings

Status: built (`7ce1e9f`, `bbe8aff`); verifying it on the real VM is pending.

Repo: Daily Do List. Read `AGENTS.md` first (invariants, conventions, testing rules, the macOS
section for Swift work), then `docs/ALWAYS_ON.md` (the design; binding), `docs/SYNC.md` (sync,
the agent lease) and `SECURITY.md`.

## Decided with the user

- The agent can run on an always-on Linux VM (Azure) **or** on a device itself, **chosen per
  device** and changeable at any time: e.g. personal laptop → always-on machine, work laptop →
  this device, web app and (future) iPhone → always-on machine.
- Everything the agent needs to move is stored and synced (it already is: notes, routine files,
  threads, artifacts, records, approvals, routines state, settings). Per-machine things
  (connectors, API keys, browser logins, harness login, macOS permissions) stay per machine, and
  Settings shows each machine's **readiness**.
- Network: **Tailscale**. The VM has no public ports; the daemon keeps binding `127.0.0.1` and
  `tailscale serve` forwards HTTPS to it. The daemon knows nothing about Tailscale.
- **No Azure management** (no power control, no Azure credentials). The user manages the VM in
  the portal.
- Scope: remote access and pairing, placement with lease priorities, the VM setup kit, the relay
  (this device's app shows and approves the always-on agent's work), and **Settings on web and
  Mac for all of it**.

## Placement semantics (see docs/ALWAYS_ON.md "Where the agent runs")

`AgentPlacement` is a **device-local** setting (`$DDL_HOME/config.json`, env override
`DDL_AGENT_PLACEMENT`):

- `this_device`: run the agent here; requests the agent lease with priority `interactive`, which
  outranks `host`.
- `always_on_machine`: never request the lease; relay agent routes and events to the always-on
  machine (when paired), else show the synced sidecar read-only.
- `always_on_host`: this is the always-on machine; requests the lease with priority `host`.
- Default: `this_device` (today's behavior). A daemon without sync is standalone and always runs
  its own agent regardless of placement (placement only matters with sync).
- **Held here:** without an always-on machine set up (`AppSettings.remote.alwaysOnMachine` is
  null), or without sync on this device, the effective placement is `this_device` whatever is
  stored, and `placement.heldHere` says why (`"no_machine"`, `"no_sync"`). The stored choice is
  kept and applies again once the machine and sync are set up.
- **The toggle (user request):** "where the orchestrator runs" — *This device* or *Always-on
  machine* — is one tap away, not buried in Settings: in the agent panel's header (web and Mac)
  and in Settings → Agent location. While held here it is disabled, with a tooltip saying why and
  a link to set up the always-on machine. Switching shows the handover as it happens
  (`placement.note`), and "Run it on this device instead" is offered when the machine can't be
  reached.

Handover: an `interactive` request against a `host` holder records a pending takeover on the sync
service; the holder's next renewal returns `yieldRequested: true`; it stops its runtime (flushing
state), runs a sync pass and releases; the requester (polling every ~3 s while pending) gets it and
starts from the synced state. While a takeover is pending, only the pending requester (or an equal
or higher priority) may take a released lease for a grace period (30 s). Equal priorities: first
come, first served (today's rule). A pending takeover expires if its requester stops asking (60 s).
In-flight runs stop at handover; their threads can be retried.

## Wire contract (exact; `packages/core/src/protocol.ts` unless noted)

```ts
// ── Placement, readiness ─────────────────────────────────────────────
export type AgentPlacement = "this_device" | "always_on_machine" | "always_on_host";

export interface AgentRunsOn {
  deviceId: string;
  name: string;
  thisDevice: boolean;
  /** The holder requested the lease with priority "host". */
  alwaysOnMachine: boolean;
}

export type RelayState = "off" | "connecting" | "connected" | "unreachable" | "not_paired";

export interface AgentPlacementStatus {
  /** The stored choice (see heldHere for when it can't apply). */
  placement: AgentPlacement;
  /** Why the agent is held on this device despite the stored choice. */
  heldHere?: "no_machine" | "no_sync";
  /** Who runs the agent now (null: nobody, or unknown without sync). */
  runsOn: AgentRunsOn | null;
  relay: RelayState;
  /** Short, human ("Taking over from vm-1…", "Handing the agent to vm-1…"). */
  note?: string;
}

export interface AgentReadiness {
  harness: { kind: AgentHarness; ready: boolean; problem?: string };
  /** A model credential for the configured harness is present (never the value). */
  modelCredential: boolean;
  browser: boolean;
  computer: "available" | "needs_permissions" | "unsupported";
  connectors: { configured: number; connected: number };
}

// AgentStatusResponse gains (optional, additive):
//   placement?: AgentPlacementStatus;
//   readiness?: AgentReadiness;   // this daemon's own readiness
// The existing `agent.status` server event carries them.

// ── This daemon's device-local settings ──────────────────────────────
export interface DeviceSyncSetup {
  /** null: not syncing with the sync service. */
  url: string | null;
  vault: string | null;
  /** A vault token is saved (the token is never returned). */
  hasToken: boolean;
}

export interface DeviceSettingsResponse {
  device: { id: string; name: string };
  placement: AgentPlacement;
  /** Names this daemon answers to besides loopback (e.g. its tailnet name), lowercase. */
  remoteHosts: string[];
  sync: DeviceSyncSetup;
  /** Fields set by environment variables; the UI shows them read-only. */
  lockedByEnv: Array<"placement" | "remoteHosts" | "sync">;
}

export interface DeviceSettingsPatch {
  name?: string;              // 1–64 chars, trimmed
  placement?: AgentPlacement;
  remoteHosts?: string[];     // DNS names (optional :port), ≤ 8, no IPs, no scheme/path
}

export interface DeviceSyncSetupRequest {
  url: string;                // https (http only for loopback)
  vault: string;              // sync vault id
  /** Omit to keep the saved token. Written 0600 to $DDL_HOME/sync-token. */
  token?: string;
}

// ── Pairing (this daemon issuing device credentials) ─────────────────
export type PairedDeviceKind = "browser" | "app" | "daemon";

export interface PairedDevice {
  id: string;
  name: string;
  kind: PairedDeviceKind;
  createdAt: number;
  lastSeenAt: number | null;
  /** The device making this request. */
  current?: boolean;
}

export interface PairingCodeRequest { name?: string }
export interface PairingCodeResponse {
  /** 8 characters, unambiguous alphabet, shown as XXXX-XXXX; single use. */
  code: string;
  expiresAt: number;
  /** https://<first remote host> for the QR code, or null without remote hosts. */
  url: string | null;
}
export interface PairRequest { code: string; name: string; kind: PairedDeviceKind }
export interface PairResponse {
  device: PairedDevice;
  /** For "app" and "daemon" kinds; a browser gets an HttpOnly cookie instead. */
  token?: string;
}
export interface PairedDevicesResponse { devices: PairedDevice[] }

// ── The always-on machine, from this device's side ───────────────────
// packages/core/src/settings.ts: AppSettings gains (synced, non-secret):
//   remote: { alwaysOnMachine: AlwaysOnMachine | null }   default { alwaysOnMachine: null }
export interface AlwaysOnMachine { name: string; url: string }

export interface MachineStatusResponse {
  machine: AlwaysOnMachine | null;
  /** This device holds a credential for it ($DDL_HOME/machine-token). */
  paired: boolean;
  /** null: not checked yet, or no machine. */
  reachable: boolean | null;
  checkedAt: number | null;
  version?: string;
  /** As the machine reports it. */
  agent?: { runsOn: AgentRunsOn | null; problem?: string };
  readiness?: AgentReadiness;
  error?: string;
}
export interface MachinePairRequest {
  url: string;               // https://<tailnet name>[:port], no path/query/credentials
  code: string;
  /** Default: the first label of the host. */
  name?: string;
}
```

Routes (add to `API` and to the contract with schemas, fixtures, arbitraries, docs):

| Route | Method | Auth | Body → Response |
| --- | --- | --- | --- |
| `/api/device` | GET | bearer | → DeviceSettingsResponse |
| `/api/device` | PATCH | bearer | DeviceSettingsPatch → DeviceSettingsResponse (400 invalid, 409 locked by env) |
| `/api/device/sync` | PUT | bearer | DeviceSyncSetupRequest → DeviceSettingsResponse |
| `/api/device/sync` | DELETE | bearer | → DeviceSettingsResponse (sync off; token file removed) |
| `/api/pairing-codes` | POST | bearer | PairingCodeRequest → 201 PairingCodeResponse (429 too many outstanding) |
| `/api/pair` | POST | **pairing_code** (no bearer; the code is the credential) | PairRequest → 201 PairResponse (400, 401 bad/expired code, 429 rate-limited) |
| `/api/devices` | GET | bearer | → PairedDevicesResponse |
| `/api/devices/:id` | DELETE | bearer | → 204 (404 unknown); closes that device's sockets |
| `/api/machine` | GET | bearer | → MachineStatusResponse |
| `/api/machine/pair` | POST | bearer | MachinePairRequest → MachineStatusResponse (400, 401 code rejected by the machine, 502 unreachable) |
| `/api/machine/check` | POST | bearer | → MachineStatusResponse |
| `/api/machine/pairing` | DELETE | bearer | → MachineStatusResponse (credential dropped; revoked on the machine best-effort) |

"bearer" means: the master token **or** a device token (Authorization header), or, for a remote
browser, the device cookie with an allowed same-origin `Origin`. The contract's route `auth` union
gains `"pairing_code"`.

Sync service (`packages/core/src/sync-service.ts`, `apps/sync`):

```ts
export type SyncLeasePriority = "host" | "interactive";
// SyncLeaseRequest gains:  priority?: SyncLeasePriority   (absent = "interactive")
// SyncLeaseHolder gains:   priority: SyncLeasePriority;  yieldRequested?: boolean
//                          epoch: number   (fencing: +1 on every new grant, same on renewal)
// SyncLeaseConflictBody gains: takeoverPending?: boolean  (this request outranks the holder)

/** Agent-owned sidecar paths: only the current agent lease holder may write them. */
export const AGENT_OWNED_PREFIXES = [
  ".daily-do-list/threads/",
  ".daily-do-list/artifacts/",
  ".daily-do-list/state/",
] as const;
export const LEASE_EPOCH_HEADER = "X-DDL-Lease-Epoch";
// SyncErrorCode gains "stale_lease" (409): a write, delete or rename touching an agent-owned path
// without the current agent grant's epoch from this device (X-DDL-Device + epoch header). The
// body carries `currentEpoch` (number | null) and `holder`.
```

**Fencing (user decision, 2026-09-25):** the sync service enforces the rule above on every write,
delete and rename that touches an agent-owned path (settings.json is not agent-owned: any device may
change settings). The daemon's sync engine sends the header for agent-owned paths while it holds
the lease; on `stale_lease` it drops its local changes to those paths in favor of the server's
(they were written under a former grant) and logs a warning, never a conflict copy. A former
holder can therefore never overwrite the current holder's agent state. All devices must run a
daemon with fencing (document it in the upgrade notes).

Swift: `DailyDoListModels` mirrors all of the above and decodes the new fixtures; unknown enum
values decode leniently (follow the existing `WireEnum` pattern). Keep everything additive so
older clients still decode.

### As built by S0 (binding for S1–S5)

- Core: types and `API_ROUTES` in `packages/core/src/protocol.ts`; `AlwaysOnMachine` and
  `RemoteSettings` (`AppSettings.remote`) in `settings.ts`; lease priority, `epoch`,
  `AGENT_OWNED_PREFIXES`, `LEASE_EPOCH_HEADER` and `stale_lease` in `sync-service.ts`; shared pure
  validators (remote hosts, machine and sync URLs, device names, pairing codes) in
  `packages/core/src/remote.ts` — use them, don't re-implement.
- Contract: schemas in `packages/contract/src/wire/remote.ts` (machine and settings in
  `wire/settings.ts` and `persisted/settings.ts`); the `pairing_code` auth kind; an empty (204)
  response kind. Swift: `DailyDoListModels/Remote.swift`.
- Route names: `device`, `deviceSync`, `pairingCodes`, `pair`, `devices`, `pairedDevice`, `machine`,
  `machinePair`, `machineCheck`, `machinePairing`.
- Error codes: `pairing_rejected` (401: a bad or expired code, distinct from `unauthorized`),
  `locked_by_env` (409, also on `PUT`/`DELETE /api/device/sync`), `rate_limited` (429, also on
  `POST /api/machine/pair`), `machine_unreachable` (502); 400 for a malformed id on
  `DELETE /api/devices/:id`.
- `AgentReadiness.harness.kind` is `AgentHarnessKind`. `alwaysOnMachine.url` in settings is stored
  normalized (lowercase, no trailing slash); `MachinePairRequest` accepts any valid form.
- The new routes aren't served yet: `apps/daemon/src/contract.test.ts` has a `NOT_SERVED_YET` list
  (each entry checked to answer 404). Whoever implements a route replaces its entry with real
  conformance scenarios covering every declared status.
- The sync service already stores and reports the holder's `priority` and `epoch` (schema
  upgraded in place); takeover, yielding and the stale-lease rule are S2's.
- The Mac client's `RESTTransport` treats every 401 as "token rejected"; `/api/pair` and
  `/api/machine/pair` must check for `pairing_rejected` (S5).

## Security requirements

- Remote hosts are configured, never inferred. Each adds an allowed Host, the `https://` Origin
  and `wss://` in the page's `connect-src`.
- `index.html` embeds the master token **only** for loopback Hosts. For a remote Host it embeds
  `<meta name="ddl-auth" content="cookie">` when the request carries a valid device cookie, else
  `<meta name="ddl-auth" content="pairing">` (the web app then shows its pairing screen). Never a
  token.
- Device tokens: 256-bit random, stored as SHA-256 hashes in `$DDL_HOME/devices.json` (0600),
  compared in constant time; `lastSeenAt` updated at most once a minute; revocation closes that
  device's WebSockets immediately.
- Browser cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`, accepted only with an Origin equal
  to the request's own allowed origin; never on loopback Hosts (local browsers keep the embedded
  token).
- WebSocket auth for native and daemon clients by `Authorization` header; `?token=` stays accepted
  **only** on loopback Hosts (back compat), refused on remote Hosts.
- Pairing codes: single use, 5-minute TTL, ≤ 3 outstanding, 8 characters from an unambiguous
  alphabet; `/api/pair` accepts only small JSON bodies and is rate-limited globally (all remote
  traffic arrives from the local proxy): e.g. 5 attempts a minute; after 10 failures every
  outstanding code is invalidated.
- Secrets live `0600` in `DDL_HOME` (`devices.json`, `machine-token`, `sync-token`,
  `daemon-token`), never in `settings.json` (synced), never in API responses or logs. Agents must
  not read or write them: extend the safety rules' hard denies if reads of these files aren't
  already denied (with eval cases).
- The daemon's outbound calls to the machine: https only (http only to loopback, for tests),
  5 s timeouts, token in the Authorization header, never logged.
- `AGENTS.md` invariant 6 and `SECURITY.md` describe the new rule: local-only unless remote hosts
  are configured, then only through a private network with device credentials.

## Streams (each on its own branch and worktree; the lead merges)

- **S0 contract** — everything in "Wire contract": core types and `API` routes, `AppSettings.remote`
  (+ `DEFAULT_SETTINGS`, deep-merge, the daemon's zod settings schema), the contract (schemas,
  routes incl. the `pairing_code` auth kind, fixtures, arbitraries, lockstep tests,
  `docs/PROTOCOL.md` via its generator), the sync-service types, `DailyDoListModels` (+ fixture
  decoding tests), and the web's event guards if the `agent.status` shape check needs it. Daemon
  handlers: stub the new routes minimally only if the lockstep tests require every route to exist
  (answer 501 `not_implemented` with a TODO-free comment that S1/S2 implement them), or leave them
  unregistered if the tests allow. No behavior beyond types.
- **S1 remote access and pairing** (daemon): remote hosts (config `remote.hosts`, env
  `DDL_REMOTE_HOSTS`, a live `RemoteHostRegistry` the security policy reads, CSP), device token
  store, pairing codes, `/api/pairing-codes`, `/api/pair`, `/api/devices`, cookie auth, WebSocket
  header auth and the `?token=` rule, `index.html` behavior per Host, a `pair` CLI subcommand for
  the headless VM (reads `daemon-token`, calls the local daemon, prints code, expiry and URL),
  hard-deny rules for the secret files, `SECURITY.md`, invariant 6 in `AGENTS.md`, and a full
  security test matrix (Host × Origin × credential × route).
- **S2 placement, lease and machine link** (daemon + sync service): device-local settings
  (`/api/device`, persisted to `config.json`, `lockedByEnv`), the sync setup API (writes
  `config.json` sync + `sync-token` 0600 and applies live; if a restart is truly unavoidable,
  say so in the response and document it), lease priorities and takeover in `apps/sync` and the
  daemon's lease client, live placement changes (switching away releases the lease cleanly),
  the effective placement and `heldHere` ("no_machine", "no_sync"), **fencing** (lease epochs,
  the `stale_lease` rule in `apps/sync`, the epoch header and the drop-on-stale behavior in the
  sync engine and `RemoteStorageProvider`, with a two-device test where a former holder
  reconnects with unsynced agent writes),
  readiness, `placement`/`readiness` in agent status, `AppSettings.remote` handling, the machine
  link (`/api/machine*`, `$DDL_HOME/machine-token`, periodic status checks only while a client
  watches or on demand), docs in `docs/SYNC.md` (priorities) and `apps/daemon/README.md`.
  `remoteHosts` in `/api/device` calls the S1 registry through a small interface
  (`{ list(): string[]; set(hosts: string[]): void }`) passed in the daemon context; if S1's
  class isn't on your branch, implement the interface minimally where S1 will replace it.
- **S3 relay** (daemon): when placement is `always_on_machine` and the machine is paired, forward
  agent routes (threads, messages, orchestrator, approvals, artifacts, task records, routines when
  present, agent status merged with this device's placement) and agent WebSocket events/frames to
  the machine over one authenticated connection; `relay` state in agent status; when unreachable
  or not paired, and on any non-holder device, serve threads and approvals **read-only** from the
  synced sidecar (mutations → 503 `agent_unavailable` with a clear problem). Code against small
  interfaces for placement and the machine credential (`{ url, token } | null`) if S2 isn't on
  your branch. Tests: two daemons and a sync server in process.
- **S4 web** (apps/web): the orchestrator location toggle in the agent panel header (see "The
  toggle" above); Settings sections per docs/ALWAYS_ON.md "Settings" (Agent location,
  Always-on machine, Sync, Devices with pairing code + QR code, Remote access), agent status UI for
  placement/relay/readiness (where it runs, handover notes, read-only banner), and the **pairing
  screen** for remote browsers (`<meta name="ddl-auth" content="pairing">` → enter a code →
  cookie → reload; `content="cookie"` → use cookie auth, no Authorization header). Follow the web
  control rules (data-tooltip, data-command, polish audit), unit tests, Playwright e2e with the
  real keyboard, bundle budget.
- **S5 Mac** (apps/macos): the orchestrator location toggle in the agent panel header, the same
  Settings panes natively, agent status presentation for
  placement/relay/readiness, client methods (`HTTPDaemonClient`) for the
  new routes, WebSocket auth by header when the endpoint isn't loopback (keep `?token=` for
  loopback), tests with fakes, tooltip/command rules, docs.
- **S6 VM setup kit** (deploy + CI): a Linux bundle (daemon + web dist + sync service, `pnpm
  deploy --prod --legacy` style, tarball), `deploy/linux/` (systemd units for the daemon and the
  sync service, an idempotent `setup.sh`, `tailscale serve` configuration, Chromium for the
  browser, config with `always_on_host` placement and the tailnet name as remote host),
  `deploy/azure/README.md` (VM size, Ubuntu LTS, no public IP, deny-all inbound, encryption at
  host, cloud-init taking a Tailscale auth key from a local file never committed, Cursor CLI
  install and login, `mcp.json` and `.env` on the VM, pairing the laptop), shellcheck-clean
  scripts, and a CI job on ubuntu that builds the bundle and smoke-tests it (start the daemon in
  mock mode with a remote host configured, `/api/health`, the sync service up). Add pairing to the
  smoke test once S1 is on your base, otherwise leave a clearly marked follow-up for the lead.

## Environment rules (strict, every stream)

- Work only in your worktree; run every command there and edit files by absolute paths inside it.
  Run `pnpm install --frozen-lockfile --prefer-offline` there first.
- The user's app and daemon are running (127.0.0.1:7331) and a web dev server is on 127.0.0.1:5173.
  Never kill them or bind those ports; never kill DailyDoList processes by name; never run
  `apps/macos/scripts/run-app.sh`; never write to /Applications, `~/.daily-do-list/` or
  `~/DailyDoList/`. Tests use temp dirs and their own ports; never the network or the real model.
- PUBLIC repo: no secrets, tokens, tailnet names, IPs, usernames or absolute paths containing a
  username; examples use placeholders (`vm-name.tailnet-name.ts.net`, `<code>`).
- The machine is often loaded: rerun a timing-sensitive failure alone before concluding it's
  broken; never loosen assertions or budgets.
- Commit each logical piece as soon as it works (conventional commits; hooks run, never bypass
  them). Don't push, merge, rebase or touch other branches or worktrees. If interrupted and
  resumed, run `git status` and `git log --oneline -5` first.
