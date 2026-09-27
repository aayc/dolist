# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-27 · The existing Linux VM runs the remote Cursor agent on `09e13dc`,
paired with the other development Mac, whose bundled daemon is now `67a488b` (quit-sync fix
integrated on `main` as `cf1807c`). Real remote-task, approval, artifact, reboot, bidirectional
handover and app-close/reopen checks passed.
The main development Mac's installation remains `401997a`.
The full native iPhone implementation plan is also on `main` (`40e1b29`); the user has now
authorized implementation and thorough simulator testing in its separate task.

## Picking this up

1. Clone, then `pnpm install` (Node ≥ 24.4, pnpm 10). The git hooks install themselves; they need
   `gitleaks`, `swift-format`, `shellcheck` and `actionlint` on PATH. The macOS app builds with the
   Command Line Tools (Swift 6).
2. Secrets are never in the repo: recreate `~/.daily-do-list/.env` (for example
   `OPENROUTER_API_KEY`) and sign the Cursor CLI in (`agent login`) for the Cursor harness.
3. macOS app: `apps/macos/scripts/signing-identity.sh` creates the local signing identity so macOS
   keeps granted permissions across builds; on a new Mac, create it, build, then grant
   Accessibility and Screen Recording (Settings → Computer Use guides you).
4. Fast loop: `pnpm test:changed` / `pnpm check:changed` (only what changed since `main`),
   `apps/macos/scripts/test.sh --changed` (only affected Swift packages; `--list`, `--since REF`,
   `--thorough`). `pnpm check` is the full gate (a few seconds warm).
5. CI doesn't start on push or pull requests (declared, but GitHub hasn't fired them since the
   first push; `docs/CI.md`). Dispatch it on a branch before merging and on `main` after pushing:
   `gh workflow run ci.yml --repo aayc/dolist --ref <branch>` (also `macos.yml`, `security.yml`,
   `linux-bundle.yml`). Branch runs replay cached results for unchanged inputs; `main` reruns
   everything with `DDL_TEST_THOROUGH=1`; the release app builds on `main` or with `-f release=true`.

### Verifying a merge (what the lead ran today)

`pnpm check`; `pnpm build && pnpm size:check`; `pnpm --filter @ddl/daemon build` (its lazy-load
check); `pnpm eval:mock`; `pnpm e2e` (plus `pnpm e2e:perf` for UI changes, `pnpm vim:check` for
editor/vim); `apps/macos/scripts/test.sh --changed --since <last verified main>` (it includes the
integration tests when the daemon changed); then push and dispatch the four workflows. Under heavy
machine load Vitest can report "Failed to start forks worker"; rerun that package alone.

### Installing on the main development Mac

Only when `/api/agent/status` shows running 0, queued 0 and no pending approvals. Build into /tmp
(`apps/macos/scripts/build-app.sh --release --with-daemon --output /tmp/ddl-app-<sha>`), quit the
app gracefully (`osascript -e 'tell application "Daily Do List" to quit'`), move the old app to
/tmp as a backup, `ditto` the new one into /Applications, `codesign --verify --deep --strict`, open
it, then check the agent status, that `/api/threads` still lists every thread, and that app control
is still granted. Never kill Daily Do List processes by name; never bind or kill 127.0.0.1:7331
(its daemon) or 5173.

### Setup on another development Mac (2026-09-27)

- Installed the pinned workspace dependencies, Chromium, shellcheck, actionlint, gitleaks and Swift
  toolchains. Builds use Swift 6.3.3 with Swift 6.2.4's formatter (the newer standalone formatter
  rejects this checkout's configuration). New login/interactive shells select that toolchain.
- Both clients are running against the same local daemon and vault; the signed Mac app and its
  bundled daemon/helper are installed in Applications. The app supervises the daemon and serves
  the web UI at http://127.0.0.1:7331 (the temporary dev servers are stopped). The private app
  configuration uses the existing model credential and the checkout's built web UI. macOS
  permissions for controlling other apps remain user-granted through Settings → Computer Use.
- Passed: `pnpm check`, all production builds, bundle budgets, six web startup e2e tests,
  `pnpm vim:check`, 173 native Vim tests, 300 native editor tests and 29 daemon integration tests.
  CI, macOS (including release packaging and iOS builds), Security and Linux bundle workflows are
  green on merged setup commit `78ae584`. The native app test process crashed once on an unowned
  reference; its targeted retry passed. The source-branch CI and macOS runs also passed.
  Local Swift 6.3 tests need `-- -Xswiftc -target -Xswiftc arm64-apple-macosx15.0` because its
  Testing library requires macOS 15. The local app test target still fails to compile an existing
  `CGWindowListCreateImage` snapshot under that override; its CI run passes with Apple's toolchain.

### Remote Linux cutover (2026-09-27)

- Reused the existing x64 VM, with Node 24 and the Linux setup kit. Retired containers, their
  restart policies, nginx and certificate-renewal jobs are disabled; their data and private
  rollback configuration remain. The first subscription's backup storage is unchanged.
- Preserved the existing tailnet identity; HTTPS proxies expose only the daemon and sync service
  to the tailnet. Public inbound traffic is denied. State lives on the managed data disk, mounted
  independently of Azure's temporary disk; both services require its bind mount. The first reboot
  exposed an ordering cycle, now fixed; the second boot started storage and services automatically.
- The other development Mac is paired and synced, with Remote on and the live agent enabled.
  The user's model and approval settings remain. Private setup, evidence and rollback details
  live outside the repository. The existing tailnet key's expiry is unchanged; the private
  runbook records its renewal date. Linux supports shell/browser execution, not macOS app control.
- Real checks: local `uname -s` returned Darwin, remote returned Linux under the service user;
  Chromium read a public page; denied and accepted approvals traveled through the native Mac app;
  the Mac displayed a remote artifact; notes and history synced; an outage did not execute work
  locally, and its queued task ran after recovery. One task thread then continued from Mac to
  Linux. Completed unchecked tasks retained their IDs and did not repeat after the handover fix.
- Fix `09e13dc` reproduced the missing-tracker problem in a two-daemon regression before fixing
  it; all four branch workflows passed. Also passed `pnpm check`, production builds/budgets,
  mock evals, and the Linux bundle smoke test on the actual host. Both installed clients retain
  their prior versions for rollback. Main workflows are dispatched after the handoff update.
- Cursor CLI is installed and browser-authenticated under the remote service account. The
  paired app now uses the Cursor harness with its existing Claude Opus 5.5 selection and
  approval policy; OpenRouter remains available for the safety judge. A task entered in the
  native Mac app ran Linux shell commands and opened a real Chromium page on the remote host,
  with successful tool results displayed in its thread. Setup credentials remain private.
- Active Cursor work continued after quitting the Mac app: a delayed shell command finished,
  then a new browser action ran, and reopening restored the same completed task without a repeat.
  A separate immediate-quit race was reproduced and fixed: relaying clients now make a final
  sync pass before shutdown cancels their pending note-sync debounce. The updated Mac app passed
  a real paste-and-immediately-quit check; its new task ran remotely while the app stayed closed.
  Local checks, production builds/budgets and all four branch workflows passed (the existing
  native Vim timing flake passed on retry). Physical laptop sleep was not performed. Main
  workflows are dispatched after this update; private evidence and the prior app remain available.

## In flight

- Full native iPhone app: `codex/iphone-app`, checkpoint `6c19850` pushed, with current main
  host-continuity fixes merged. Native pairing/Keychain, identity guard, durable notes/composers/
  captures, Inbox/agent UI and shared native drawing engine are integrated. Real simulator CUA
  passed HTTPS pairing, task→mock-agent result/artifact, capture, offline edit→terminate/relaunch,
  and reconnect with a disjoint remote edit preserved. The simulator's missing Keychain identity
  was found through CUA and fixed with a simulator-only ad-hoc identity (no paid account).
- Full features remain in progress. Parallel streams: `codex/iphone-backend` supplied identity,
  capture, fenced action receipts and notification catch-up; `codex/iphone-agent-actions` supplied durable action IDs in AgentCore. `codex/iphone-repository` supplied offline caches,
  structural transactions and recovery/export/forget, and durable drawings; it now wires bounded thread/artifact caches into AgentCore and native views.
  `codex/iphone-drawing` supplied the canvas, embedded images/arrangement and complete settings/host UI; it now owns remaining drawing parity. The user explicitly excluded
  iPhone Vim; its isolated unfinished work is not integrated. The integrator owns composition,
  notes navigation/content, platform integration, CI and thorough CUA. Shared settings, explorer,
  history/calendar navigation, search and recovery UI are integrated; CUA passed creation, search,
  back/forward, theme save, accessible rename and soft deletion with text retained in Trash.
  Standalone drawing composition/recovery, frame/point/grid controls, clipboard/library and bounded
  SVG transfer are integrated. CUA passed text creation, save, undo/redo, offline editing and relaunch,
  then reconciliation with a separate remote shape; both changes reached the synthetic host. CUA
  dragging remains under investigation despite a passing real-touch native UI test. Binary attachments
  now preserve bytes across providers/sync and have authenticated bounded APIs. Bounded thread/artifact
  cache foundations are integrated; native cache UI and App Intents/local notifications are in flight.
  Root next owns note content/embeds, living-list UI, navigation/downloads and final composition.
- Foundation CI and macOS workflows passed on `a972928`. Local `pnpm check`, signed simulator
  suite (59 tests), MobileKit and physical iPhone SDK build passed at the composition checkpoint.
  Web CI passed on `6e31cd0`; all native/iPhone jobs passed except a coalesced-event timing
  assumption in relay integration. The assertion is fixed and passed against isolated real daemons;
  new CI/native/security/Linux checks are dispatched on `6c19850`. The latest local native suite and
  full repository check pass, using serial package execution for timing-sensitive checks. The Mac window-opening budget failure is
  reproduced on the unchanged local baseline (~6.4 s); it passes CI, and no budget was widened.
  Scope: `docs/specs/iphone-implementation-streams.md`; durable instruction and evidence:
  `apps/mobile/IMPLEMENTATION.md`. The user asked to finish faster while retaining complete tests
  and CUA; use focused incremental checks and keep the full release gates.
  Work uses isolated checkouts, synthetic vaults and separate test daemons; the installed Mac
  app, its daemon and the real vault remain untouched. Physical-device checks remain distinct.

Local web/Mac setup is complete, with all four workflows green on `78ae584`.
The remote-machine setup is complete, including the handover correction found during live testing.
Native iPhone implementation is authorized and continues separately, including simulator testing.

## Shipped on `main` (newest first; older history is `git log`)

- `cf1807c` Relaying clients flush their last saved notes on quit, so a task entered just before
  closing the app can reach the always-on host without waiting for the next launch. Installed
  in the paired Mac's daemon and verified with a regression plus actual Cursor execution.
- `fffb5b7` Leased agent handovers now sync task identities and settled snapshots, preventing
  completed unchecked tasks from running again under fresh IDs. Folder sync retains its
  device-local tracker behavior. Installed and verified on the paired Mac and Linux host.
- `531d8d7` Native toolchain compatibility: explicitly discard Vim's returned callbacks and keep
  the undo action's captured manager on the main actor. Built, installed and verified both clients
  on another development Mac.
- `40e1b29` Full native iPhone implementation plan, with no mobile implementation changes.
- `401997a` Swift cleanups (−699): one palette, scheduler, frame ticker and daemon-home definition
  (`DaemonHome` in Models, the stricter port/home rules), shared Swift test helpers, the Mac "Remote"
  switch shows the stored placement while held here (like the web). **Installed.**
- `e5877cb` Docs trimmed (−2.3k): specs of built features keep only rationale and what's left;
  READMEs link the generated protocol reference, the shared test tables and `SAFETY_RULES`.
- `6bb69fe` TypeScript cleanups (−750): shared helpers in `@ddl/core` (`errorMessage`, `isRecord`,
  `raceAbort`, `pluralize`, `formatBytes`, `Listeners`, one `.env` parser), storage's 3-way merge on
  core's line diff (identical on 200k random merges), a shared web chat hook.
- `c158aae` The Mac demo and tests use the real daemon (−6.1k): demo mode runs the bundled daemon
  with the mock agent on a throwaway vault (`DDL_DEMO=1`, shared with `pnpm dev:mock`); one shared
  `FakeDaemonClient`; the in-memory fake daemon is gone.
- `85494a4` No external edit is lost while macOS restarts its FSEvents stream (a new watch waits for
  the stream; other watchers rescan once when a watch opens or closes, ~12 ms at 2,000 notes).
- `67000e7` zod schemas are the single source of the TS wire types, generators and one route table
  (−3.3k; invariants 4/5 reworded); threads are journal-only with a one-time migration (it ran on the
  real vault: 15 threads matched a backup); Mac performance (the explorer was quadratic: window
  ~4 s → <200 ms, a new note 2–3 s → ~30 ms, launch halved); Swift cleanup (one link allow-list).
- `24217b7` Faster tests and CI: warm CI 36 s (was ~7 min), warm macOS 2m13s (was 19.5 min),
  changed-only local commands, ~5.4k test lines pruned.
- `e1a2f6e` Editor crash fixed (legacy scroll bars: layout while the text storage was editing).
- `7f1f796` Imported threads keep their new note paths; the approval broker persists safely.
- `cf0d413`, `0011be4`, `75ce44d`, `f78a4e9` Leaner code: compact Swift vectors and test trims
  (−75.6k), web e2e/perf/demo on real daemons and the in-browser mock deleted (−6.9k), S3/cloud
  stubs and duplicates gone (−1.1k), Swift vim tests the vectors cover gone (−6.1k).
- `c7ca463` The orchestrator placement is a "Remote" switch (web and Mac).
- `aa70f6a` Web and daemon performance (event bursts batched per frame, windowed explorer and chats,
  daemon restarts 2x faster, search 14x faster at 10k notes, request-like lines settle in ~0.9 s).
- `b220dd2` Patched `nanoid` and `lodash-es` (Dependabot: 0 open alerts).
- `e2fd3ce` Import from Obsidian (web and Mac). Still to try for real: the switch in the running Mac
  app and a large real vault.
- `052dcc8` Drawings (Excalidraw-compatible, web and native Mac engine, the agent sees them).
- `3f69ea2` Orchestrator activity on any line (chips, header, status bar).
- `7ce1e9f` The agent anywhere (always-on machine, placement, pairing, relay, fencing, Linux kit).
- Earlier: agent journal phase 1 (`dffdfdd`), routines (`a42bcf3`), the orchestrator's chat,
  approval policies, chat polish, computer use on the Mac, the sync service.

## Next up

- **CI triggers** (the user, in repo settings): turn Actions (or each workflow) off and on, push
  once, check `gh run list --event push`; else GitHub Support. Until then, dispatch by hand.
- **B0 binary files** (attachment sync, file serving) and **P rendering parity** (images on the
  drawings' embed layer, tables, callouts, backlinks) — `docs/specs/obsidian-migration.md`.
- **Agent journal phase 2** (approvals and routines state on the journal, client ids for idempotent
  relay mutations, compaction, resuming the orchestrator's turn) — `docs/specs/agent-journal.md`.
- **Ask the user:** bundle `apps/web/dist` into the Mac app so the latest web app is served at
  http://127.0.0.1:7331 (today the Mac app's daemon doesn't serve the web UI; the Linux kit does).
- **Security:** delete rules should match home paths case-insensitively (`rm -rf /users/<name>`
  only asks); remaining read gaps: a file in a variable, a project `.env` read recursively,
  subfolders of personal folders, `~/Library/Preferences`.
- **Smaller product items:** the floating computer-access guide can cover app controls; app control
  sees only visible rows of virtualized lists; reduced-motion dots still pulse on the web; bring the
  typing reveal / activity row / jump pill to the Mac orchestrator window; drawings follow-ups
  (shared merge vectors for `SceneMerge` and `mergeDrawingElements`, accessibility, image embeds);
  the Mac refuses hostless `http:` links while the web allows them; check the pointing-hand cursor
  by hand on macOS 15+ (it moved to push/pop); iPhone implementation is now in flight (see `apps/mobile/IMPLEMENTATION.md`).
- **Performance leftovers:** web inbox renders every row (21 ms at 300), search waits for its 180 ms
  debounce, each approval re-renders ~33 components, core's drawing parser is in the startup bundle
  (6.7 kB gz), the switcher lowercases every name per key; Mac tab switch to a 2,000-line note
  restyles the whole note (~88 ms debug) and the chat rebuilds all rows per token; daemon sync
  re-walks both sides per change (~104 ms CPU at 2,000 notes), a large vault's first-ever start,
  a 1.17 MB tree response at 10k notes.
- **Leaner code, still possible:** consolidate the agent's integration tests (scenarios, journeys,
  top-level tests overlap; ~−2k, case by case); derive the persisted settings schema from the wire
  one; CodeQL could skip test code (halves it, loses findings in test code).
- **Known flakes under heavy machine load** (pass alone): vim perf tests with 1 ms budgets; a relay
  test reads agent status right after a lease handover; `app.spec.ts` "Mod+Shift+D creates today's
  note" failed once. Also: agent actions on background browser tabs wait out a 5 s screenshot
  timeout (headless Chrome doesn't render them); the agent status can briefly show the new placement
  with the old "running on …" line; the placement tooltip hides if a sync pass lands while hovering.
- **Mock-eval misses** (pre-existing, suites pass): safety `coding-npm-test`,
  `coding-run-analysis-script` (over-approvals, no false allows).

## Decisions (so nobody asks again)

- **Safety before autonomy:** every tool call passes the gate; approval policy has four levels
  (default: ask for risky actions); hard denies always apply. Agents reading a `.env` to run a
  project follows the approval policy; still hard denies: sending secrets off the machine, the
  daemon's token files, credential stores, shell histories, sweeping the home folder.
- **Computer use** runs on our own tools (`ddl-computer` and the execution tools), never a harness's
  built-ins; the Cursor CLI reaches ours over the MCP bridge. Both harnesses (Pi, Cursor CLI) stay.
- **The agent anywhere:** an Azure Linux VM reached only over Tailscale, no Azure power management
  in the app; where the agent runs is chosen per device and everything it needs syncs so it can
  move. The control is one "Remote" switch (on = the always-on machine), disabled with the reason
  and a set-up link while held here, with "Run it on this device instead" when the machine is
  unreachable; Settings shows each machine's readiness so a move never fails silently.
- **Fencing:** the sync service enforces the lease epoch on every write, delete and rename of the
  agent's files; a former holder's stale agent changes are dropped (never a conflict copy);
  `settings.json` isn't an agent file; every device must run a fencing daemon (`docs/SYNC.md`).
  Journaling is not Temporal; threads are journal-only now.
- **The Azure VM:** reuse the existing x64 `Standard_D2s_v3` (2 vCPU, 8 GiB) in the second
  Visual Studio subscription, superseding the new ARM VM plan. Preserve its Tailscale identity
  and old application data while retiring those services; every public inbound port stays
  closed. The user approved transferring the existing model credential over SSH to the service's
  private environment file. The first subscription's backup storage stays as it is.
- **Routines:** one markdown file per routine in `Routines/`, each run a chat thread with
  notifications (always, when changed, never); approvals follow the global policy; "Repeat this"
  takes the user's schedule; a missed run catches up once; Run now has a daily budget; starter
  templates live in `packages/core/src/routines.ts`.
- **Orchestrator activity** on any line, not only checkboxes (the user wanted the triaging badge
  everywhere).
- **Drawings:** Obsidian Excalidraw plugin format and embed syntax; floated right with text
  wrapping by default; the real Excalidraw on the web, a from-scratch native engine on the Mac (the
  user's choice, for speed) that keeps unsupported elements untouched; the agent sees a text
  description plus an image for vision models.
- **Moving from Obsidian:** by copying the vault (not sharing the folder); import with a report,
  carry-over and a switch, plus Update from Obsidian; then images, tables, callouts, backlinks,
  attachment sync.
- **Web bundle:** Total JS budget 1,300 kB gzip (lazy chunks included); startup stays guarded by the
  320 kB initial JS budget.
- **Leaner code** (the user's priority since 2026-09-25 evening): judge changes by lines removed.
  Done: real daemons instead of both fake daemons, zod as the wire source, journal-only threads,
  test and docs trims. Kept: both harnesses, the Swift Domain port, the read-only view.
- **Tests:** one good test per behavior at the cheapest layer that protects it; regression tests for
  real bugs; no redundant layers (the user thinks we overtest). CI branch runs reuse cached results;
  `main` runs everything thoroughly.
- **iPhone:** full native implementation authorized on 2026-09-27, superseding the earlier
  planning-only instruction. The user has no paid Apple developer account and will be away for
  several days. Continue autonomously until the full app is implemented, tested and thoroughly
  checked through computer-use. Preserve this instruction across compaction. Use the free-account
  baseline; never claim physical-device or paid-entitlement checks were run when unavailable.
  **Later scope decision:** do not implement Vim on iPhone at all. No phone Vim mode, settings,
  vimrc or acceptance work; preserve existing Mac/web Vim.
  Plan: `apps/mobile/PLAN.md`; execution/evidence ledger: `apps/mobile/IMPLEMENTATION.md`.

## How the parallel work runs

One lead integrates. Each stream gets a brief, a branch and a worktree next to the repo; streams
commit each working piece, never push, merge or rebase (except agents explicitly allowed to push
their own branch to measure CI), and report back; the lead reviews, merges, runs the verification
above, updates this file, pushes and dispatches CI. Agents working next to the running app never
bind or kill its daemon (7331) or the dev server (5173), test in temp dirs and on other ports, and
never touch the real vault or `~/.daily-do-list/`. If a subagent's connection drops, its original
run may keep editing in the background: a resumed agent must check for another writer before
continuing.
