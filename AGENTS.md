# AGENTS.md — working in the Daily Do List repo

This file is the operating manual for AI coding agents (and humans) working in this repository.
Read it fully before changing code. It is kept up to date; if you change a convention, update it here.

## What this project is

**Daily Do List** is a local-first, Obsidian-style markdown notes app whose daily note is a to-do
list that an always-on AI orchestrator watches. As the user writes tasks, the orchestrator triages
them and dispatches subagents that actually **do** the work (research, browse, fill forms, draft
emails…), reporting back as comments on the task. Anything risky (spending money, booking, sending
messages, deleting data) is paused by an independent safety evaluator until the user approves it.
It is "do list", not "to-do list", because the system does the tasks.

Product principles, in priority order:

1. **Safety before autonomy.** Every tool call from every agent passes the safety gate. Risky
   actions need explicit approval unless the user chooses a policy that runs them; hard denies
   always apply. Fail closed.
2. **Responsiveness is a feature.** The editor must feel instant. Performance budgets are enforced
   in CI (see `docs/PERFORMANCE.md`). Never put network or O(document) work on the keystroke path.
3. **Local-first, plain files.** Notes are plain markdown in a folder (Obsidian-compatible vault).
   Agent state lives in the vault's hidden sidecar folder `.daily-do-list/`.
4. **Providers everywhere.** Storage, sync, execution, agent harness and connectors
   sit behind interfaces with a registry, so backends can be swapped without touching callers.
5. **Cross-platform by construction.** Every client talks to the daemon through one wire protocol:
   the web UI, the native macOS app (`apps/macos`, Swift), and later iOS, which will reuse the
   macOS app's Models/Client/Domain packages (see `docs/CROSS_PLATFORM.md`).

## ⚠️ This repository is PUBLIC

- Never commit secrets, tokens, `.env` files, personal notes, vault content, agent state, browser
  profiles, shell history, or absolute paths containing a username. `scripts/check-secrets.mjs`
  runs as a pre-commit hook (staged files), a pre-push hook (every commit being pushed) and in CI,
  plus gitleaks (in CI and both hooks; the pre-push hook refuses to run without it). Do not bypass
  them.
- API keys live in `~/.daily-do-list/.env` (outside the repo) or the process environment. Code must
  read them from `process.env` at runtime and must never log them.
- Test fixtures and examples must be synthetic (no real names, emails, addresses or notes).
- Before committing, run `git status` and review every staged file.

## Handoff log: `PROGRESS.md`

Work moves between machines and agents, so `PROGRESS.md` (repo root) always holds the current
state: what shipped, what's in flight (branch, spec, status, next step), what's next, and the
user's decisions.

- **Read it before starting.** Don't re-ask a question its decisions already answer.
- **Keep it current.** Update it whenever work starts, lands, stalls or changes direction, or the
  user decides something. Commit it on `main` and push, so another machine can pick up at any
  moment.
- **In-flight work lives on pushed branches.** Push a stream's branch whenever `PROGRESS.md`
  mentions it. Specs for work split across streams go in `docs/specs/`, not in temp files.
- **Only the integrator edits it.** Parallel streams on feature branches report back instead of
  editing it, so it never conflicts; the lead records their state.
- **It's public too.** No secrets, tokens, machine or network names, IP addresses or absolute
  paths; describe machines generically ("the main development Mac").

## Repository map

```
apps/
  web/            React 19 + Vite UI (the browser client)
  daemon/         Node 24 local server: REST + WebSocket API, vault owner, runs the agent runtime
  sync/           Sync service: per-vault change log (SQLite) + HTTP API + live push; agent lease
  macos/          Native macOS app (SwiftUI/AppKit): app shell + Swift packages; supervises the daemon
                  and bundles ddl-computer, the helper the daemon spawns to operate other apps;
                  DailyDoListDrawing is its native Excalidraw drawing engine
  mobile/         (planned) native iOS app reusing the Swift packages — plan in PLAN.md
packages/
  core/           Pure, isomorphic domain logic, enums and constants (no runtime dependencies!);
                  re-exports the wire types type-only
  contract/       zod schemas for the wire protocol (the source of its TypeScript types) and the
                  sidecar file formats; fixtures, test generators; generates docs/PROTOCOL.md
  storage/        StorageProvider interface; local-fs, memory, remote (sync service); SyncEngine;
                  search
  editor/         CodeMirror 6 markdown editor: live preview, tasks, vim, agent badges
  agent/          Agent runtime: watcher, orchestrator, subagents, harnesses (Pi │ Cursor CLI),
                  safety, approvals, execution providers (local; computer use with app
                  control through the ddl-computer helper), threads/artifacts, tools, LLM client
  connectors/     MCP client: mcpServers config → ToolSpecs (stdio / streamable HTTP / SSE)
evals/            Agent evals (safety verdicts, triage, latency); mock mode runs in CI
deploy/           The always-on machine: linux/ (bundle, systemd units, setup.sh), azure/ (VM guide)
scripts/          Repo tooling (secret scan, bench/bundle budgets, git hooks)
docs/             Architecture, agent system, protocol and data formats, performance, CI, sync, the
                  always-on design, cross-platform plan, user journeys; specs/ for multi-stream work
```

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` (Node ≥ 24.4, pnpm 10) |
| Dev (daemon + web, live agent) | `pnpm dev` → http://localhost:5173 |
| Demo: daemon (mock agent) + web on a throwaway demo vault | `pnpm dev:mock` → http://localhost:5174 |
| Lint / format | `pnpm lint` / `pnpm lint:fix` |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test` (or `pnpm --filter @ddl/<pkg> test`) |
| Benchmarks (with budgets) | `pnpm bench` then `pnpm bench:check` |
| E2E / perf e2e | `pnpm e2e` / `pnpm e2e:perf` |
| Vim: regenerate vectors / CI gate | `pnpm vim:vectors` / `pnpm vim:check` (Chromium; see "Vim mode" below) |
| Evals | `pnpm eval:mock` (CI) / `pnpm eval` (real model, needs `OPENROUTER_API_KEY`) |
| Pre-commit essentials | `pnpm check` (lint + typecheck + unit tests + secret scan) |
| Build / bundle budget | `pnpm build && pnpm size:check` |
| Build / run production | `pnpm build && pnpm start` → http://127.0.0.1:7331 |
| Sync server (self-hosted) | `pnpm --filter @ddl/sync build`, then `node apps/sync/dist/main.js vault create --name … --db <file>` and `… serve --db <file>` (see `docs/SYNC.md`) |
| Smoke-test the real model | `pnpm --filter @ddl/agent exec tsx scripts/smoke-pi.ts` (also `smoke-llm.ts`) |
| Smoke-test the Cursor CLI harness | `pnpm --filter @ddl/agent exec tsx scripts/smoke-cursor.ts [--model=…]` (your CLI login, a little usage) |

Scope commands to the package you are working in while iterating. Before you finish, run
`pnpm check`; for UI or agent changes also run the relevant parts of what CI runs:
`pnpm build && pnpm size:check`, `pnpm bench && pnpm bench:check`, `pnpm e2e`, `pnpm e2e:perf`,
`pnpm eval:mock`, and `pnpm vim:check` for editor, keyboard or vim changes (see `docs/CI.md`).

## Architecture in one screen

```
 Editor (web) ──REST/WS──▶ Daemon ──▶ StorageProvider (vault: local fs) ◀──▶ SyncEngine ──▶ sync target (folder │ sync service)
                              │
                              └──▶ AgentRuntime
                                     TaskWatcher  (storage events → parse → track identities → settle)
                                        ▼ TaskEvents
                                     Orchestrator (control plane + orchestrator agent session)
                                        ▼ spawn_subagent
                                     SubagentManager (one harness session per task/thread)
                                        │ harness: Pi (in process) │ Cursor CLI (ACP; our tools over a local MCP bridge)
                                        │ tools: thread / web / notes / browser / computer / bash / MCP
                                        ▼ every tool call
                                     SafetyGate → SafetyEvaluator (policy → rules → LLM judge)
                                        │ require_approval                 │ allowed
                                        ▼                                  ▼
                                     ApprovalBroker ──WS──▶ UI card     journal: "about to run", then the result
                                     ExecutionProvider (local): shell, browser, computer
                                     ThreadStore: journal (state/journal/threads/*.jsonl, the source of truth)
                                                  + snapshots (threads/*.json), artifacts
```

Key flows are documented in `docs/ARCHITECTURE.md` and `docs/AGENT_SYSTEM.md`.

Docs index: `PROGRESS.md` (the handoff log: current state and decisions), `docs/specs/`
(multi-stream specs), `README.md` (product + quick start), `docs/ARCHITECTURE.md`,
`docs/AGENT_SYSTEM.md`, `docs/PROTOCOL.md` (the daemon's wire protocol; its reference is
generated), `docs/DATA_FORMATS.md` (every persisted file and its compatibility rules),
`docs/USER_JOURNEYS.md` (the living-list journeys and their tests),
`docs/PERFORMANCE.md`, `docs/CROSS_PLATFORM.md`, `docs/SYNC.md` (devices sharing a vault, the
agent lease), `docs/ALWAYS_ON.md` (design: the agent on an always-on machine; setting one up:
`deploy/linux/README.md`, `deploy/azure/README.md`), `docs/CI.md`, `SECURITY.md`, `CONTRIBUTING.md`, and package READMEs
(`packages/contract` (schemas, compatibility rules, how to add a route or event),
`packages/storage`, `packages/connectors`, `packages/editor`, `packages/agent/src/safety`,
`packages/agent/src/execution`, `apps/web` (the agent chat, whose pacing and activity wording the
Mac app shares), `apps/daemon`, `apps/sync`, `apps/macos`).

## Invariants (do not break these)

1. **Safety gate is mandatory.** Every tool — built-in, harness built-in (bash/read/write/edit),
   execution, connector (MCP), and whatever a harness's CLI runs itself after asking (the Cursor
   CLI's web search/fetch) — executes only after `beforeToolCall` (the SafetyGate) allows it.
   Never add a code path that executes a tool without it. Risky actions need explicit approval
   unless the user chooses a policy that runs them (`settings.agent.approvalPolicy`, applied only
   in the gate, see `packages/agent/src/safety/README.md`); hard denies always apply, and agents
   can never reach the policy (the sidecar, `$DDL_HOME`, the daemon, the web UI and the app itself
   are hard denies). New tools must declare honest
   `ToolSafetyHints`; hints may only make things *more* restricted. A tool that knows the real
   target better than the model's words (the app's real name, the element's real accessibility
   label) reports it through `subject(input)`: the evaluator adds it to the model's own text (a
   union, never a replacement) and only takes extra risky hits from it, so it can only make a
   verdict stricter. Act on exactly the target the approval described (app control binds element
   ids to their snapshot).
2. **Harness isolation.** Only `packages/agent/src/harness/` may import `@earendil-works/pi-*` or
   know about the Cursor CLI (its ACP protocol, config files, tool kinds): Pi lives in
   `harness/pi/`, the Cursor CLI in `harness/cursor/`, and `harness/registry.ts` picks one from
   `settings.agent.harness`. Everything else uses the `Harness`/`HarnessSession` interfaces and
   `ToolSpec` from `@ddl/core`. To customize Pi beyond its extension API, prefer `pnpm patch` over
   forking. The Cursor harness never lets the CLI run its own tools: they are denied by config,
   its permission requests go through the gate, and a monitor stops sessions that break that.
3. **Provider registries.** Backend selection happens only in registries
   (`createStorageProvider`, `createExecutionProvider`, `createSyncTarget`, …). No
   `if (kind === "remote")` in callers.
4. **`@ddl/core` is pure.** No runtime dependencies, no `node:*` imports, no DOM access (timers,
   `crypto` via `globalThis` are fine). It runs in the browser, the daemon and future native
   shells. Its only reference outside itself is type-only: `src/wire.ts` re-exports the wire types
   inferred from `@ddl/contract`'s schemas, erased at build (nothing of contract or zod ships).
5. **The wire protocol is the zod schemas in `packages/contract/src/wire/`.** Its TypeScript types
   are inferred from them (`src/wire/types.ts`) and imported from `@ddl/core`, by the daemon and
   every client alike; core keeps the enums and constants the schemas use, and the one route
   table (`API_PATHS`, with the URL builders `API_ROUTES`) that `API_CONTRACT` specifies.
   Changing a shape = change its schema (the type follows) and both sides in the same change,
   together with the route in `API_CONTRACT`, the fixtures, `DailyDoListModels` (Swift), and
   `pnpm --filter @ddl/contract generate` for `docs/PROTOCOL.md` (the steps: "How to add a route
   or event" in `packages/contract/README.md`).
6. **The daemon is local-only unless remote hosts are configured, and always authenticated.** It
   binds `127.0.0.1` only. Other devices reach it only through a private-network proxy on the same
   machine (e.g. `tailscale serve`), under a remote host that is configured (`remote.hosts`), never
   inferred, and only with device credentials: a paired device's token, or a paired browser's
   HttpOnly cookie sent by its own page. The master token (`daemon-token`) never leaves the
   machine: a page on a remote Host never embeds it, and `?token=` works on loopback Hosts only.
   Require a credential and reject unexpected `Host`/`Origin` headers. Never add an unauthenticated
   endpoint that reads the vault or triggers agent work (`POST /api/pair` is the one route without
   a credential: its single-use, rate-limited code is one). The same holds for every other listener
   (the Cursor harness's MCP bridge: loopback, per-session random path and token, no `Origin`).
7. **Agents never silently change the user's words.** An agent writes in a note only through
 `edit_note`: every line it writes ends with an agent marker (`%%agent:<thread>%%`) so it is
 visibly the agent's, its own lines go in directly, and changing or deleting the user's lines (or
 checking their boxes) goes through approval unless the user's approval policy runs it (it is
 medium risk: "Ask only for high-risk actions" and "Run everything" run it). Everything else
 agents make lives in the sidecar (threads, artifacts). Clients merge agent edits into unsaved
 typing (`mergeText`). An editor with no unsaved typing never writes, and a merge never brings
 back a line deleted elsewhere unless the user typed it (property-tested on web and Mac; see
 "Saving and merging" in `packages/editor/README.md`).
8. **Keystroke path stays O(line).** No network, no full-document parse, no React re-render per
   keystroke. Persistence is debounced; anchors are mapped through CodeMirror transactions.
9. **Time is local.** Daily notes use the user's local calendar date (`@ddl/core` dates), never UTC.
10. **Deletes are soft.** The daemon moves deleted notes/folders into the vault's `.trash/`.
    `StorageProvider.delete`/`deleteFolder` are the permanent primitives — don't expose them raw.
11. **Line numbers are 0-based** everywhere (tasks, records, search hits, editor `scrollToLine`).
    Show `line + 1` to humans.

## Code conventions

- TypeScript strict, ESM only, `verbatimModuleSyntax` + `erasableSyntaxOnly` (no enums, no
  namespaces, no constructor parameter properties). Target Node 24 / evergreen browsers.
- Internal packages export TypeScript source (`"exports": "./src/index.ts"`); no per-package build.
  The daemon is bundled with esbuild; the web app with Vite.
- File names are kebab-case; React components are PascalCase in `*.tsx`. Named exports only
  (default exports only where a tool requires them, e.g. eval suites, config files).
- Formatting and linting: Biome (`pnpm lint:fix`). 2 spaces, double quotes, semicolons, width 100.
  `pnpm lint` (`scripts/lint.mjs`, also the pre-commit hook on staged files) adds file hygiene,
  swift-format, shellcheck, actionlint and the Swift vectors check.
- Avoid `any`; use `unknown` + narrowing. Validate all external input (HTTP bodies with zod in the
  daemon, LLM JSON output against schemas, MCP payloads).
- Errors: throw typed errors (`ConflictError`, `LlmError`, …). Libraries never `console.log`; take a
  `Logger` (from `@ddl/core`) instead. Never log secrets or full note contents at `info`.
- Comments explain constraints the code cannot show, not what the next line does.
- Keep modules small and single-purpose; prefer pure functions + thin stateful shells.

### Toolchain notes (things that bite)

- **TypeScript 7** is the native compiler. TS ≥ 6 defaults `types` to `[]`: list `node`,
  `vite/client`, … explicitly per tsconfig. `@ddl/core` has no Node types — read env through
  `globalThis` if you must.
- **Vitest 5** removed the standalone `bench()`: write `test("…", async ({ bench }) => { const r =
  await bench("…", fn).run(); expect(r.latency.p99).toBeLessThan(ms * multiplier) })` in
  `*.bench.ts`, scaled by `BENCH_BUDGET_MULTIPLIER`. Test scripts use `--passWithNoTests`.
- **Vite 8 / Rolldown:** vendor chunking uses `build.rolldownOptions.output.codeSplitting`, not
  `manualChunks`. `build.manifest` feeds the bundle-size check.
- **pnpm catalog:** third-party runtime deps used by bundled workspace packages are pinned once in
  `pnpm-workspace.yaml` (`catalog:`) and must also be declared by `apps/daemon` —
  `apps/daemon/build.mjs` fails the build if one is missing.
- **Turbo:** `typecheck`/`test` depend on a `transit` task so a change in `@ddl/core` invalidates
  every dependent's cache. Env vars reach tasks only via `passThroughEnv`/`globalEnv`.
- **Daemon startup:** the daemon bundle is code-split; heavy optional dependencies load on first
 use (the Pi harness from `@ddl/agent/pi`, the Cursor harness from `@ddl/agent/cursor`, Playwright
 via `import()` where Chrome launches, the MCP SDK only when `mcp.json` names servers). Don't
 re-export them from a package index or import them statically elsewhere: `apps/daemon/build.mjs`
 fails the build if `main.js` reaches Pi's packages (`@earendil-works/*`), `playwright-core` or the
 MCP SDK statically. It doesn't check the Cursor harness (our own code), so keep
 `@ddl/agent/cursor` behind `import()` yourself. The one static agent import is
 `@ddl/agent/routines` (routine files, editable while no agent runs here): keep that entry free of
 harness, execution and model code.
- **Drawing renderer:** the daemon's `build` and `dev` scripts build the page agents render
 drawings with (`packages/agent/scripts/build-drawing-renderer.mjs` → `apps/daemon/dist/drawing-renderer`).
 `@excalidraw/excalidraw` is a build-time dependency of `@ddl/agent` for that page only: no Node
 code imports it, and the daemon ships the built page, not the package.
- **Pi harness:** sessions are hermetic (isolated `agentDir` under `$DDL_HOME/pi`, no discovered
  extensions/skills/context files) and refuse to start if the safety-gate extension didn't load.
- **Cursor harness:** set `agent.harness` to `cursor` in Settings (the other settings keep working;
  `agent.cursorModel` picks the model). It needs the Cursor CLI installed (`curl
  https://cursor.com/install -fsS | bash`, found as `agent`/`cursor-agent` on PATH or in
  `~/.local/bin`, or `DDL_CURSOR_CLI=/path/to/agent`) and signed in (`agent login`); no
  `OPENROUTER_API_KEY` needed, though the safety judge and our `web_search` still use one when set.
  It keeps a private CLI config under `$DDL_HOME/cursor/` and never uses yours. Tests must not
  spawn the real CLI: use `src/harness/cursor/testing/fake-cursor-cli.ts` (see `cursor.test.ts`).
- **Computer helper (app control):** on macOS the daemon finds `ddl-computer`
  (`DDL_COMPUTER_HELPER`, `off` to disable; then `<daemon entry dir>/../bin/ddl-computer`, the copy
  the Mac app bundles; then a dev build in `apps/macos/Packages/DailyDoListComputer/.build/`) and
  passes it to the execution provider; without one, computer use stays screen-level. The client
  speaks the helper's JSON-lines RPC (`src/execution/local/app-control/`). Tests must not run the
  real helper, take real screenshots or send real input: use
  `src/execution/local/app-control/testing/fake-computer-helper.ts` (see `client.test.ts`), and the
  daemon's `FakeSystemSettings` for the System Settings route (`createApp` opens nothing by default).
- **Excalidraw (web drawings)** is one lazy chunk: import `@excalidraw/excalidraw` only from
 `apps/web/src/features/drawings/excalidraw-module.ts` (and the components it loads), through
 `loadExcalidraw()`. `apps/web/excalidraw-assets.ts` serves its fonts from the build and replaces
 its optional heavy parts; it's a quarter of Total JS, so check `pnpm size:check` after touching
 it.
- **Ignored folder names:** `.gitignore` ignores every folder named `vault/` (and, with macOS's
 case-insensitive git, `Vault/`) to keep vault content out of the repo: don't name a source folder
 that (the import UI lives in `obsidian-import/` and `ObsidianImport/`).
- **E2E typing:** use Playwright's real keyboard (`page.keyboard.type`). Automation "fill"-style
  typing into CodeMirror rebuilds text from the DOM (including badge widgets) and corrupts notes.
- **E2E daemons:** every functional and perf spec runs against real daemons that
  `packages/agent/scripts/e2e-daemons.ts` starts per test (a temporary `DDL_HOME`, the synthetic
  demo vault, the mock agent or Pi against the fake OpenRouter; `apps/web/e2e/fixtures.ts`). Seed
  state as files or real API calls, not hooks. `DDL_E2E_PORT` moves the harness (default 4173). The
  only daemon test hook is `DDL_TEST_HOOKS=1` (a simulated Mac's computer access,
  `apps/daemon/src/test-hooks.ts`): never set it outside the harness.

## Testing expectations

- Unit tests are colocated (`foo.test.ts`). Every bug fix gets a regression test.
- Benchmarks are `*.bench.ts` using Vitest 5's `bench` fixture and assert p99 budgets.
- UI: Playwright functional e2e (`apps/web/e2e`) and perf e2e with budgets (`docs/PERFORMANCE.md`),
  against real daemons (see "E2E daemons" above).
- Agent behavior: add eval cases (`evals/datasets`) for new safety rules or triage behavior. Mock
  mode must stay deterministic and green in CI; the rules layer must never "allow" a case whose
  expected verdict is `require_approval`/`deny`.
- Tests never hit the network or the real model (use `MockLlmClient` / `ScriptedHarness`), never
  touch the user's real vault, and clean up temp dirs.

### Vim mode

vim.js (`@replit/codemirror-vim`) is the reference implementation of vim behavior. Our job is to
integrate it faithfully, and three checks in `packages/editor/test/vim` pin it (details in its
`README.md`):

- **Vectors are a contract.** `packages/editor/test/vim/vectors.jsonl` is generated, never edited
  by hand. It holds vim behavior as data (document + selection + keys → document, selections,
  mode, registers), and the Swift port (`apps/macos`) replays the same file. `pnpm vim:vectors`
  regenerates it after a vim.js upgrade or a catalog change; review the diff and commit it with
  the change. The format and replay rules in that README are shared with Swift: change them only
  additively and log the change in the README's "Changes" section.
- **Coverage is enforced.** Every `defaultKeymap` entry and ex command of vim.js needs a catalog
  case (`test/vim/catalog`), or an exclusion with a reason.
- **Our editor must match the oracle.** vim.js's own test suite and every vector also run
  against `createMarkdownEditor`. A new difference is a bug to fix. If it's deliberate (a markdown
  behavior wins), add it to `test/vim/upstream/expected-failures.ts` with the reason.

`pnpm vim:check` (CI, e2e job) runs all three in Chromium in about 25 s. App-level vim behavior
(ex commands, status, clipboard, vimrc, key policy) has unit tests in `packages/editor/src/vim*`
and real-keyboard e2e tests in `apps/web/e2e/vim.spec.ts`.

## How to…

- **Add a storage backend:** implement `StorageProvider` (`packages/storage/src/types.ts`), add it to
  `StorageConfig` and `createStorageProvider` (and `createSyncTarget` for a sync target), run the
  shared contract tests against it, document config in `docs/ARCHITECTURE.md`.
- **Add an execution backend:** implement `ExecutionProvider` (`packages/agent/src/execution/types.ts`),
  add its config to `ExecutionConfig` and register it in `createExecutionProvider`. Tools are built
  by `createExecutionTools` from the provider's controllers, so they work unchanged.
- **Add a tool:** name it in `packages/agent/src/tools/contracts.ts`, implement a `ToolSpec` with
  honest safety hints and a `describe()` for approval cards (and a `subject()` when the tool knows
  the real target, see invariant 1), add safety eval cases (a `subject` field feeds the hint), and
  render it nicely in the thread UI if it's user-visible.
- **Add a connector:** add an entry to `~/.daily-do-list/mcp.json` (`mcpServers` format, same as
  Claude Desktop/Cursor). See `packages/connectors/README.md`.
- **Change the sync protocol:** edit `packages/core/src/sync-service.ts` (additive within
  `SYNC_API_VERSION`), then the server (`apps/sync`) and `RemoteStorageProvider`
  (`packages/storage/src/remote.ts`) in the same change, and update `docs/SYNC.md`. Tests start
  the server in process (`createSyncServer({ db: ":memory:", port: 0 })`), never a real one.
- **Add a setting:** extend its wire schema (`packages/contract/src/wire/settings.ts`: `AppSettings`
  is inferred from it, and the daemon validates updates with it), `DEFAULT_SETTINGS` in
  `packages/core/src/settings.ts`, its file schema (`packages/contract/src/persisted/settings.ts`;
  see `docs/DATA_FORMATS.md`), the Swift model (`DailyDoListModels/Settings.swift`), surface it in the
  web settings UI and the Mac settings pane (`apps/macos/Sources/DailyDoListApp/Settings/`), and
  handle it in `AgentRuntime.updateSettings` if agent-related.
- **Add a control (web):** give it a tooltip with `data-tooltip` (never `title`), and if it runs a
  command, `data-command` (`IconButton command=…` or `commandTooltip()` do both): the keycaps and
  `aria-keyshortcuts` come from the registry, so never write a shortcut into text. A shorter
  button name goes in the command's `label`. It gets the pointer by its role; `e2e/polish.spec.ts`
  audits cursors and tooltips on every main screen.

## macOS app (`apps/macos`)

A native SwiftUI/AppKit client of the daemon; details in `apps/macos/README.md`.

- **Layout:** `Package.swift` is the app shell (`Sources/DailyDoListApp`, OS integration in
  `System/`). Independent local packages live in `Packages/`: `DailyDoListModels` (wire models),
  `DailyDoListClient` (`HTTPDaemonClient` + `InMemoryDaemonClient`), `DailyDoListDomain` (ported
  `@ddl/core` logic), `DailyDoListEditor`, `DailyDoListAgent`, `DailyDoListVim` (the port of the
  web editor's vim mode), `DailyDoListDaemon` (`DaemonSupervisor`), `DailyDoListUI` (what the
  shell, the agent UI and the editor share: tooltips, keycaps, the pointing hand, `IconButton`),
  `DailyDoListDrawing` (the native drawing engine: Excalidraw scenes in `.excalidraw.md` files, a
  Rough.js port, the renderer, the tools and `DrawingCanvasView`; its `DailyDoListDrawingModel`
  library is Foundation only), and `DailyDoListComputer` (`ddl-computer`, the helper the daemon
  spawns to operate other apps through their accessibility tree; not linked into the app).
  `IntegrationTests/` is a separate package that runs against the real daemon.
- **Drawings:** `@ddl/core`'s drawing format is the reference, as vim.js is for vim:
  `DailyDoListDrawing` replays `packages/core/test/drawings/fixtures` byte for byte, so
  a format change updates both sides and adds a fixture. Its Rough.js port is checked against
  samples from Rough.js itself (`fixtures/rough-parity.jsonl`); see its README. In notes,
  `DailyDoListEditor` draws embeds with it (floats are text-container exclusion paths, recomputed
  only when something moved them) and hosts its canvas to edit in place; the web's embed layer
  (`packages/editor/src/embeds`) is the behavioral reference, and its edit tests are ported. The
  app's `DrawingStore` saves drawings with `baseVersion` and merges a 409 element by element.
- **Commands:** `apps/macos/scripts/test.sh [Package|app|integration] [-- swift test args]`,
  `apps/macos/scripts/run-app.sh [--demo]`, and
  `apps/macos/scripts/build-app.sh [--release] [--with-daemon] [--zip]` (writes to
  `apps/macos/build/`, gitignored). Integration tests need
  `pnpm --filter @ddl/daemon --filter @ddl/sync build` first.
- **Toolchain:** Swift 6 language mode with strict concurrency, macOS 14+. It builds with only the
  Command Line Tools: there's no XCTest, so tests use Swift Testing, and plain `swift test` can't
  find `Testing.framework`. Always go through `scripts/test.sh`, which adds the flags only when
  `xcode-select` points at the CLT.
- **Conventions:** every package builds and tests on its own. Models, Client, Domain, Vim and
  `DailyDoListDrawingModel` (the drawing package's model library) stay Foundation-only (they also
  build for iOS). Use small files with doc comments. Anything touching
  processes, the network, files or time goes behind a protocol so tests use fakes (see
  `DaemonSupervisorDependencies`). No third-party Swift dependencies so far. swift-format
  (`.swift-format`: 2 spaces, width 100) formats and lints every Swift file: `pnpm lint:fix`.
- **Vim:** `DailyDoListVim` ports vim.js and its CodeMirror 6 adapter file by file, keeping their
  structure and names; the web engine (not the vim editor) decides what is correct. Its
  `VectorReplayTests` replay `packages/editor/test/vim/vectors.jsonl` and must stay at 100% (an
  exclusion needs a reason in the test file). vim.js's own tests are recorded as `upstream/`
  vectors; `Tests/.../Upstream` ports only the few a vector can't express. Hosts implement
  `VimEditor`; see `apps/macos/Packages/DailyDoListVim/README.md`.
- **Vim in the editor:** `DailyDoListEditor` hosts the engine (`Vim/TextViewVimHost*.swift`), and
  `EditorVimIntegration` ports `vim-integration.ts` (the app's ex commands, `gt`, the clipboard
  registers, the vimrc). The app owns one `Vim` and one integration for every editor. Its
  `VimVectorReplayTests` replay every vector through the real editor (via the
  `DailyDoListVimTestSupport` library), with live preview off and on, and must stay at 100% too.
  Vim-mode tests send real `NSEvent`s through `VimEditorHarness`. After a vim change, run
  `test.sh DailyDoListVim`, `test.sh DailyDoListEditor` and `test.sh app`. The design (key
  routing, undo grouping, switching notes) is in the editor's README.
- **Controls:** tooltips are `.tooltip(…)` from `DailyDoListUI` (never `.help`: late, unanimated,
  no keycaps), with the same rules, wording and timings as the web app's. A control that runs a
  command passes the command (`.tooltip("New note", command: .newNote)`, `IconButton(…, command:)`),
  so its keycaps come from `CommandID.shortcut`, the one table of shortcuts; never write a
  shortcut into text (`TooltipTests` scans the sources). Clickable things that aren't text fields
  get `.pointingHandCursor()` (the shared button styles include it), and custom controls a hover
  tint. Tests that drive tooltips give views their own `TooltipCenter` (a `ManualTooltipClock`,
  or `QuietTooltips`) through `\.tooltipCenter`.
- **Protocol changes:** a wire change in `packages/contract/src/wire/` also updates
  `DailyDoListModels` in the same change. Its tests decode the `@ddl/contract` fixtures.
- **Daemon supervision:** the app attaches to a running daemon and never stops one it didn't
  start. It reads the token from `$DDL_HOME/daemon-token` and never logs it. A managed daemon runs
  on the system Node 24.4+ with a stdin watchdog, so it can't outlive the app. A daemon that exits
  with 75 (`RESTART_EXIT_CODE`, e.g. after `PUT /api/device/vault`) is relaunched at once, not
  counted as a crash; the two constants must stay equal.
- **Computer use helper:** `DailyDoListComputer` builds `ddl-computer`; `ddl-computer serve`
  speaks JSON lines on stdin and stdout (the protocol and its limits are in `apps/macos/README.md`)
  and exits when stdin closes. The daemon spawns it, so macOS checks its permissions against the
  app hosting the daemon. The protocol is a contract with the daemon's client: change both in the
  same change. Protected targets (Daily Do List, the apps hosting the daemon, System Settings,
  security prompts, password managers, authenticators, the web UI in any window) are one list,
  `ProtectedTargets.swift`, applied to the real process, never to names the model supplies. The
  helper logs only method names, durations and error codes, and its tests use fakes: a test never
  reads, captures or acts on a real app.
- **Packaging:** `build-app.sh` renders the icon (`scripts/make-icon.swift`), fills
  `Resources/Info.plist.template` and signs with the local identity from
  `scripts/signing-identity.sh` when it exists (so macOS keeps granted permissions across builds),
  else ad hoc. `--with-daemon` bundles
  `pnpm deploy --prod --legacy` output into `Contents/Resources/daemon`, and `ddl-computer` into
  its `bin/` (where the daemon looks: `<directory of dist/main.js>/../bin/ddl-computer`), signed
  with the app's identity before the app. Don't rely on SwiftPM's `Bundle.module` in app code: it
  looks next to the `.app`.
- **CI:** `.github/workflows/macos.yml` (package tests, an iOS build of the Foundation-only
  packages, integration tests, release build, a smoke test of the bundled `ddl-computer`, zipped
  app artifact).

## Commits & PRs

- Conventional commits (`feat(agent): …`, `fix(web): …`, `perf(editor): …`, `docs: …`), checked
  by the commit-msg hook.
- Work lands through branches, not pull requests so far: each stream commits on its own branch,
  and the lead reviews it, merges it into `main` and pushes (see "How the parallel work runs" in
  `PROGRESS.md`). Keep changes small and focused. Include perf numbers for UI-affecting changes.
- CI (lint, typecheck, tests, bench budgets, bundle budget, e2e, mock evals, secret scan) must be
  green on the branch before it merges and on `main` after. Push and pull request triggers don't
  start runs right now, so the lead dispatches the workflows on both
  (`gh workflow run ci.yml --repo aayc/dolist --ref <branch>`; see `docs/CI.md`).
- If a PR resolves a Linear ticket, put `Resolves <ID>` in the PR body.
