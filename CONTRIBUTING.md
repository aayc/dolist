# Contributing to Daily Do List

Thanks for helping! Start with [`AGENTS.md`](AGENTS.md), the operating manual for humans and AI
coding agents alike. It covers the architecture, the invariants you must not break, and the code
conventions. This guide covers the day-to-day workflow.

## This repository is public

- Never commit secrets, tokens, `.env` files, personal notes, vault content, agent state
  (`.daily-do-list/`), browser profiles, shell history, or absolute paths containing your username.
- API keys belong in `~/.daily-do-list/.env` (outside the repo) or your shell environment. See
  [`.env.example`](.env.example) for the variables. Code reads them from `process.env` at runtime
  and never logs them.
- Test fixtures, examples, screenshots and demo notes must be synthetic: no real names, emails,
  addresses or notes.
- The git hooks (installed by `pnpm install`) block secrets before they leave your machine: the
  pre-commit hook scans staged files with `scripts/check-secrets.mjs` and gitleaks, and the pre-push
  hook scans every commit being pushed (the whole history on a first push) with both, which catches
  commits made with `--no-verify`. The pre-push hook requires gitleaks, so install it with the
  linters: `brew install gitleaks shellcheck actionlint`. CI repeats the checks and scans the full
  history with gitleaks. Don't bypass the hooks with `--no-verify`.
- Committing under a different identity here than elsewhere (say, personal vs. work)? Set it for this
  clone only with `git config user.email <email>`, and add `git config ddl.requiredEmail <email>`:
  the hooks then refuse commits and pushes under any other address.
- Verified false positive? Add `secret-scan:ignore` (our scanner) and `gitleaks:allow` (gitleaks) to
  that line, and justify it in the PR.
- Committed a real secret by accident? **Rotate it immediately.** Public history is copied within
  minutes, and rewriting it doesn't help. Then tell the maintainers privately (see
  [`SECURITY.md`](SECURITY.md)).

## Setup

You need Node.js ≥ 24.4 (see `.nvmrc`, e.g. `nvm use`), pnpm 10 (`corepack enable` picks the
version pinned in `package.json`) and git. Development happens on macOS or Linux. Computer-use
features are macOS-only, and browser tools use a local Chrome/Chromium.

```sh
corepack enable
pnpm install        # installs dependencies and points git at .githooks/
brew install gitleaks shellcheck actionlint   # the hooks' scanners and linters
```

The pre-commit hook also lints what you stage with `scripts/lint.mjs`, the same checks as
`pnpm lint` and CI: file hygiene (conflict markers, line endings, whitespace, big files, broken
relative links), Biome, swift-format (it comes with Xcode and the Command Line Tools), shellcheck,
actionlint, and the Swift test vectors when their inputs change. `pnpm lint:fix` applies the
formatters.

Live agent runs need an OpenRouter key. Put `OPENROUTER_API_KEY=...` in `~/.daily-do-list/.env`.

## Development workflow

| Task | Command |
| --- | --- |
| Daemon + web UI with the live agent | `pnpm dev`, then open http://localhost:5173 |
| Same, with the deterministic mock agent (no key, no model calls) | `pnpm dev:mock` |
| Production build and run | `pnpm build && pnpm start`, then open http://127.0.0.1:7331 |
| Lint / auto-fix | `pnpm lint` / `pnpm lint:fix` |
| Typecheck / unit tests | `pnpm typecheck` / `pnpm test` |

Use `pnpm dev:mock` for UI work and demos. When developing agent behavior against a real vault,
point `DDL_VAULT` at a scratch copy rather than your own notes. While iterating, scope commands to
the package you're changing, e.g. `pnpm --filter @ddl/core test` or
`pnpm exec biome check --write packages/core`.

## Conventions

[`AGENTS.md`](AGENTS.md) is authoritative. In short:

- Strict TypeScript, ESM only. No enums, namespaces or constructor parameter properties. Named
  exports, kebab-case file names, Biome formatting (2 spaces, double quotes, width 100).
- Respect the invariants: every tool call passes the safety gate, Pi imports stay inside
  `packages/agent/src/harness/`, backends are selected only in provider registries, `@ddl/core`
  stays pure, the wire protocol lives in `packages/core/src/protocol.ts`, the daemon is local-only
  (unless remote hosts are configured, then only through a private network with device credentials)
  and authenticated, agents don't silently edit notes, the keystroke path stays O(line), and dates
  are local.
- Libraries take a `Logger` instead of calling `console.log`, and never log secrets or note
  contents at `info`.

## Testing, performance and evals

- **Unit tests** are colocated (`foo.test.ts`), and every bug fix gets a regression test. Tests
  never hit the network or the real model (use `MockLlmClient` / `ScriptedHarness`), never touch
  your real vault, and clean up their temp dirs.
- **Benchmarks:** hot paths get a `*.bench.ts` whose p99 budget is scaled by
  `BENCH_BUDGET_MULTIPLIER`. Run `pnpm bench && pnpm bench:check`.
- **UI:** Playwright functional tests (`pnpm e2e`) and perf tests with budgets (`pnpm e2e:perf`),
  see `docs/PERFORMANCE.md`. PRs that touch the UI include before/after perf numbers.
- **Bundle size:** `pnpm build && pnpm size:check`. The budgets are at the top of
  `scripts/bundle-size-check.mjs`.
- **Agent behavior:** new safety rules or triage behavior need eval cases in `evals/datasets/`.
  `pnpm eval:mock` must stay deterministic and green. Run `pnpm eval` (live, needs the key) when you
  change prompts or the safety judge.

Before opening a PR, run `pnpm check`, plus the bench, e2e and eval commands relevant to your change.
[`docs/CI.md`](docs/CI.md) explains every CI job and how to reproduce it locally.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for
  example `feat(agent): …`, `fix(web): …`, `perf(editor): …`, `docs: …`. Types: `feat`, `fix`,
  `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style` (formatting only), `revert`.
  Scopes are package or app names (`core`, `storage`, `editor`, `agent`, `connectors`, `web`,
  `daemon`, `evals`, `macos`) or `ci` and `deps`. The commit-msg hook checks the subject.
- Keep PRs small and focused, and fill in the template, including the perf and safety impact
  sections. CI must be green.
- If the PR resolves a Linear ticket, put `Resolves <ID>` in the PR body.

## Issues and security reports

Use the issue templates for bugs and feature requests. Never report security vulnerabilities in
public; follow [`SECURITY.md`](SECURITY.md) instead.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree
that your contributions are licensed under the [MIT License](LICENSE).
