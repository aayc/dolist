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

- `0a041a6` The orchestrator can search the user's notes (`search_notes`, as subagents could), not
  only read the ones it's told the name of.
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
| S6 VM setup kit (Linux bundle, systemd, Azure guide, CI smoke) | `feat/always-on-kit` | Azure guide done (`9494baa`: public IP with all inbound closed, `--nsg ""`, `Standard_D4ps_v6` on the Gen2 arm64 image with the NVMe controller; OpenSSH off at first boot); `feat/always-on` merged in; now adding the pairing smoke step, dropping the config override, an arm64 CI job, and rerunning the systemd test in OrbStack |
| S1 remote access and pairing | `feat/always-on-remote` | done (`48d4ec7`), merged into `feat/always-on` at `0501be1` |
| S2 placement, lease priorities, fencing, machine link | `feat/always-on-placement` | done (`bb18e4b`), merged into `feat/always-on` at `394a6dd` (with S1: daemon 1061, sync 63, storage 303, contract 1123 tests green) |
| S3 relay | `feat/always-on-relay` | built (`6f5aa68`); `feat/always-on` merged into it at `569d3a6` (relay wired to S2's supervisor and machine link, `placement-lease.ts` dropped); S3 is fixing 6 daemon tests whose assumptions changed with S2's lease gating, then it merges into `feat/always-on` |
| S4 web Settings, the orchestrator toggle, pairing screen | `feat/always-on-web` | built (`2a885ee`: toggle, 5 Settings sections, pairing screen and cookie mode, read-only states; 667 unit, 107 functional e2e, perf and bundle green on the mock); `feat/always-on` (S1+S2) merged in; now running the fullstack e2e (the handover test waits for S3) |
| S5 macOS Settings and the orchestrator toggle | `feat/always-on-mac` (from `a0a924f`) | in progress |

S1 and S2 branch from `45a7cd1` (before routines), S3–S5 from `a0a924f` (after). S1 and S2 share
two seams: `apps/daemon/src/remote-hosts.ts` (`RemoteHosts`: S1's
implementation wins at merge) and `config.ts` (S1 loads `remote.hosts`, S2 loads
`agent.placement` and writes the file).

The spec's "As built by S0" section records S0's names and extra error codes; S1–S5 follow it.

To verify on the real VM (S1): `tailscale serve` must keep the original `Host`; the daemon
refuses loopback-Host requests that carry proxy forwarding headers (so a Host-rewriting proxy
fails closed instead of getting the master token).

The kit's names match what S1/S2 shipped (`agent.placement`, `remote.hosts`,
`DDL_AGENT_PLACEMENT`, `DDL_REMOTE_HOSTS` comma-separated, the `pair` CLI). Only the real VM can
verify the `az` commands, Tailscale login and `tailscale serve`.

Now unblocked by S1+S2 on `feat/always-on`: S4's fullstack e2e (merge `feat/always-on` into
`feat/always-on-web` when S4 reports "ready for backend", then resume it), the kit's follow-ups
(the pairing smoke step, dropping the `config.json` override), and S3's wiring to S2's
`agent-location.ts` (S2 names: `MachineCredentialSource.current()`, `PlacementSource.current()`,
`setRelay()`; S3 coded against `credential()`/`effective()`: adapt at merge).

Next: merge S3, then S4 and S5 into `feat/always-on`; add the pairing step to S6's CI smoke test; merge the kit; full
verification; `main`; push; CI; install. After that, set up the VM with the kit.

### Drawings in notes (Excalidraw-compatible)

Spec: [docs/specs/drawings.md](docs/specs/drawings.md).

| Stream | Branch | State |
| --- | --- | --- |
| X0 format and description (core, shared fixtures) | `feat/drawings` (from `main`) | in progress |
| X2 Mac drawing engine (`DailyDoListDrawing`) | `feat/drawings-mac-engine` (from `main`) | in progress |
| X1 web editor (floats, move/resize, in-place Excalidraw) | from `feat/drawings` | waits for X0 |
| X4 the agent sees drawings (descriptions, `read_drawing`, renderer) | from `feat/drawings` | waits for X0 |
| X3 Mac editor integration (exclusion paths, in-place canvas) | from X2 | waits for X2's canvas |

### Moving from Obsidian

Spec: [docs/specs/obsidian-migration.md](docs/specs/obsidian-migration.md).

| Stream | Branch | State |
| --- | --- | --- |
| M the editor merge race (data safety) | `fix/editor-merge-race` (from `main`) | in progress |
| I0 Import from Obsidian: engine, carry-over, vault switch, update | `feat/obsidian-import` (from `feat/always-on` at `394a6dd`) | in progress |
| I1 Import from Obsidian: web and Mac flows | from I0 | waits for I0's routes |
| B0 binary files, attachment sync, file serving | from `feat/always-on` or `main` | queued (after the always-on work lands; S2 changed the same sync code) |
| P images, tables, callouts, backlinks (web and Mac) | after the drawings' embed layer | queued (images share the drawings' embed layer) |

### Agent journal — phase 1 (threads)

Spec: [docs/specs/agent-journal.md](docs/specs/agent-journal.md). Branch `feat/agent-journal`
from `main` at `a42bcf3`: in progress. Phase 1: the journal is the source of truth for threads
(append-only JSONL, union merge in the sync engine), today's thread JSON is still written as a
derived snapshot (so the relay's read-only view, older daemons and the clients keep working),
write-ahead around tool calls with "interrupted" instead of re-running, resume after a restart,
migration of existing threads. Phase 2, after the always-on work merges: approvals, routines
state and client ids for idempotent mutations.

## Next up (not started)

- **Security (priority, in progress on `fix/home-folder-reads` from `feat/always-on`):**
  recursive reads of the whole home folder (`grep -r … ~`, `tar … ~`) still pass the safety
  rules, which exposes `~/.ssh` and other secrets (pre-existing; found by S1, which closed the
  `DDL_HOME` token-file hole). Deny bulk and secret-path reads, ask for broad recursive ones, with
  eval cases; merges into `feat/always-on`.

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
  pass alone; make them robust without loosening them. Same for the agent's subprocess tests
  (for example `app-control/client.test.ts`, "stops waiting when the call is aborted").
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
- **The Azure VM** (2026-09-25): set it up only after pairing, placement and the relay are
  merged, then all in one go. A public IP with every inbound port closed (not a NAT gateway).
  Budget under $120 a month all in: `Standard_D4ps_v6` (Azure Cobalt 100 ARM, 4 vCPU, 16 GB,
  about $102 pay-as-you-go in West US 2/3 and East US) plus a 64 GB premium SSD (about $10) and
  a static IP (about $4) is about $116; check regional availability at setup. Everything it runs
  supports Linux arm64 (Node 24, the kit's arm64 bundle, Playwright's Chromium, the Cursor CLI).
  x86 alternatives: `Standard_B4as_v2` (about $110 plus disk and IP, just over) or
  `Standard_D2as_v5` (2 vCPU, 8 GB, about $63). The user runs `az login` and creates the Tailscale
  auth key file themselves; credentials never go in the chat or the repo.
- **Drawings** (2026-09-25): Excalidraw-compatible drawings in notes, stored in Obsidian's
  Excalidraw plugin format and embedded with its syntax; anchored with text wrapping around them,
  movable and resizable; the real Excalidraw on the web (lazy-loaded); on the Mac a native engine
  written from scratch with the core tools (the user's choice, for speed); the orchestrator always
  sees a text description plus an image for vision-capable models.
- **Moving from Obsidian** (2026-09-25): the user will switch from Obsidian (Obsidian Sync) by
  **copying** the vault, not sharing the folder. Build the merge-race fix, Import from Obsidian
  (report first, a new vault from a copy, carry-over of Daily Do List notes, routines and agent
  history with daily-note paths remapped, then switch; plus Update from Obsidian), images, tables,
  callouts, backlinks, and attachment sync.
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
