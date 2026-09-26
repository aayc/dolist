# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-25 · `main` at `b220dd2`: everything built today is merged (always-on,
orchestrator activity, drawings, import from Obsidian); CI, macOS app, Security and Linux bundle
green on it, and it's the build installed on the main development Mac. No open branches; next is
the Azure VM.

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
5. CI doesn't start on push or pull requests (the triggers are declared, but GitHub hasn't fired
   them since the first push; see `docs/CI.md`, "How runs start today"). Dispatch it on each
   branch before merging and on `main` after pushing:
   `gh workflow run ci.yml --repo aayc/dolist --ref <branch>` (also `security.yml`, `macos.yml`,
   `linux-bundle.yml`).

## Shipped on `main` (newest first)

- `7f1f796` Cleanup batch A (TypeScript): imported threads keep their new note paths (the import
  now remaps journals at `state/journal/`), the approval broker persists through the shared state
  file (moves a corrupt file aside, never overwrites a newer one), dead code and dependency/config
  fixes. `8bae6ff` docs drift fixed across the repo; CI is dispatched by hand (push/PR triggers are
  declared but GitHub Actions never starts them; cause unknown, see `docs/CI.md`).
- `cf0d413` Test trim (−75.6k): Swift Domain vectors compacted to one case per line (same 20,127
  cases), tests the vectors and property tests cover removed, shared test helpers.
- `0011be4` The web e2e, perf tests and `pnpm dev:mock` run on real daemons (one per test, mock
  agent or Pi against the fake model, a seeded demo vault); the in-browser mock is gone (−6.9k lines).
  The fullstack scenarios merged into the functional suite (134 passed); all e2e takes ~106 s instead
  of ~275 s. One gated test hook: `DDL_TEST_HOOKS=1` simulates a Mac's computer access. `pnpm
  dev:mock` uses ports 7340/5174 and a throwaway vault.
- `75ce44d` Small cuts (−1.1k): S3 and cloud stubs gone (and `"s3"` from the protocol), one mock LLM,
  the triage eval runs on the fake brain (81/81 now), one forwarding base for the relayed and leased
  runtimes, the Swift drawing description port.
- `f78a4e9` Swift vim tests the recorded vectors cover are gone (−6.1k); 6 checks became vectors.
- `c7ca463` The orchestrator's placement is a "Remote" switch (on = the always-on machine, off = this
  device) in the agent panel and Settings, on the web and the Mac; one shared switch component per
  platform. **Installed** on the main development Mac.
- `aa70f6a` Performance, web and daemon: vault event bursts published once per frame (300 new files
  on a 5,000-note vault: 4.2 s to 21 ms), the explorer and chats render only the rows in view (a
  1,000-message thread opens in 18 ms instead of 120), one render per palette key; daemon restarts
  about twice as fast (file versions kept in `$DDL_HOME/cache/vault-versions.json`, keyed on mtime
  and size like the in-memory cache), tree 6x and search 14x faster at 10,000 notes, the MCP SDK
  loads only when `mcp.json` names servers, and a request-like line starts a turn about 0.9 s after
  the cursor leaves it (was 2.7 s). New budgets in `docs/PERFORMANCE.md`.
- `b220dd2` Patched `nanoid` and `lodash-es` for Dependabot's 11 open alerts (they came with
  Excalidraw and its Mermaid importer): pnpm overrides; the web bundle is unchanged. **Installed**
  on the main development Mac (agent live, app control kept); Dependabot: 0 open alerts.
- `e2fd3ce` Import from Obsidian: point it at your Obsidian vault (it copies it; the original and
  Obsidian Sync stay untouched), read the report, import into a new folder with this vault's notes
  and agent history carried over, switch to it, and later Update from Obsidian; web Settings →
  Vault and Mac Settings → General → Vault and the File menu
  ([spec](docs/specs/obsidian-migration.md), README "Moving from Obsidian"). Still to try for
  real: the switch in the running Mac app, and a large real vault.
- `052dcc8` Drawings in notes: Excalidraw-compatible drawings in the Obsidian Excalidraw plugin's
  format, embedded with its syntax, floated with text wrapping around them, movable and
  resizable; the real Excalidraw on the web (lazy-loaded), a native engine on the Mac; the agent
  sees each drawing as a description and, with `read_drawing`, an image
  ([spec](docs/specs/drawings.md)). Total JS budget now 1,300 kB (per the user). CI, macOS app,
  Security and Linux bundle green on the branch; dispatched on `main`.
- `3f69ea2` What the orchestrator is doing while you write: it notices, reads, thinks, acts and
  concludes on any line, not only checkbox tasks; chips on the lines that woke it, the note header
  and the status bar, on the web and the Mac with the same wording and timings
  ([spec](docs/specs/orchestrator-activity.md)). CI, macOS app and Security green on the branch;
  dispatched on `main`.
- `b0897e8` A lease priority test waits for the supervisor's status, not only the sync
  service's record (it failed under load).
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
  spec below. CI, Security, Linux bundle and macOS app green on `main`. **Installed** on the main development Mac: agent live here (held here: no sync yet),
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

### Code cleanup and a performance pass (started 2026-09-25, evening)

Per the user: internal APIs and module boundaries may change where it clearly helps; the wire
protocol and user-visible behavior stay (perceived-speed improvements welcome). Merged worktrees
and branches were removed (GitHub has only `main`).

- **Audits (report only):** unused TypeScript code and dependencies (knip), duplication and
  oversized modules, the Swift code, docs and config drift. Their findings get implemented after
  the perf branches land, so the two don't fight over the same files.
- **Flaky tests:** done and on `main` (`5687507`): the watcher, subprocess and `trackTasks` tests
  are robust under load (fake timers, event probes instead of sleeps, CPU-time guard, generous
  failure bounds; one test-only `helloTimeoutMs` option). No assertion got looser.
- **Leaner-code cuts** (in flight): `chore/lean-zod` (zod schemas as the single source of the TS wire
  types and generators), `chore/lean-journal` (threads journal-only, with a one-time migration); next the Mac fake daemon, zod as the wire source and journal-only threads (see
  Decisions).
- **Cleanup batch A** (in flight): `chore/cleanup-ts` (two bugs: imported threads kept their old
  note paths because the import looked for journals under the wrong folder, and the approval
  broker could overwrite a newer `approvals.json`; plus dead code, dependency declarations,
  config mistakes), `chore/cleanup-docs` (docs drift, and why push/PR CI triggers don't fire),
  `chore/cleanup-swift` (one link allow-list for the Mac, three behaviors aligned with the web,
  dead code). Batch B (after the perf branches): shared helpers into `@ddl/core`, splitting
  `tools/web.ts`, `shell-commands.ts`, `orchestrator.ts`, `runtime.ts` and `mock-agent.ts`, and on
  the Mac one palette, one scheduler and frame ticker, and the fake daemon using Domain.
- **Performance**, measured first with before/after numbers and budgets: `perf/web` (load, note
  switching, typing in long notes, palette and search on big vaults, long threads, re-renders),
  `perf/mac` (launch, note switching, large notes, long lists, Observation invalidations, main
  thread), `perf/daemon` (startup on large vaults, save-to-event latency, API and search, how
  fast the orchestrator notices a change).

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

## Next up (not started)

- **The Azure VM** (above): the next step once the user is back.
- **CI triggers** (the user, in the repository settings): pushes and pull requests start no
  GitHub Actions runs, and nothing in the repository explains it (details in `docs/CI.md`). Turn
  Actions off and on again for the repository, or disable and re-enable each workflow, then
  check that the next push starts runs; if not, ask GitHub Support. Until then, CI is dispatched
  by hand.
- **B0 binary files:** attachment sync and file serving ([spec](docs/specs/obsidian-migration.md)).
- **P rendering parity:** images (on the drawings' embed layer), tables, callouts, backlinks, on
  the web and the Mac.
- **Agent journal, phase 2:** approvals and routines state on the journal, client ids for
  idempotent relay mutations, compaction, resuming the orchestrator's turn
  ([spec](docs/specs/agent-journal.md)). Phase 1 shipped (`dffdfdd`); the daemon passes the
  lease epoch.
- **The web app in the Mac app?** The Mac app's daemon doesn't serve the web UI (its root says
  to run `pnpm build`); the Linux kit bundles it. Bundling `apps/web/dist` next to the daemon
  would put the latest web app at http://127.0.0.1:7331 with every install. Ask first.
- **Security, delete rules:** `rm -rf /users/<name>` in lowercase only asks instead of hitting
  the "deletes your home directory" hard deny (macOS paths are case-insensitive). Make the delete
  rules match home paths case-insensitively, with eval cases. Known remaining read gaps (from the
  home-folder fix): a single file held in a variable, a project folder's `.env` read recursively,
  subfolders of personal folders, `~/Library/Preferences`.
- **iPhone app:** deferred; the web app covers mobile for now. Plan in
  [apps/mobile/PLAN.md](apps/mobile/PLAN.md). Remote access, device tokens and pairing are built;
  still needed first: full Xcode, a QR code on the pairing screens, and an atomic daily-note
  append in the daemon.
- **Mac:** make sure the floating computer-access guide can't cover the app's controls and closes
  reliably once access is granted.
- **App control:** long, virtualized lists only expose their visible rows (an app showed 11 of 14
  items); teach scrolling or expanding in the tool guidance.
- **Web:** the status bar's save and connection dots still pulse with reduced motion (selector
  specificity).
- **Mac orchestrator window:** bring the typing reveal, activity row and jump-to-latest pill to
  `OrchestratorChatView`, as on the web.
- **Drawings follow-ups:** shared merge vectors for `SceneMerge` (Swift) and
  `mergeDrawingElements` (TypeScript); on the Mac, drawings as accessibility elements, image
  embeds, the in-place tool bar covering a line of text.
- **Swift editor tests crash intermittently on CI** (uncaught NSException, 2 of 3 runs): under
  investigation on `fix/editor-test-crash` (an exception handler to name it, then the root cause).
- **macOS file watching:** Node serves every directory watch in a process from one FSEvents
  stream and restarts it "from now" when a watch opens or closes, so vault changes made during the
  restart are dropped until the next rescan (the daemon too, e.g. when a sync target's watch
  opens). Consider rescanning after any change to the set of watches.
- **Known mock-eval misses** (pre-existing, the suites still pass): safety
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
- **Leaner code** (2026-09-25, evening): the user's priority is reducing the amount of code, by
  narrow cleanups or rethinking architecture. Approved: web e2e, perf and demo on the real daemon
  (delete the in-browser mock); Mac demo and tests on the real bundled daemon (delete the in-memory
  fake daemon); zod schemas as the single source of the TypeScript wire types and test generators;
  agent threads journal-only; delete Swift vim tests the vectors cover; small cuts (S3 and cloud
  stubs, duplicate mock LLM, one forwarding base for the relayed and leased runtimes). Kept: both
  harnesses (Pi and Cursor CLI), the Swift Domain port, the read-only view. The placement toggle
  becomes "Remote" with a switch (on = the always-on machine).
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
