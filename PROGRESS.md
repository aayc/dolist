# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-25 · `main` at `bbe8aff` (the always-on work and the Linux kit restart
fix; `7ce1e9f` installed) · in-flight branches pushed to `origin`.

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

- `bbe8aff` Linux kit: `setup.sh` stops the daemon before the sync service. One `systemctl
  restart` of both stopped them together; when sync went first the daemon couldn't give the agent
  lease back, and its next run waited up to a minute (the arm64 kit job timed out on it after an
  upgrade). `setup-test.sh` now fails when a restart leaves the lease behind: the old bundle fails
  it and the fixed one passes every check under real systemd (arm64, OrbStack). Linux bundle
  workflow green on `main` (x64 and arm64).
- `7ce1e9f` The agent anywhere: an always-on machine, where the agent runs chosen per device (one
  toggle, held here without a machine or sync), pairing and device tokens, remote access through
  `tailscale serve`, the relay, lease priorities and fencing (journals included), web and Mac
  Settings, the Linux kit (bundle, `setup.sh`, systemd, Azure guide), and the home-folder safety
  rules (`.env` outside the workspace follows the approval policy). Details in the design and
  spec below. CI, Security and Linux bundle green on `main`; macOS app dispatched (green on the
  branch). **Installed** on the main development Mac: agent live here (held here: no sync yet),
  app control kept.
- `d657518` Merge fix follow-up: a line edit and the lines added next to it merge separately (an
  agent's line under an edited task no longer ends up in a conflict copy; TypeScript and Swift);
  the notes model tests fail properly instead of via unhandled rejections. CI and macOS green.
- `6750f36` The editor merge race: an open editor never brings back lines deleted elsewhere
  (root cause: the Mac `NotesStore.save()` kept a stale "unsaved" copy of a clean note); conflicts
  save the merge, not the whole local text (web and Mac); remounted web editors keep unsaved
  typing. CI and macOS green on the branch. **Installed** on the main development Mac (with the
  journal).

- `dffdfdd` The agent journal, phase 1: threads on an append-only journal
  (`.daily-do-list/state/journal/threads/`, union-merged by sync), snapshots byte-identical to
  before, write-ahead around tool calls (an unrecorded call is blocked; an interrupted side effect
  is never re-run), resume after a restart (Pi natively, Cursor from a text transcript). CI and
  Security green on the branch.

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

### The always-on machine (the Azure VM)

The code is on `main` (`7ce1e9f`, `bbe8aff`). Design: [docs/ALWAYS_ON.md](docs/ALWAYS_ON.md);
wire contract: [docs/specs/always-on.md](docs/specs/always-on.md); the kit and its Azure guide:
`deploy/linux/README.md`. Streams S0–S6 were built in parallel on `feat/always-on-*` branches
and merged through `feat/always-on` (their history is in git).

Next: set up the VM with the kit (the user runs `az login` and saves the Tailscale auth key file
themselves; credentials never go in the chat or the repo): check `Standard_D4ps_v6` availability,
show the cost and resources, create them, run `setup.sh`, pair, then verify on the real VM what
only it can: the `az` commands, the Tailscale login, and that `tailscale serve` keeps the original
`Host` (the daemon refuses loopback-Host requests carrying proxy forwarding headers, so a
Host-rewriting proxy fails closed instead of getting the master token).

Open: browser pairing over https stays fixme in the e2e harness (no TLS proxy there).

### Drawings in notes (Excalidraw-compatible)

Spec: [docs/specs/drawings.md](docs/specs/drawings.md).

| Stream | Branch | State |
| --- | --- | --- |
| X0 format and description (core, shared fixtures) | `feat/drawings` | done (`048dbed`): plugin-exact files (verified against plugin 2.27.3 source), embeds, `describeDrawing`, 11 shared fixtures, the watcher ignores drawings |
| X2 Mac drawing engine (`DailyDoListDrawing`) | `feat/drawings-mac-engine` | done (`06d8d1c`, 13 commits; X0 merged in at `178a7f5`, all 11 shared fixtures replay byte for byte in Swift): Rough.js port matching Rough.js 4.6.4 within 1e-7, Excalidraw-like rendering light and dark, the core tools, 2–3 ms frames at 2,000 elements (release). Deferred: images, rotation handle, elbow arrows, frames, z-order, copy/paste, snapping |
| X1 web editor (generic embed layer, floats, move/resize, in-place Excalidraw) | `feat/drawings-web` | done (`d471e8e`, 14 commits): the embed layer (`packages/editor/src/embeds/`, ready for images), the real Excalidraw lazy-loaded with self-hosted fonts, insert (⌘⇧X), move/resize/delete, element-level merges (`mergeDrawingElements` in core), drawing files open full size; typing beside six drawings p95 1.7 ms. **Merged with X4 into `feat/drawings`** (lint, typecheck, core 584, daemon 598, web 556, agent tests, evals green) |
| X4 the agent sees drawings (descriptions, `read_drawing`, renderer) | `feat/drawings-agent` | done (`3655c0b`, 8 commits): descriptions in the digest, `read_note` and subagent kickoffs (bounded, cached, marked as data), `read_drawing` with a PNG for vision models (Pi from its catalog, Cursor from ACP's image capability), its own headless Chromium (no profile, network blocked, closes idle), cache in `$DDL_HOME/cache/drawings`; drawings never re-triage tasks and agents never write in them. Evals: safety 287/289, triage 80/81, no new misses. Merges into `feat/drawings` with X1 |
| X3 Mac editor integration (exclusion paths, in-place canvas) | `feat/drawings-mac-editor` (from `178a7f5`) | done (`8ace18d`, 7 commits): floats with TextKit exclusion paths, move/resize, the native canvas in place, Insert Drawing (⇧⌘X), `.excalidraw.md` files open full size, element-level merges (`SceneMerge`, same rules as `mergeDrawingElements`; shared merge vectors are a follow-up); a keystroke beside a float 0.48 ms average / 0.75 ms p95 in a 2,000-line note with six drawings (release). **Merged with X2 into `feat/drawings` at `cddf779`**: lint, typecheck, core 584, web 556, editor 276, Swift Drawing 97, Editor 294 (vim replays 100%), app 258 green |

**All drawings streams are in `feat/drawings` (`cddf779`).** `feat/always-on` merged in at
`0174e2b` (12 conflicts: the orchestrator gets every knowledge tool, `search_notes` and
`read_drawing`; a subagent's kickoff carries both the task's drawings and the journal's uncertain
side effects; polish audits take `{ ignore, minControls }`; 153 safety rules), then `main` at
`4caaf0f`. Together they came to 1,217 kB of total web JS against a 1,200 kB budget; per the user
the Total JS budget is now 1,300 kB (`5fa14c6`; startup JS unchanged, 278.5 of 320 kB, and the
reason is in `docs/PERFORMANCE.md`). Verified: lint, typecheck, every TS unit suite, build and
bundle budget, mock evals (safety 327/329, no false allows; triage 80/81), functional e2e 117
passed, every Swift package and the app. CI, macOS app, Security and Linux bundle dispatched on
the branch. Next: merge to `main` when green, install.

### Moving from Obsidian

Spec: [docs/specs/obsidian-migration.md](docs/specs/obsidian-migration.md).

| Stream | Branch | State |
| --- | --- | --- |
| M the editor merge race (data safety) | `fix/editor-merge-race` | **all on `main`** (`6750f36`, `d657518`). Follow-up (`361f8ac`): the fuzz seed was a real merge bug (an edit plus a line added under it were one block, so an agent's line ended up in a conflict copy); `mergeText` and the Swift port now split replaced blocks; the model tests fail properly instead of via unhandled rejections; two oracle fixes. CI and macOS dispatched on the branch; merge to `main` when green. Fixed (`4d3ef06`): root cause in the Mac `NotesStore.save()` (a clean save kept a stale "unsaved" copy, shown again later and saved with a valid version); also conflicts no longer restore deleted lines (web and Mac, `mergeText` and its Swift port), and remounted web editors keep unsaved typing; guarantee in invariant 7. CI and macOS dispatched on the branch; merge to `main` when green. Now investigating the fuzz seed below and making model-check failures fail the property instead of becoming unhandled rejections. Left as is: on the Mac a remote change is an undoable step (⌘Z right after an external delete restores the lines) |
| I0 Import from Obsidian: engine, carry-over, vault switch, update | `feat/obsidian-import` | done (`9ebd1cd`, 12 commits); `feat/always-on` merged in at `f0ced02` (daemon 1205, contract 1284 tests green). After an import the real watcher finds no new work (every carried task keeps its id, thread and badge). Vault switch exits 75 (the Mac supervisor relaunches at once). Paired devices get 403 `forbidden_device`; switching is refused while sync is on. Journal files copied unchanged (`remapJournalFile` hook) |
| I1 Import from Obsidian: web and Mac flows | `feat/obsidian-import-ui` (from `f0ced02`) | in progress (web Settings → Vault with its e2e, and the Mac Settings pane committed at `fa408e6`) |
| B0 binary files, attachment sync, file serving | from `main` | queued, unblocked (the always-on work, which changed the same sync code, is on `main`) |
| P images, tables, callouts, backlinks (web and Mac) | after the drawings' embed layer | queued (images share the drawings' embed layer) |

### What the orchestrator is doing while you write

Spec: [docs/specs/orchestrator-activity.md](docs/specs/orchestrator-activity.md) (user request:
see it notice, work and conclude on any line, not only checkbox tasks). Branches from
`feat/always-on` (so the relay forwards the new event). **Built and integrated** on
`feat/orchestrator-activity` (`0eef27d`): the web side (wire `6c1bfce`, agent phases and
outcomes, the relay forwards it, chips, header and status bar; a dot 300 ms after the last
keystroke; a watcher race fixed) with the Mac side merged in; both platforms use the same
wording and timings (the table in `apps/web/README.md`). `main` (with the always-on work) merged
in at `2b8a768` (5 conflicts: the mock notices prose only while the agent runs on this device;
the status carries the activity and the placement). Lint, typecheck, TS unit suites (the helper
and stdio subprocess tests flaked under load, pass alone), functional e2e 116 passed; every Swift
package running; CI, macOS app and Security dispatched (Security green). Next: merge to `main`
when green, install.

### Agent journal

Phase 1 shipped (`dffdfdd`); the daemon passes the lease epoch as
`AgentRuntimeOptions.leaseEpoch` (on `main` with the always-on work). Phase 2 (approvals and routines state on the journal,
client ids for idempotent relay mutations, compaction, resuming the orchestrator's turn) after
that. Spec: [docs/specs/agent-journal.md](docs/specs/agent-journal.md). Phase 1: the journal is the source of truth for threads
(append-only JSONL, union merge in the sync engine), today's thread JSON is still written as a
derived snapshot (so the relay's read-only view, older daemons and the clients keep working),
write-ahead around tool calls with "interrupted" instead of re-running, resume after a restart,
migration of existing threads. Phase 2 (unblocked): approvals, routines state and client ids
for idempotent mutations.

## Next up (not started)

- **Security, delete rules:** `rm -rf /users/<name>` in lowercase only asks instead of hitting
  the "deletes your home directory" hard deny (macOS paths are case-insensitive). Make the delete
  rules match home paths case-insensitively, with eval cases. Known remaining read gaps (from the
  home-folder fix): a single file held in a variable, a project folder's `.env` read recursively,
  subfolders of personal folders, `~/Library/Preferences`.

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
- **Secrets and the approval policy** (2026-09-25): the user's strictness is about secrets never
  being committed to this public repo (the hooks). Agents reading a `.env` to run a project
  follows the approval policy. Still hard denies: sending secrets off the machine, the daemon's
  own token files, credential stores (SSH private keys, cloud credentials, keychains), shell
  histories and sweeping the whole home folder.
- **Web bundle budget** (2026-09-25): Total JS (every chunk, lazy ones included) is 1,300 kB
  gzip, raised from 1,200 when drawings and the always-on work came together at 1,217 kB. The
  user chose this over per-area budgets or fewer code block languages. Startup stays guarded by
  the 320 kB initial JS budget.
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
