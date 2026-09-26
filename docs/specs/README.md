# Specs

Implementation specs for work split across parallel streams (one branch and worktree each, merged
by one lead). A spec holds what was decided with the user and each stream's scope; the wire
contract is the schemas in `packages/contract/src/wire` ([PROTOCOL.md](../PROTOCOL.md)). Once a
feature is built, its spec keeps only the rationale and what's left: how it works is in the docs
and READMEs it points to. `PROGRESS.md` (at the repo root) says which specs are in flight.

- [always-on.md](./always-on.md) (built; verifying on the real VM pending): the agent anywhere.
- [agent-journal.md](./agent-journal.md) (phase 1 built, phase 2 started): append-only agent
  state, write-ahead for side effects, resuming runs after a handover.
- [obsidian-migration.md](./obsidian-migration.md) (merge-race fix and import built; B0 and P not
  started): moving from Obsidian, attachments, display gaps.
- [routines.md](./routines.md), [drawings.md](./drawings.md),
  [orchestrator-activity.md](./orchestrator-activity.md) (built).

## Environment rules (every stream)

- Work only in your worktree; run every command there and edit files by absolute paths inside it.
  Run `pnpm install --frozen-lockfile --prefer-offline` there first.
- The user's app and daemon are running (127.0.0.1:7331) and a web dev server is on 127.0.0.1:5173.
  Never kill them or bind those ports; never kill Daily Do List processes by name; never run
  `apps/macos/scripts/run-app.sh`; never write to /Applications, `~/.daily-do-list/` or
  `~/DailyDoList/`. Tests use temp dirs and their own ports (`DDL_E2E_PORT` for Playwright); never
  the network or the real model.
- PUBLIC repo: no secrets, tokens, tailnet names, IPs, usernames or absolute paths containing a
  username; examples use placeholders (`vm-name.tailnet-name.ts.net`, `<code>`).
- The machine is often loaded: rerun a timing-sensitive failure alone before concluding it's
  broken; never loosen assertions or budgets.
- Commit each logical piece as soon as it works (conventional commits; hooks run, never bypass
  them). Don't push, merge, rebase or touch other branches or worktrees. If interrupted and
  resumed, run `git status` and `git log --oneline -5` first.
