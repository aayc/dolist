# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-25 · `main` at `83be988` · in-flight branches pushed to `origin`.

## Picking this up on another machine

1. Clone, then `pnpm install` (Node ≥ 24.4, pnpm 10). The git hooks install themselves
   (`scripts/install-git-hooks.mjs`); they need `gitleaks`, `swift-format`, `shellcheck` and
   `actionlint` on PATH. The macOS app builds with the Command Line Tools (Swift 6).
2. Secrets are never in the repo: recreate `~/.daily-do-list/.env` (for example
   `OPENROUTER_API_KEY`), and sign the Cursor CLI in (`agent login`) for the Cursor harness.
3. macOS app: `apps/macos/scripts/signing-identity.sh` creates the local signing identity so macOS
   keeps granted permissions across builds; on a new Mac, create it, build, then grant
   Accessibility and Screen Recording again (Settings → Computer Use guides you).
4. In-flight work is on the pushed branches below: `git worktree add ../<name> <branch>`.
5. CI doesn't run on push. Dispatch it on a branch or `main`:
   `gh workflow run ci.yml --ref <branch>` (also `macos.yml`, `security.yml`).

## Shipped on `main` (newest first)

- `83be988`, `cbba701` Design: the agent anywhere ([docs/ALWAYS_ON.md](docs/ALWAYS_ON.md)).
- `2a7bb5a` Plan: the native iPhone app ([apps/mobile/PLAN.md](apps/mobile/PLAN.md)).
- `9e97dda` The orchestrator's chat: pinned in the inbox, its own window on the Mac, and
  talking to it directly.
- `5246bfc` Approval policies: ask before every action, ask for risky ones (default), ask for
  high-risk ones, run everything. Hard denies always apply.
- `82c04c9`, `c36d830`, `2e99353` Chat polish on the Mac and the web: replies typed out, an
  activity row, tool groups, an outbox, Stop.
- `92a1b35` … `f26c5e0` Computer use on the Mac: access onboarding, the `ddl-computer` helper
  (operating apps through their accessibility tree), app-wide task grants.
- `661d943` A stable local signing identity for the Mac app.
- `e5cf22d` The sync service (`apps/sync`) and the agent lease.
- `a31cd6e` A line break typed on the desktop counts as pressing Return (needs its own approval).

State at `9e97dda`: CI, macOS app and Security workflows green; that build is installed on the main
development Mac.

## In flight

### Routines — standing jobs on a schedule

Spec: [docs/specs/routines.md](docs/specs/routines.md).

| Branch | What | State |
| --- | --- | --- |
| `feat/routines` | core, agent, daemon routes and events, tests, evals, docs; the Mac UI merged in (`1677aba`) | done; Swift packages, app and integration tests green (vim passed alone after a load flake) |
| `feat/routines-web` | web: Routines section, a routine's runs, New routine, Repeat this | `feat/routines` merged in (`f1ebc4c`); fullstack e2e run and fixes in progress |
| `feat/routines-mac` | macOS: Routines section, commands (⇧⌘R, ⌥⌘N), notifications, Swift client | done, merged into `feat/routines` |

Next: when the web e2e is green, merge `feat/routines-web` into `feat/routines`; full verification (`pnpm check`, `pnpm build && pnpm size:check`, bench,
`pnpm e2e`, `pnpm e2e:perf`, `pnpm eval:mock`, `pnpm vim:check`, `apps/macos/scripts/test.sh`,
`test.sh app`, `test.sh integration`); merge to `main`; push; dispatch CI; install the Mac app.

### The agent anywhere — always-on machine, placement per device, pairing, relay, Settings

Design: [docs/ALWAYS_ON.md](docs/ALWAYS_ON.md). Spec, with the exact wire contract:
[docs/specs/always-on.md](docs/specs/always-on.md).

| Stream | Branch | State |
| --- | --- | --- |
| S0 wire contract | `feat/always-on` | done at `72a9ee8`; adding `heldHere` and the fencing types now; S1–S5 branch from its final commit |
| S6 VM setup kit (Linux bundle, systemd, Azure guide, CI smoke) | `feat/always-on-kit` | done (`395902c`); bundle smoke-tested on the Mac; validating `setup.sh` under systemd in a throwaway OrbStack Linux machine (the `Linux bundle` workflow can only be dispatched once it's on `main`) |
| S1 remote access and pairing | from `feat/always-on` | not started (waits for S0) |
| S2 placement, lease priorities, machine link | from `feat/always-on` | not started (waits for S0) |
| S3 relay | from `feat/always-on` | not started (waits for S0) |
| S4 web Settings and pairing screen | from `feat/always-on` | not started (waits for S0) |
| S5 macOS Settings | from `feat/always-on` | not started (waits for S0) |

The spec's "As built by S0" section records S0's names and extra error codes; S1–S5 follow it.

Kit follow-ups at merge time (marked `FOLLOW-UP` in the code): the pairing step of
`deploy/linux/smoke-check.mjs`; drop the `config.json` override in `deploy/linux/setup-test.sh`
once the daemon accepts `agent.placement` and `remote.hosts`; confirm the names S1/S2 ship match
the kit (those keys, `DDL_AGENT_PLACEMENT`, `DDL_REMOTE_HOSTS`, the `pair` CLI command). The Azure
guide adds a NAT gateway (outbound internet without a public IP), which bills even while the VM is
deallocated.

Next: when S0 lands, start S1–S5; merge S1, S2, S3, then S4 and S5 into `feat/always-on`; add the
pairing step to S6's CI smoke test; merge the kit; full verification; `main`; push; CI. After
that, set up the VM with the kit.

## Next up (not started)

- **Agent journal** (starts right after routines lands on `main`): append-only agent state,
  write-ahead for side effects, resuming runs after a handover, idempotent relay mutations.
  Draft spec: [docs/specs/agent-journal.md](docs/specs/agent-journal.md).

- **iPhone app:** deferred; the web app covers mobile for now. Plan in
  [apps/mobile/PLAN.md](apps/mobile/PLAN.md); needs full Xcode and remote access (S1) first.
- **Editor merge race:** an open editor re-saved lines that were deleted outside it about 10 s
  after an agent edit (the deleted task came back and the orchestrator ran it again). Reproduce,
  add a regression test, fix.
- **Mac:** make sure the floating computer-access guide can't cover the app's controls and closes
  reliably once access is granted.
- **App control:** long, virtualized lists only expose their visible rows (an app showed 11 of 14
  items); teach scrolling or expanding in the tool guidance.
- **Web:** the status bar's save and connection dots still pulse with reduced motion (selector
  specificity).
- **Mac orchestrator window:** bring the typing reveal, activity row and jump-to-latest pill to
  `OrchestratorChatView`, as on the web.
- **Flaky guard:** core's `trackTasks` performance guard fails under machine load and passes
  alone; make it robust to load without loosening it.
- **Known mock-eval misses** (pre-existing on `main`, the suites still pass): safety
  `coding-npm-test`, `coding-run-analysis-script`; triage `renew-passport`.

## Decisions (so nobody asks again)

- **Computer use** runs on our own tools (the `ddl-computer` helper and the execution tools),
  never the harness's built-in ones; the Cursor CLI reaches ours over the MCP bridge.
- **Approval policy** is a setting with four levels; the default asks for risky actions.
- **The orchestrator's chat** can be viewed and talked to (pinned in the inbox, a separate Mac
  window).
- **Routines:** one markdown file per routine in `Routines/`; each run is a chat thread in the
  routine's own inbox, with notifications (always, when changed, never); approvals follow the
  global policy, including agents creating or editing routines; built right after the chat batch.
- **The agent anywhere** (2026-09-25): an Azure Linux VM reached only over Tailscale; no Azure
  power management in the app; the agent's location is chosen per device (for example a personal
  laptop uses the VM, a work laptop runs locally, the web app and the phone use the VM), and
  everything the agent needs syncs so it can move; the scope runs through the relay, with Settings
  on the web and the Mac for all of it.
- **The orchestrator toggle** (2026-09-25): "where the orchestrator runs" (this device or the
  always-on machine) is one easy toggle in the agent panel's header, flippable at any time (the
  personal laptop may go local too); it's held on this device while no always-on machine is set
  up.
- **Journaling** (2026-09-25): not Temporal. Fencing now, in the always-on lease work; the agent
  journal as its own stream right after routines lands.
- **iPhone** (2026-09-25): deferred. When it resumes: native Swift, a free Apple ID (no push or
  TestFlight yet), Siri and Shortcuts as the one extra, network still to decide.

## How the parallel work runs

One lead integrates. Each stream gets a spec, a branch and a worktree; streams commit each working
piece, never push, merge or rebase, and report back; the lead reviews, merges, runs the full
verification, updates this file, pushes and dispatches CI. Agents working next to a running app
follow the specs' environment rules (never bind or kill the running daemon and dev server, tests
in temp dirs and on other ports, never touch the real vault or `~/.daily-do-list/`).
