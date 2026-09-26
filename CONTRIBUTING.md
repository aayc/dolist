# Contributing to Daily Do List

Thanks for helping! Start with [`AGENTS.md`](AGENTS.md), the operating manual for humans and AI
coding agents alike: the architecture, the invariants you must not break, the code conventions,
the testing expectations and every command. This guide covers what it doesn't.

## Setup

You need Node.js ≥ 24.4 (see `.nvmrc`, e.g. `nvm use`), pnpm 10 (`corepack enable` picks the
version pinned in `package.json`) and git. Development happens on macOS or Linux. Computer-use
features are macOS-only, and browser tools use a local Chrome/Chromium.

```sh
corepack enable
pnpm install        # installs dependencies and points git at .githooks/
brew install gitleaks shellcheck actionlint   # the hooks' scanners and linters
```

The pre-commit hook lints what you stage with `scripts/lint.mjs` (the same checks as `pnpm lint`
and CI, including swift-format, which comes with Xcode and the Command Line Tools) and scans it for
secrets; `pnpm lint:fix` applies the formatters. Live agent runs need an OpenRouter key in
`~/.daily-do-list/.env` ([`.env.example`](.env.example) lists the variables). Use `pnpm dev:mock`
for UI work and demos, and point `DDL_VAULT` at a scratch copy, never your own notes, when you
develop agent behavior against a real vault.

## This repository is public

The rules are in `AGENTS.md` ("This repository is PUBLIC"). In practice:

- The hooks block secrets before they leave your machine: the pre-commit hook scans staged files,
  and the pre-push hook scans every commit being pushed (the whole history on a first push), which
  catches commits made with `--no-verify`; it refuses to run without gitleaks. Don't bypass them.
- Committing under a different identity here than elsewhere (say, personal vs. work)? Set it for
  this clone only with `git config user.email <email>`, and add `git config ddl.requiredEmail
  <email>`: the hooks then refuse commits and pushes under any other address.
- A verified false positive gets `secret-scan:ignore` (our scanner) and `gitleaks:allow`
  (gitleaks) on that line, justified in the PR.
- Committed a real secret by accident? **Rotate it immediately.** Public history is copied within
  minutes, and rewriting it doesn't help. Then tell the maintainers privately (see
  [`SECURITY.md`](SECURITY.md)).

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`. Types:
  `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style` (formatting
  only), `revert`. Scopes are package or app names (`core`, `contract`, `storage`, `editor`,
  `agent`, `connectors`, `web`, `daemon`, `sync`, `evals`, `macos`), `deploy` (the always-on
  machine's kit), `progress` (the handoff log, `PROGRESS.md`), or `ci` and `deps`. The commit-msg
  hook checks the subject.
- Before opening a PR, run `pnpm check` plus the bench, e2e and eval commands relevant to your
  change ([`docs/CI.md`](docs/CI.md) explains every CI job and how to reproduce it). Keep PRs small
  and focused, and fill in the template, including the perf and safety impact sections (raising a
  budget needs a justification there). CI must be green.
- If the PR resolves a Linear ticket, put `Resolves <ID>` in the PR body.

## Issues and security reports

Use the issue templates for bugs and feature requests. Never report security vulnerabilities in
public; follow [`SECURITY.md`](SECURITY.md) instead.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree
that your contributions are licensed under the [MIT License](LICENSE).
