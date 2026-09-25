# Architecture

Daily Do List is a TypeScript monorepo with one UI codebase, one local server, and a handful of
framework-free packages behind explicit interfaces.

```
apps/web ──REST + WebSocket──▶ apps/daemon ──▶ @ddl/storage (vault)      ◀──▶ SyncEngine ──▶ sync target
   │                               │
   └── @ddl/editor                 └──▶ @ddl/agent (AgentRuntime) ──▶ @ddl/connectors (MCP)
          │                                    │
          └────────── @ddl/core (pure domain logic + wire protocol) ◀──────┘
```

## Packages

| Package | Role | Runs in |
| --- | --- | --- |
| `@ddl/core` | Vault paths, Obsidian-compatible dates & daily notes, markdown task parsing, task identity tracking, agent/thread types, the daemon↔client protocol, settings. **No dependencies.** | Browser, daemon, future native shells |
| `@ddl/storage` | `StorageProvider` contract; local filesystem, memory, remote (the sync service) and (stub) S3 providers; provider registry; 3-way `SyncEngine`; vault search | Daemon |
| `@ddl/editor` | CodeMirror 6 editor: live preview, task checkboxes, agent badges, vim, keymaps | Browser |
| `@ddl/agent` | `AgentRuntime`: task watcher, orchestrator, subagents, Pi harness, safety evaluator, approvals, execution providers, threads/artifacts, tools, OpenRouter client | Daemon |
| `@ddl/connectors` | MCP client: `mcpServers` config → harness-agnostic `ToolSpec`s | Daemon |
| `apps/daemon` | Hono HTTP API + WebSocket hub, auth, config, settings, static UI; composes everything | Node 24 |
| `apps/sync` | Sync service: per-vault change log in SQLite, HTTP API with conditional writes, live WebSocket push, the agent lease ([SYNC.md](SYNC.md)) | Node 24 (self-hosted) |
| `apps/web` | React 19 UI; `DaemonClient` with HTTP and in-browser mock implementations | Browser / WebView |
| `evals` | Agent eval suites (safety verdicts, triage) with mock (CI) and live modes | Node |

Internal packages export TypeScript source directly (no per-package build). The daemon is bundled
with esbuild (`apps/daemon/build.mjs`), the UI with Vite. Third-party versions shared between
packages and the daemon bundle are pinned once in the pnpm catalog (`pnpm-workspace.yaml`).

## The vault

- A vault is a folder of plain markdown files — Obsidian-compatible. The daemon owns it through a
  `StorageProvider` (`packages/storage/src/types.ts`): list/read/write/delete/rename, optimistic
  concurrency via content versions (`ifMatch`), and a `watch()` stream that distinguishes the
  provider's own writes (`self: true`) from external edits (e.g. Obsidian, git, sync).
- Agent data lives in the hidden sidecar `.daily-do-list/` inside the vault: `threads/`,
  `artifacts/`, `state/` (task identities, task records, approvals) and `settings.json`. Because it
  goes through the same provider, it syncs with the notes.
- Deletes through the API are soft: files move to the vault's `.trash/` folder.
- Local provider details: atomic writes (temp file + rename), per-path locks, symlink-escape
  protection, recursive `fs.watch` with debounce and self-write suppression, version caching.

### Storage and sync providers

`createStorageProvider(config)` is the only place a backend is chosen (`local`, `memory`, `s3`).
`SyncEngine` replicates the vault to any other provider (`createSyncTarget`: a local folder such as
iCloud Drive, or the sync service shared by several devices, S3 next) using a persisted base
snapshot and a line-based 3-way merge; true conflicts keep your version and save theirs as a
`(conflict …)` copy. It runs a pass after vault changes, after changes the target reports from
elsewhere (the sync service pushes them live), and every 30 s. A mass-deletion guard refuses to
mirror an empty side (unmounted drive) into deletions. Devices, the sync service and the agent
lease (one device runs the agent): [SYNC.md](SYNC.md).

## The daemon

`apps/daemon` binds to `127.0.0.1` (default port 7331) and serves:

- **REST** under `/api/*`, exactly the routes and shapes in `packages/core/src/protocol.ts`
  (`API_ROUTES` documents methods and bodies).
- **WebSocket** at `/ws`: server-push `ServerEvent`s (vault changes tagged with their origin, task
  records, thread messages and streaming deltas, approvals, agent status, live surface frames) and
  light `ClientEvent`s (hello, editor presence, surface subscriptions, read receipts).
- **The built UI** (production), with the auth token injected into `index.html`.

Security: bearer token (`$DDL_HOME/daemon-token`, 0600) checked in constant time on every API and
WebSocket request, `Host` allowlist (DNS-rebinding defense), `Origin` allowlist (CSRF defense), no
CORS, zod validation, body limits, sandboxed artifact responses. The Vite dev proxy injects the
token only for requests that originate from the dev UI itself. Other devices reach the daemon only
through a private-network proxy under a configured remote host, with a paired device's token (or a
paired browser's HttpOnly cookie); see [SECURITY.md](../SECURITY.md#threat-model-summary) and
[apps/daemon/README.md](../apps/daemon/README.md#remote-access-and-pairing).

Change attribution: writes made through the API carry the tab's client id; writes by the agent go
through an `AttributedStorage` view. The WebSocket hub tags each `vault.changed` as `client`,
`agent` or `external`, so clients ignore their own echoes but see everything else live.

## The UI

- One `MarkdownEditor` instance; each open note keeps its own `EditorState` (instant tab switches
  with per-note undo history). Autosave is debounced (~300 ms) with one write in flight per note;
  409 conflicts keep local edits and save the other version as a copy.
- Agent badges: task records from the daemon are re-resolved against the local document with the
  same identity algorithm the daemon uses (`resolveTaskAnchors`), then mapped through CodeMirror
  transactions so they stay attached while you type.
- Calm by default: a daily note's title is its date ("Thursday, September 24", with the year only
  when it isn't the current one; tabs and the explorer keep the file name). The status bar shows
  nothing while things are fine: no "Saved", no "Connected" (the in-browser demo gets a "Demo"
  marker), and the approval policy only while it isn't the default ("Runs everything" in the
  warning color). Only badges that need the user are loud, and motion is CSS-only, paint-only and off
  under `prefers-reduced-motion` (see `packages/editor/README.md`).
- Tooltips: one delegated layer (`src/lib/tooltips.ts`, one element, document listeners) shows
  what an element declares with `data-tooltip`, React components and editor widgets alike, with
  the macOS app's timing (500 ms delay, a 300 ms warm window in which the next tooltip glides
  over). Shortcuts are never written into text: `data-command` names the command, and the tooltip,
  `aria-keyshortcuts` and the palette show its registry hotkey as one keycap per key (`hotkeyKeys`;
  `KEYS` for Enter/Escape-style keys). In a regular browser tab, shortcuts the browser keeps (⌘N,
  ⌘T, ⌘W) aren't offered. Everything clickable points, disabled controls don't, chrome text isn't
  selectable, and `e2e/polish.spec.ts` audits both on every main screen.
- Secondary UI (thread panel, artifact viewer, palette, settings, search) is code-split and
  prefetched on idle; vim mode is loaded on demand.
- The agent panel's inbox pins the orchestrator's own chat above the task threads
  (`OrchestratorInboxRow`); it opens in the panel as `OrchestratorView`, which composes the thread's
  `MessageRow`s and `Composer` with a header of its own (status, Stop) and a link under each
  decision to its task's thread, and from the palette ("Open the orchestrator's chat",
  `agent:orchestrator`).
- `DaemonClient` has two implementations: `HttpDaemonClient` (real) and `MockDaemonClient`
  (in-browser vault + simulated agent, used by e2e/perf tests and demos via `?mock=1`).

## The agent runtime

See [AGENT_SYSTEM.md](AGENT_SYSTEM.md). In one line: storage events → TaskWatcher (parse, track
identity, settle) → Orchestrator agent (one session per day) → SubagentManager (one harness session
per task) → every tool call through the SafetyGate → ExecutionProvider / MCP connectors, with
threads and artifacts persisted in the sidecar.

## Providers at a glance

| Concern | Interface | Implementations | Registry |
| --- | --- | --- | --- |
| Vault storage | `StorageProvider` | local fs, memory, S3 (stub) | `createStorageProvider` |
| Sync target | `StorageProvider` + `SyncEngine` | none, local folder, sync service (remote), S3 (stub) | `createSyncTarget` |
| Agent harness | `Harness` / `HarnessSession` | Pi, scripted (mock/tests) | runtime options |
| Execution | `ExecutionProvider` | local (shell, Chrome, macOS desktop), cloud (stub) | `createExecutionProvider` |
| Tools from services | `ConnectorToolSource` | MCP (stdio, streamable HTTP, SSE) | `createConnectorManager` |
| One-shot LLM calls | `LlmClient` | OpenRouter, mock | runtime options |
