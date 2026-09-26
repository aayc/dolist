# CI/CD

Everything that gates a merge runs in GitHub Actions (`.github/workflows/`), and every job can be
reproduced locally with the commands below. Jobs share one setup step, `.github/actions/setup`
(pnpm and Node.js at the pinned versions, a pnpm store cache, `pnpm install --frozen-lockfile`).

| Workflow | Declared triggers | Jobs |
| --- | --- | --- |
| CI (`ci.yml`) | push to `main`, pull requests, merge queue, manual | `check`, `test` (3 shards), `test-macos` (2), `bench`, `e2e` (4), `perf`, `vim`, `evals-mock` |
| Security (`security.yml`) | push to `main`, pull requests, merge queue, weekly, manual | `gitleaks`, `codeql` (JS/TS + Actions), `dependency-review` (PRs) |
| macOS app (`macos.yml`) | push to `main` and pull requests touching the app, the daemon, the sync service, what they bundle or the vim vectors; manual (inputs `release`, `thorough`) | `packages` (`app`, `editor`, `others`), `integration`, `ios`, `release` (main or `release`) |
| Linux bundle (`linux-bundle.yml`) | push to `main` and pull requests touching `deploy/linux`, the daemon, the sync service, the web app or what they bundle; manual | `bundle`, `setup` |
| Evals (live) (`evals.yml`) | weekly, manual | `gate`, `live` |
| Dependabot (`dependabot.yml`) | weekly | npm and GitHub Actions update PRs |

All workflows default to `permissions: contents: read` and have per-job timeouts. Only a newer
push to the same pull request cancels a run in progress; runs on `main` and dispatched runs are
never cancelled by a newer one.

### How runs start today: by hand

The push, pull request and merge queue triggers are declared but don't fire: since the
repository's first push (2026-09-24), GitHub Actions has started no run for a push or a pull
request, while manual runs work. Until that is fixed, the lead dispatches the workflows on each
branch before merging it and on `main` after pushing:

```sh
gh workflow run ci.yml --repo aayc/dolist --ref <branch>   # also security.yml, macos.yml, linux-bundle.yml
gh run list --repo aayc/dolist --branch <branch>           # then gh run watch <id>
```

- Path filters don't apply to manual runs: dispatch `macos.yml` and `linux-bundle.yml` when the
  change touches what their path lists name (running them anyway costs only time).
- Only the commits someone dispatched have a result, normally the tip of each branch before it
  merges and `main` after each push. A push to `main` that nobody dispatched is untested.
- `dependency-review` runs only for pull requests, so it doesn't run at all for now, and whether
  the weekly schedules fire is still unknown.

Why the triggers don't fire: nothing in the repository explains it. Actions is enabled with every
workflow `active`, the workflows are valid (the same files run when dispatched), no commit message
carries a skip directive, the pushes come from the owner's account, and `main` has no rulesets or
protection. GitHub records every push and other apps get their check suites for it, but no
`github-actions` check suite is ever created; the one push that did start runs created `main`. It
began during a GitHub incident (billing information, 2026-09-24) and didn't recover afterwards, so
it looks like state stuck on GitHub's side. To fix it, the owner can turn Actions off and on again
for the repository (Settings → Actions → General) or disable and re-enable each workflow
(`gh workflow disable`/`enable`), then check that the next push starts runs (`gh run list --repo
aayc/dolist --event push`). If not, ask GitHub Support, citing a push commit that has other apps'
check suites and none from Actions.

## CI (`ci.yml`)

Every job runs on its own runner, all at once; the longest ones are split into shards. A cold run
(nothing cached) takes about 2 minutes, a run where nothing it tests changed about 40 seconds.

### Caching: what runs

Every suite is a turbo task (`test`, `typecheck`, `build`, `bench`, `e2e`, `e2e:perf`,
`vim:check`, `eval:mock`), keyed by everything it reads: its package's files, the packages it
depends on (the `transit` task), the lockfile entries it uses, the declared env vars, the files in
`globalDependencies`, and extra `inputs` in a package's `turbo.json` where a task reads further
(the e2e tasks read the daemon, the sync service and what they bundle; the agent's tests read
`evals/datasets`). A task whose key is unchanged replays its logs and outputs (`dist/`,
`bench-results.json`, `perf-results.json`, `eval-results/`) instead of running.

- Each job restores `.turbo/cache` with `.github/actions/turbo-cache` (one entry per job and shard,
  the latest from this branch or `main`) and saves it pruned to the tasks the job ran.
- Runs on `main` set `TURBO_FORCE=true`: everything runs and refreshes the cache branches start
  from, so a mistake in a task's key can't hide there.
- The Playwright jobs ask turbo first (`.github/scripts/turbo-hit.mjs`) and skip installing
  Chromium when their task will replay.
- A branch reads its own caches and `main`'s, never another branch's, so a pull request can't feed
  results to `main`.

Locally the same cache lives in the main checkout's `.turbo/cache` (worktrees share it): a second
`pnpm check` replays whatever didn't change. `pnpm test:changed` runs only the tests that import a
file changed since `main` (Vitest's `--changed` over the root `vitest.config.ts` projects); `pnpm
check:changed` adds lint, the secret scan on the changed files and the typecheck. Both take another
base as an argument (`pnpm test:changed HEAD`).

### The jobs

- **`check`** (Ubuntu): `pnpm lint` (with `--skip swift`: the macOS workflow lints Swift with
  Xcode's swift-format), the secret scan, `pnpm typecheck`, `pnpm build` and the bundle budget.
  `pnpm lint` is `scripts/lint.mjs --all`, the checks the pre-commit hook runs on staged files: file
  hygiene (`scripts/check-hygiene.mjs`: conflict markers, line endings, whitespace, big files, case
  clashes, executable bits, relative Markdown links), Biome, swift-format, shellcheck, actionlint
  and `pnpm vectors:check` (the Swift Domain port's test vectors regenerated from `@ddl/core` must
  match the committed ones; after an intended change run `pnpm vectors` and commit). In CI a
  missing tool fails the step; locally it's skipped with a warning, and swift-format is skipped
  while no Swift file changed since it last passed. actionlint and shellcheck are
  pinned by version and SHA-256 like gitleaks (versions disagree on rules); keep the pins at the
  versions Homebrew installs.
- **`test`** (Ubuntu, shards `agent`, `daemon`, `rest`): `pnpm turbo run test --concurrency=1
  --continue`. Packages run one at a time on a runner: each package's Vitest starts a worker per
  core, and running them together on 4 vCPUs makes timing-sensitive tests many times slower.
  `TEST_TIME_SCALE=5` stretches default timeouts and the budgets of "stays fast" tests; tests that
  race a timeout against a delay keep fixed bounds (scaling them could hide the bug they guard).
- **`test-macos`** (shards `daemon`, `agent and storage`): what touches the OS — the agent's
  execution, harness and persistence tests, and every test of storage (FSEvents), connectors
  (stdio servers), sync and the daemon (case-insensitive paths, the Trash). Reproduce with
  `pnpm test` on a Mac.
- **`bench`**: `pnpm bench --concurrency=1` with `BENCH_BUDGET_MULTIPLIER=2`, then
  `scripts/bench-check.mjs` prints p50/p99 per benchmark to the job summary and fails on any failed
  budget or missing results. A package opts in with a `bench` script writing `bench-results.json`;
  budgets are p99s asserted in each `*.bench.ts` (see "Toolchain notes" in `AGENTS.md`). A slow
  benchmark passes `run({ iterations: 24, time: 0 })` instead of tinybench's default (64 samples
  over a second): p99 is the worst sample either way.
- **`e2e`** (4 shards): Playwright's `functional` project against real daemons (see "End-to-end
  tests" in `apps/web/README.md`); Chromium is cached by Playwright version, and `--with-deps`
  runs only when `ldd` finds a library missing. On failure the report and traces are uploaded.
- **`perf`**: the `perf` project on a runner of its own with `PERF_BUDGET_MULTIPLIER=2`; it writes
  `apps/web/perf-results.json`, which `.github/scripts/perf-summary.mjs` renders into the summary.
- **`vim`**: `pnpm vim:check` in one Chromium: vectors regenerated and compared, catalog coverage,
  vim.js's suite on plain CodeMirror and on our editor, and every vector replayed (see
  `packages/editor/test/vim/README.md`). `VIM_PAGES` sets the page pool,
  `VIM_CHROMIUM_CHANNEL=chrome` forces installed Chrome.
- **`evals-mock`**: `pnpm eval:mock`, every suite in mock mode; it fails when a suite misses its
  thresholds, and the rules layer must never "allow" a case whose expected verdict is
  `require_approval` or `deny`. `.github/scripts/eval-summary.mjs` renders the results.

```sh
pnpm lint && pnpm typecheck && pnpm check:secrets
pnpm build && pnpm size:check
pnpm test                                   # or pnpm test:changed
BENCH_BUDGET_MULTIPLIER=2 pnpm bench --concurrency=1 && pnpm bench:check
pnpm --filter @ddl/web exec playwright install chromium   # once
pnpm e2e                                    # or: pnpm e2e -- --shard=1/4
PERF_BUDGET_MULTIPLIER=2 pnpm e2e:perf && node .github/scripts/perf-summary.mjs
pnpm vim:check
pnpm eval:mock && node .github/scripts/eval-summary.mjs
```

In CI (`CI=true`) Playwright uses its bundled Chromium; locally it can use installed Chrome.
`DDL_E2E_PORT` moves the harness so two checkouts can run side by side, and
`DDL_E2E_LOG_LEVEL=debug` shows the daemons' logs.

## macOS app (`macos.yml`)

On push and pull requests it runs only when `apps/macos`, the daemon, the sync service, a package
they bundle or the vim vectors change (the two path lists in the workflow must stay in sync). Every
job selects the newest non-beta Xcode, and they all start at once:

| Job | What it does |
| --- | --- |
| `Swift packages (app)` | `test.sh app`: compiles every package the app links and runs the app shell's tests |
| `Swift packages (editor)` | `test.sh DailyDoListEditor`: its replay of every vim vector through the real editor is the longest test |
| `Swift packages (others)` | `test.sh` for the other packages, then a smoke test of the debug `ddl-computer` |
| `Integration tests and Swift format` | strict swift-format, then `test.sh integration` against the real daemon and sync service |
| `Shared packages build for iOS` | builds the Foundation-only packages the iPhone app will reuse |
| `Release app (bundled daemon)` | on `main`, or a manual run with `release`: the release app with the bundled daemon, a smoke test of its `ddl-computer`, and the zipped app as the `daily-do-list-macos` artifact (14 days; ad hoc signed, not notarized) |

Dispatch with `-f release=true` to build the release app on a branch, `-f thorough=true` for the
full iteration counts (`DDL_TEST_THOROUGH=1`, always on `main`). The package jobs need only Node
from `.nvmrc`, no `pnpm install`.

**Build caches.** Each Swift job restores `apps/macos/.build` with `actions/cache`, keyed by the
runner OS, the Xcode version and the git blobs of the job's packages and their dependencies. An
unchanged group gets its exact cache back and saves nothing; a changed one restores the latest
cache with the same prefix (its branch's, else `main`'s), builds incrementally and saves a new one,
also when tests failed. A checkout gives every file a new modification time, which would make the
Swift driver rebuild everything, so `apps/macos/scripts/ci-mtimes.mjs` records each tracked file's
blob and time next to the build and, after a restore, gives unchanged files their recorded time
back. Changed and new files keep the current time, so they and their dependents always rebuild: a
cache can make a run faster, never skip a rebuild.

```sh
node scripts/lint.mjs --all --only swift   # or pnpm lint:fix to format
pnpm --filter @ddl/daemon --filter @ddl/sync build
apps/macos/scripts/test.sh                 # every package, then the app shell (--changed: only what your changes affect)
apps/macos/scripts/test.sh integration     # real daemon, mock agent
apps/macos/scripts/build-app.sh --release --with-daemon --zip
apps/macos/scripts/smoke-computer-helper.sh "apps/macos/build/Daily Do List.app/Contents/Resources/daemon/bin/ddl-computer"
```

## Linux bundle (`linux-bundle.yml`)

The always-on machine's kit (`deploy/linux`), run for x64 (`ubuntu-latest`) and arm64
(`ubuntu-24.04-arm`) when the kit, the daemon, the sync service, the web app or what they bundle
change (the two path lists must stay in sync):

- `bundle` builds `ddl-linux-<arch>.tar.gz`, and `deploy/linux/smoke-test.sh` starts it on free
  loopback ports with the `config.json` `setup.sh` writes and checks it end to end with
  `smoke-check.mjs` (health, the guards, the web app, a synced note, the agent as the always-on
  machine, pairing and revoking a device, a clean stop). The bundle is uploaded for 7 days.
- `setup` installs that bundle with `setup.sh` on a fresh runner (`deploy/linux/setup-test.sh`:
  idempotent reruns and upgrades, modes and owners, the units and their sandbox, the smoke check as
  the service user, no token in any output or the journal).

Both are described, with how to run them locally, in [deploy/linux/README.md](../deploy/linux/README.md).

## Budgets

| Budget | Defined in | Local | CI |
| --- | --- | --- | --- |
| Hot-path p99 latency | each `*.bench.ts` | ×1 | ×2 (`BENCH_BUDGET_MULTIPLIER`) |
| Unit-test timing guards and default timeouts | those tests, `scripts/vitest/setup-fast-check.ts` | ×1 | ×5 (`TEST_TIME_SCALE`) |
| Swift performance tests (debug build) | `*PerformanceTests.swift` | ×1 | ×4 (`PERF_BUDGET_MULTIPLIER`), editor ×2 (`EDITOR_PERF_BUDGET_MULTIPLIER`) |
| UI perf | `apps/web/e2e/perf/`, see `docs/PERFORMANCE.md` | ×1 | ×2 (`PERF_BUDGET_MULTIPLIER`) |
| Bundle size, gzip | top of `scripts/bundle-size-check.mjs` | same | same |
| Eval thresholds (accuracy, false-allow rate, …) | each eval suite | same | same |

For the bundle budget, "initial" means the HTML entry chunk plus everything it statically imports
(from `apps/web/dist/.vite/manifest.json`); lazy chunks count only toward total JS. Sizes use
zlib's default gzip level and kB = 1000 bytes, like Vite's report. Raising any budget needs a
justification in the PR's "Perf impact" section.

## Security (`security.yml`)

**`gitleaks`** scans the full history (`fetch-depth: 0`) with the official release binary, pinned
by version and SHA-256 (the `gitleaks-action` wrapper needs a license for organizations), using
`.gitleaks.toml` and `--redact`. It complements `scripts/check-secrets.mjs`, which covers
repo-specific patterns and forbidden files (`.env*`, `.daily-do-list/`, keys, shell history) in the
hooks and in `check`; the hooks run gitleaks too (the pre-push hook refuses to push without it).

- **False positive** (e.g. a synthetic token in a fixture): add `gitleaks:allow` to that line (and
  `secret-scan:ignore` for `check-secrets.mjs`), or its fingerprint to `.gitleaksignore`. Avoid path
  allowlists: gitleaks then skips those files entirely.
- **Real leak:** rotate the credential first. The history is public; rewriting it doesn't un-leak.
- **Upgrading gitleaks:** update `GITLEAKS_VERSION` and `GITLEAKS_SHA256` in the workflow (the
  `linux_x64` line of the release's checksums file). Dependabot can't bump it.

```sh
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner -v   # git history
gitleaks dir . --config .gitleaks.toml --redact --no-banner -v               # working tree
```

**`codeql`** analyzes `javascript-typescript` and `actions` with the `security-extended` queries
(CodeQL's advanced setup: keep "default setup" disabled in the repository settings). It analyzes
test code too; excluding it would roughly halve the two minutes it takes, at the cost of findings
in code that never ships, a trade deliberately not made. **`dependency-review`** fails a PR that
adds a dependency with a known high or critical vulnerability.

## Live evals (`evals.yml`)

Weekly and on demand (optional `suite` and `filter` inputs). The `gate` job checks for the
`OPENROUTER_API_KEY` secret and skips `live` without it; `live` runs `pnpm eval` against the real
model with the key exposed to that one step only. Every run costs OpenRouter credits, so prefer the
`suite` input for ad-hoc runs. Locally: `pnpm eval --suite safety && node
.github/scripts/eval-summary.mjs`.

## Dependabot and supply chain

- Dependabot: npm weekly (minor and patch grouped; the `@earendil-works/pi-*` packages together;
  majors one by one) and GitHub Actions weekly, grouped; both wait 7 days after a release.
- Third-party actions are pinned to full commit SHAs with the version in a comment (to bump one by
  hand: `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing annotated tags).
- The default token is read-only, checkouts use `persist-credentials: false`, nothing uses
  `pull_request_target`, and `workflow_dispatch` inputs reach scripts through environment
  variables, never `${{ }}` interpolation. The only secret is `OPENROUTER_API_KEY`, in one step of a
  workflow fork PRs can't trigger.
- pnpm blocks dependency lifecycle scripts except `onlyBuiltDependencies` (`pnpm-workspace.yaml`).
- To upgrade actionlint, update `ACTIONLINT_VERSION` and `ACTIONLINT_SHA256` in `ci.yml` (the
  `linux_amd64` checksum); shellcheck publishes no checksums, so take `SHELLCHECK_SHA256` from
  `shasum -a 256` of the downloaded release asset.

## Repository settings

- **Secrets:** `OPENROUTER_API_KEY` (optional) enables the live evals.
- **Security:** private vulnerability reporting (`SECURITY.md` points to it), Dependabot alerts and
  security updates, secret scanning and push protection on; CodeQL default setup off.
- **Actions:** workflow permissions "Read repository contents and packages permissions"; require
  approval for workflows from first-time contributors' fork PRs.
- **Branch ruleset for `main`** (recommended, not enabled while the lead merges locally): require a
  pull request with one approval, block force pushes and deletions, require the CI, Security and
  dependency review checks (job names are the check names, so rename jobs deliberately), and
  either require up-to-date branches or use a merge queue (both workflows run on `merge_group`).
- The issue templates use the default `bug` and `enhancement` labels.
