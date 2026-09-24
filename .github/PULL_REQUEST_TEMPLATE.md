## Summary

<!-- What does this change do? Keep PRs small and focused. -->

## Why

<!-- The problem or motivation; link the issue or discussion.
     If this resolves a Linear ticket, add a line: Resolves ABC-123 -->

## How tested

<!-- Commands you ran and what you verified by hand. New behavior needs tests; every bug fix needs a
     regression test. -->

## Perf impact

<!-- Required for UI, editor or keystroke-path changes: before → after numbers from
     `pnpm bench && pnpm bench:check`, `pnpm e2e:perf` (apps/web/perf-results.json) and/or
     `pnpm build && pnpm size:check`. Otherwise write "None". -->

| Metric | Before | After |
| --- | --- | --- |
|  |  |  |

## Safety impact

<!-- Tools added or changed (name + ToolSafetyHints), safety rules/policy touched, new approval paths,
     anything that lets agents act with less oversight, and the eval cases you added in
     evals/datasets. Otherwise write "None". -->

## Screenshots

<!-- UI changes: before/after screenshots or a short clip. Synthetic notes only, no personal data. -->

## Checklist

- [ ] `pnpm check` passes locally (lint, typecheck, unit tests, secret scan)
- [ ] Ran what's relevant: `pnpm bench && pnpm bench:check`, `pnpm e2e`, `pnpm e2e:perf`, `pnpm eval:mock`
- [ ] Tests added or updated (a regression test for every bug fix)
- [ ] No secrets, tokens, `.env` files, personal notes, vault content, agent state or absolute paths with a username — this repository is **public**
- [ ] Every tool still runs through the safety gate (`beforeToolCall`); new tools declare honest `ToolSafetyHints`
- [ ] Docs updated (`AGENTS.md`, `docs/`) if a convention, setting or workflow changed
- [ ] PR title is a conventional commit (`feat(agent): …`, `fix(web): …`, `perf(editor): …`)
- [ ] `Resolves <LINEAR-ID>` is in the description if this resolves a Linear ticket
