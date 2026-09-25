# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-25 · `main` at `a42bcf3` (routines) · in-flight branches pushed to
`origin`.

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

- `a42bcf3` Routines: standing jobs the agent runs on a schedule, one markdown file each in
  `Routines/`, each run a chat thread in the routine's own inbox, with notifications; on the web
  and the Mac ([docs/specs/routines.md](docs/specs/routines.md), journeys J12 and J13).
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

State at `a42bcf3`: verified before merging (`pnpm check`, build and bundle budget, benchmarks,
mock evals, fullstack, functional, polish and perf e2e, every Swift package, the app and the
integration tests); CI, macOS app and Security workflows dispatched on `main`. That build is
installed on the main development Mac (permissions kept).

## In flight

### The agent anywhere — always-on machine, placement per device, pairing, relay, Settings

Design: [docs/ALWAYS_ON.md](docs/ALWAYS_ON.md). Spec, with the exact wire contract:
[docs/specs/always-on.md](docs/specs/always-on.md).

| Stream | Branch | State |
| --- | --- | --- |
| S0 wire contract | `feat/always-on` | done at `45a7cd1` (incl. `heldHere` and the fencing types); `main` (routines) merged in at `a0a924f` |
| S6 VM setup kit (Linux bundle, systemd, Azure guide, CI smoke) | `feat/always-on-kit` | done (`395902c`); bundle smoke-tested on the Mac; validating `setup.sh` under systemd in a throwaway OrbStack Linux machine (the `Linux bundle` workflow can only be dispatched once it's on `main`) |
| S1 remote access and pairing | `feat/always-on-remote` | in progress |
| S2 placement, lease priorities, fencing, machine link | `feat/always-on-placement` | in progress |
| S3 relay | `feat/always-on-relay` (from `a0a924f`) | in progress |
| S4 web Settings, the orchestrator toggle, pairing screen | `feat/always-on-web` (from `a0a924f`) | in progress; stops at "ready for backend" before its fullstack e2e |
| S5 macOS Settings and the orchestrator toggle | `feat/always-on-mac` (from `a0a924f`) | in progress |

S1 and S2 branch from `45a7cd1` (before routines), S3–S5 from `a0a924f` (after). S1 and S2 share
two seams: `apps/daemon/src/remote-hosts.ts` (`RemoteHosts`: S1's
implementation wins at merge) and `config.ts` (S1 loads `remote.hosts`, S2 loads
`agent.placement` and writes the file).

The spec's "As built by S0" section records S0's names and extra error codes; S1–S5 follow it.

Kit follow-ups at merge time (marked `FOLLOW-UP` in the code): the pairing step of
`deploy/linux/smoke-check.mjs`; drop the `config.json` override in `deploy/linux/setup-test.sh`
once the daemon accepts `agent.placement` and `remote.hosts`; confirm the names S1/S2 ship match
the kit (those keys, `DDL_AGENT_PLACEMENT`, `DDL_REMOTE_HOSTS`, the `pair` CLI command). The Azure
guide adds a NAT gateway (outbound internet without a public IP), which bills even while the VM is
deallocated.

Next: merge S1, S2, S3, then S4 and S5 into `feat/always-on` (resume S4 for its fullstack e2e
after S1/S2 are in); add the pairing step to S6's CI smoke test; merge the kit; full
verification; `main`; push; CI; install. After that, set up the VM with the kit.

### Agent journal — phase 1 (threads)

Spec: [docs/specs/agent-journal.md](docs/specs/agent-journal.md). Branch `feat/agent-journal`
from `main` at `a42bcf3`: in progress. Phase 1: the journal is the source of truth for threads
(append-only JSONL, union merge in the sync engine), today's thread JSON is still written as a
derived snapshot (so the relay's read-only view, older daemons and the clients keep working),
write-ahead around tool calls with "interrupted" instead of re-running, resume after a restart,
migration of existing threads. Phase 2, after the always-on work merges: approvals, routines
state and client ids for idempotent mutations.

## Next up (not started)

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
- **Flaky under load:** storage's file-watcher tests (`local-fs.watch.test.ts`,
  `internal/directory-tree-watcher.test.ts`) fail now and then when the machine is saturated and
  pass alone; make them robust without loosening them.
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
