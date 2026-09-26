# Spec: routines (standing jobs the agent runs on a schedule)

Status: built (`a42bcf3`).

Repo: Daily Do List. Read AGENTS.md first (invariants: safety gate on every tool, provider
registries, `@ddl/core` pure, local-first plain files, wire changes update core + contract + Swift
models together, time is local; web and macOS control rules; testing: ScriptedHarness /
MockLlmClient, never the real model or network; fake clocks for time). Then docs/AGENT_SYSTEM.md,
packages/agent/src/orchestrator/ (orchestrator, subagents, the orchestrator chat), runtime.ts, the
thread store, packages/agent/src/safety/ (the approval policy in approval-policy.ts and the gate),
and the clients' inbox/threads (apps/web/src/features/agent/, apps/macos/Packages/DailyDoListAgent/).

## Decided with the user

- **Definitions live in the vault**: one markdown file per routine in `Routines/` (top level of the
  vault). Frontmatter:
  ```markdown
  ---
  schedule: every weekday at 7:30      # natural language, local time
  notify: when changed                 # always | when changed | never (default: always)
  uses: [web, connectors]              # optional capability hints; otherwise triaged like a task
  paused: false                        # optional
  ---
  Brief me for the day: my calendar, SF weather, what I didn't finish yesterday, and anything new
  from my news sources. Under 10 lines.
  ```
  Plain files: editable in Obsidian, synced, versioned. The body is the instructions. Parse the
  schedule into a structured recurrence (every day / weekdays / specific weekdays / every N hours
  or minutes (minimum 15 min) / monthly on a day / at times); unsupported phrases are an error shown
  on the routine, never a guess. Invalid files never crash anything.
- **Each run is a chat thread**, like a task's: the user can reply ("try again with …"), and it
  shows up with the chat polish (typing reveal, activity row). A run gets the routine's
  instructions and a compact summary of the previous run's result, so it can say what's new; with
  `notify: when changed` it reports whether anything changed (e.g. via its finish summary/tool), and
  the notification only fires when it did.
- **Approvals follow the user's global approval policy** (ask_every_action … run_everything),
  like any agent action; a waiting approval notifies as usual. Agents creating or editing routine
  files also just follow the policy (the user chose no special guard).
- **Results and UI**: a **Routines** section (web and macOS) listing routines (name = file name,
  schedule in words, next run, last run's status, paused state, errors). Selecting one shows its
  own inbox of runs (threads, newest first) with **Run now**, **Pause/Resume**, **Edit** (opens the
  file in the editor), and **New routine** (from starter templates: morning briefing, weekly review
  (Sunday, from the week's daily notes), carry over unfinished tasks, price/availability watch, news
  digest, inbox triage). Notifications when a run finishes (per `notify`). Runs do not clutter the
  main task inbox (they live under their routine), but a run waiting on approval surfaces like any
  approval.
- **Creation by saying it**: the orchestrator learns to turn "every morning, brief me on …" (in a
  note or its chat) into a routine: it proposes the routine (schedule in words + what it will do)
  and, per the approval policy, writes the file with a new tool (e.g. `create_routine` / update /
  pause / run_now / list). Finished task threads get a **Repeat this** action that opens a
  prefilled "new routine" (user-initiated; the user confirms the schedule).
- **Where and when it runs**: a scheduler in the daemon's agent runtime; runs only when the agent is
  enabled and (with sync) this device holds the agent lease; after the laptop sleeps or the daemon
  restarts, a missed run catches up once (not once per missed slot). Per-routine budget: at most a
  few runs per day beyond the schedule (Run now included) and a maximum run time; state (last run,
  next run, last result summary, run history ids) in the sidecar (`.daily-do-list/`), never in the
  routine file.

## Wire

Whatever clients need (routine list/status, a thread's routine id, run now/pause/resume routes,
routine events over the WebSocket) goes through `packages/core/src/protocol.ts`, `packages/contract`
(schemas, fixtures, arbitraries, docs/PROTOCOL.md via its generator) and `DailyDoListModels` in the
same change. Keep additions optional/additive so older clients still decode.

## Safety

- Routine runs' tool calls pass the gate like any agent's; nothing about routines bypasses it.
- The new orchestrator tools have honest hints and `describe()` for approval cards ("Create routine
  “Morning briefing”: every weekday at 7:30"); writing `Routines/*.md` is a vault note write that the
  gate evaluates under the policy. Add safety eval cases for them.
- The scheduler can't be driven by agents beyond those gated tools (no path to change the sidecar
  state; hard denies on `.daily-do-list/` already cover it — add a regression test).

## Tests and docs

- Schedule parsing (table tests incl. DST boundaries, weekdays, invalid phrases), next-run
  computation with a fake clock, catch-up after sleep (once), pause/resume, budget, lease/enabled
  gating, run threads recorded with the previous summary, `notify: when changed` behavior,
  file edits picked up live (watcher), invalid files reported; orchestrator tools through the gate
  (ScriptedHarness) under different policies; mock brain + triage/eval cases for "every morning …"
  so `pnpm eval:mock` stays deterministic and green.
- Web unit + Playwright e2e (real keyboard): the Routines section, a routine's runs, Run now,
  Pause, New routine from a template, Repeat this. macOS: store/view tests with fakes, snapshots,
  tooltip tests, commands (palette/menu: "New Routine…", "Show Routines").
- Docs: docs/AGENT_SYSTEM.md (routines), docs/USER_JOURNEYS.md (next free J-number: a morning
  briefing routine created by saying it; a watch that only notifies on change), README features,
  the daemon README (routes/events), web and macOS docs, AGENTS.md (repo map / how-to if useful).

## Environment rules (strict)

- Work only in your worktree; run every command there and edit files by absolute paths inside it. Run `pnpm install --frozen-lockfile --prefer-offline` there first.
- The user's app and daemon are running (127.0.0.1:7331) and a web dev server is on 127.0.0.1:5173.
  Never kill them or bind those ports; never kill DailyDoList processes by name; never run
  `apps/macos/scripts/run-app.sh`; never write to /Applications, `~/.daily-do-list/` or
  `~/DailyDoList/`. Tests use temp dirs and their own ports; if Playwright's default port is busy,
  use a temporary config with another port and don't commit it.
- The machine is often loaded: rerun a timing-sensitive failure alone before concluding it's
  broken; never loosen assertions or budgets.
- Commit on your branch with conventional commits (hooks run; never bypass them). Don't push,
  merge, rebase or touch other branches or worktrees.
