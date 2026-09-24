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
   actions need explicit human approval. Fail closed.
2. **Responsiveness is a feature.** The editor must feel instant. Performance budgets are enforced
   in CI (see `docs/PERFORMANCE.md`). Never put network or O(document) work on the keystroke path.
3. **Local-first, plain files.** Notes are plain markdown in a folder (Obsidian-compatible vault).
   Agent state lives in the vault's hidden sidecar folder `.daily-do-list/`.
4. **Providers everywhere.** Storage, sync, execution (local/cloud), agent harness and connectors
   sit behind interfaces with a registry, so backends can be swapped without touching callers.
5. **Cross-platform by construction.** The web UI is the only UI codebase; the macOS and iOS apps
   will wrap it (see `docs/CROSS_PLATFORM.md`).

## ⚠️ This repository is PUBLIC

- Never commit secrets, tokens, `.env` files, personal notes, vault content, agent state, browser
  profiles, shell history, or absolute paths containing a username. `scripts/check-secrets.mjs`
  runs as a pre-commit hook and in CI (plus gitleaks). Do not bypass it.
- API keys live in `~/.daily-do-list/.env` (outside the repo) or the process environment. Code must
  read them from `process.env` at runtime and must never log them.
- Test fixtures and examples must be synthetic (no real names, emails, addresses or notes).
- Before committing, run `git status` and review every staged file.

## Repository map

```
apps/
  web/            React 19 + Vite UI (the one UI codebase; also wrapped by desktop/mobile later)
  daemon/         Node 24 local server: REST + WebSocket API, vault owner, runs the agent runtime
  desktop/        (planned) Tauri 2 macOS shell — docs only for now
  mobile/         (planned) Tauri 2 iOS shell — docs only for now
packages/
  core/           Pure, isomorphic domain logic + wire protocol types (no dependencies!)
  storage/        StorageProvider interface; local-fs, memory, s3 (stub); SyncEngine; search
  editor/         CodeMirror 6 markdown editor: live preview, tasks, vim, agent badges
  agent/          Agent runtime: watcher, orchestrator, subagents, harness (Pi), safety, approvals,
                  execution providers (local/cloud), threads/artifacts, tools, LLM client
  connectors/     MCP client: mcpServers config → ToolSpecs (stdio / streamable HTTP / SSE)
evals/            Agent evals (safety verdicts, triage, latency); mock mode runs in CI
scripts/          Repo tooling (secret scan, bench/bundle budgets, git hooks)
docs/             Architecture, agent system, performance, security model, cross-platform plan
```

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` (Node ≥ 24.4, pnpm 10) |
| Dev (daemon + web, live agent) | `pnpm dev` → http://localhost:5173 |
| Dev with deterministic mock agent | `pnpm dev:mock` |
| Lint / format | `pnpm lint` / `pnpm lint:fix` |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test` (or `pnpm --filter @ddl/<pkg> test`) |
| Benchmarks (with budgets) | `pnpm bench` then `pnpm bench:check` |
| E2E / perf e2e | `pnpm e2e` / `pnpm e2e:perf` |
| Evals | `pnpm eval:mock` (CI) / `pnpm eval` (real model, needs `OPENROUTER_API_KEY`) |
| Pre-commit essentials | `pnpm check` (lint + typecheck + unit tests + secret scan) |
| Build / bundle budget | `pnpm build && pnpm size:check` |
| Build / run production | `pnpm build && pnpm start` → http://127.0.0.1:7331 |
| Smoke-test the real model | `pnpm --filter @ddl/agent exec tsx scripts/smoke-pi.ts` (also `smoke-llm.ts`) |

Scope commands to the package you are working in while iterating. Before you finish, run
`pnpm check`; for UI or agent changes also run the relevant parts of what CI runs:
`pnpm build && pnpm size:check`, `pnpm bench && pnpm bench:check`, `pnpm e2e`, `pnpm e2e:perf`,
`pnpm eval:mock` (see `docs/CI.md`).

## Architecture in one screen

```
 Editor (web) ──REST/WS──▶ Daemon ──▶ StorageProvider (vault: local fs │ s3) ◀──▶ SyncEngine ──▶ sync target
                              │
                              └──▶ AgentRuntime
                                     TaskWatcher  (storage events → parse → track identities → settle)
                                        ▼ TaskEvents
                                     Orchestrator (control plane + orchestrator agent session)
                                        ▼ spawn_subagent
                                     SubagentManager (one harness session per task/thread)
                                        │ tools: thread / web / notes / browser / computer / bash / MCP
                                        ▼ every tool call
                                     SafetyGate → SafetyEvaluator (policy → rules → LLM judge)
                                        │ require_approval
                                        ▼
                                     ApprovalBroker ──WS──▶ approval card in the UI
                                     ExecutionProvider (local │ cloud): shell, browser, computer
                                     ThreadStore (.daily-do-list/threads, artifacts)
```

Key flows are documented in `docs/ARCHITECTURE.md` and `docs/AGENT_SYSTEM.md`.

Docs index: `README.md` (product + quick start), `docs/ARCHITECTURE.md`, `docs/AGENT_SYSTEM.md`,
`docs/PERFORMANCE.md`, `docs/CROSS_PLATFORM.md`, `docs/CI.md`, `SECURITY.md`, `CONTRIBUTING.md`,
and package READMEs (`packages/storage`, `packages/connectors`, `packages/editor`,
`packages/agent/src/safety`, `packages/agent/src/execution`, `apps/daemon`).

## Invariants (do not break these)

1. **Safety gate is mandatory.** Every tool — built-in, harness built-in (bash/read/write/edit),
   execution, connector (MCP) — executes only after `beforeToolCall` (the SafetyGate) allows it.
   Never add a code path that executes a tool without it. New tools must declare honest
   `ToolSafetyHints`; hints may only make things *more* restricted.
2. **Harness isolation.** Only `packages/agent/src/harness/` may import `@earendil-works/pi-*`.
   Everything else uses the `Harness`/`HarnessSession` interfaces and `ToolSpec` from `@ddl/core`.
   To customize Pi beyond its extension API, prefer `pnpm patch` over forking.
3. **Provider registries.** Backend selection happens only in registries
   (`createStorageProvider`, `createExecutionProvider`, `createSyncTarget`, …). No
   `if (kind === "s3")` in callers.
4. **`@ddl/core` is pure.** No dependencies, no `node:*` imports, no DOM access (timers, `crypto`
   via `globalThis` are fine). It runs in the browser, the daemon and future native shells.
5. **Wire protocol lives in `packages/core/src/protocol.ts`.** Daemon and clients import the same
   types. Changing a shape = update both sides in the same change.
6. **The daemon is local-only and authenticated.** Bind `127.0.0.1`, require the bearer token,
   reject unexpected `Host`/`Origin` headers. Never add an unauthenticated endpoint that reads the
   vault or triggers agent work.
7. **Agents don't silently edit the user's notes.** Agents write to the sidecar (threads,
   artifacts). Changing note content is a `file_write` on the vault and goes through approval.
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
- **Pi harness:** sessions are hermetic (isolated `agentDir` under `$DDL_HOME/pi`, no discovered
  extensions/skills/context files) and refuse to start if the safety-gate extension didn't load.
- **E2E typing:** use Playwright's real keyboard (`page.keyboard.type`). Automation "fill"-style
  typing into CodeMirror rebuilds text from the DOM (including badge widgets) and corrupts notes.

## Testing expectations

- Unit tests are colocated (`foo.test.ts`). Every bug fix gets a regression test.
- Benchmarks are `*.bench.ts` using Vitest 5's `bench` fixture and assert p99 budgets.
- UI: Playwright functional e2e (`apps/web/e2e`) and perf e2e with budgets (`docs/PERFORMANCE.md`).
- Agent behavior: add eval cases (`evals/datasets`) for new safety rules or triage behavior. Mock
  mode must stay deterministic and green in CI; the rules layer must never "allow" a case whose
  expected verdict is `require_approval`/`deny`.
- Tests never hit the network or the real model (use `MockLlmClient` / `ScriptedHarness`), never
  touch the user's real vault, and clean up temp dirs.

## How to…

- **Add a storage backend:** implement `StorageProvider` (`packages/storage/src/types.ts`), add it to
  `createStorageProvider`, run the shared contract tests against it, document config in
  `docs/ARCHITECTURE.md`.
- **Add an execution backend:** implement `ExecutionProvider` (`packages/agent/src/execution/types.ts`)
  and register it in `createExecutionProvider`. Tools are built by `createExecutionTools` from the
  provider's controllers, so they work unchanged.
- **Add a tool:** name it in `packages/agent/src/tools/contracts.ts`, implement a `ToolSpec` with
  honest safety hints and a `describe()` for approval cards, add safety eval cases, and render it
  nicely in the thread UI if it's user-visible.
- **Add a connector:** add an entry to `~/.daily-do-list/mcp.json` (`mcpServers` format, same as
  Claude Desktop/Cursor). See `packages/connectors/README.md`.
- **Add a setting:** extend `AppSettings` + `DEFAULT_SETTINGS` in `packages/core/src/settings.ts`,
  surface it in the settings UI, and handle it in `AgentRuntime.updateSettings` if agent-related.

## Commits & PRs

- Conventional commits (`feat(agent): …`, `fix(web): …`, `perf(editor): …`, `docs: …`).
- Small, focused PRs; CI (lint, typecheck, tests, bench budgets, bundle budget, e2e, mock evals,
  secret scan) must be green. Include perf numbers for UI-affecting changes.
- If a PR resolves a Linear ticket, put `Resolves <ID>` in the PR body.
