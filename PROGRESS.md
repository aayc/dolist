# Progress

The running handoff log: what shipped, what's in flight, what's next, and the decisions behind
them, so work can continue on any machine at any point. Read it before starting; keep it current
(the rules are in `AGENTS.md`, "Handoff log").

**Last updated:** 2026-09-25, late evening · `main` has everything below merged and pushed; CI was
green on `c158aae` (all four workflows) and is running on the later merges. The build installed on
the main development Mac is `67000e7`: it predates the FSEvents fix, the Mac fake-daemon removal
(new demo mode), the TypeScript cleanups and the docs trim, so rebuild and install when convenient
(see "Installing on the main development Mac"). One branch is in flight (below).

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

## In flight

- **`chore/lean-swift-b`** (Swift narrow cleanups judged by lines removed: one palette in
  DailyDoListUI, one main-actor scheduler and frame ticker, one daemon-home definition shared by
  Client and Daemon, shared test helpers, and the Mac "Remote" switch showing the stored placement
  while held here, like the web). A subagent is working on it in this session in a local worktree
  (`../assistant-worktrees/lean-swift-b`), not pushed yet. If it isn't merged by the handoff, redo
  it from this description (the audit behind it is in git history: this file's earlier versions).

## Shipped on `main` (newest first; older history is `git log`)

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

- **The Azure VM** (the user's next step): the user runs `az login` and saves the Tailscale auth key
  file themselves (credentials never go in the chat or the repo). Check `Standard_D4ps_v6`
  availability, show cost and resources, create them, run `setup.sh`, pair, and verify what only the
  real VM can: the `az` commands, the Tailscale login, and that `tailscale serve` keeps the original
  `Host` (the daemon refuses loopback-Host requests with proxy forwarding headers). Guides:
  `deploy/azure/README.md`, `deploy/linux/README.md`; design `docs/ALWAYS_ON.md`.
- **CI triggers** (the user, in repo settings): turn Actions (or each workflow) off and on, push
  once, check `gh run list --event push`; else GitHub Support. Until then, dispatch by hand.
- **Rebuild and install the Mac app** from current `main` (see above).
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
  by hand on macOS 15+ (it moved to push/pop); iPhone app deferred (`apps/mobile/PLAN.md`: needs
  full Xcode, a QR code on the pairing screens, an atomic daily-note append).
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
- **The Azure VM:** public IP with every inbound port closed; under $120/month: `Standard_D4ps_v6`
  (Cobalt 100 ARM, 4 vCPU, 16 GB, ~$102) + 64 GB premium SSD (~$10) + static IP (~$4); x86
  alternatives `Standard_B4as_v2` or `Standard_D2as_v5`.
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
- **iPhone:** deferred; when it resumes: native Swift, a free Apple ID, Siri and Shortcuts.

## How the parallel work runs

One lead integrates. Each stream gets a brief, a branch and a worktree next to the repo; streams
commit each working piece, never push, merge or rebase (except agents explicitly allowed to push
their own branch to measure CI), and report back; the lead reviews, merges, runs the verification
above, updates this file, pushes and dispatches CI. Agents working next to the running app never
bind or kill its daemon (7331) or the dev server (5173), test in temp dirs and on other ports, and
never touch the real vault or `~/.daily-do-list/`. If a subagent's connection drops, its original
run may keep editing in the background: a resumed agent must check for another writer before
continuing.
