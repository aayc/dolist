# CI/CD

Everything that gates a merge runs in GitHub Actions, and every job can be reproduced locally with
the commands below. Workflows live in `.github/workflows/`. Jobs share one setup step,
`.github/actions/setup`: pnpm (version from `packageManager`), Node.js (from `.nvmrc`), a pnpm store
cache, then `pnpm install --frozen-lockfile`.

| Workflow | Triggers | Jobs |
| --- | --- | --- |
| CI (`ci.yml`) | push to `main`, pull requests, merge queue | `check`, `test-macos`, `bench`, `e2e`, `evals-mock` |
| Security (`security.yml`) | push to `main`, pull requests, merge queue, weekly (Mon 05:27 UTC), manual | `gitleaks`, `codeql` (JS/TS + Actions), `dependency-review` (PRs) |
| macOS app (`macos.yml`) | push to `main` and pull requests touching the app, the daemon, what it bundles or the vim vectors; manual | `app` |
| Evals (live) (`evals.yml`) | weekly (Mon 06:43 UTC), manual | `gate`, `live` |
| Dependabot (`dependabot.yml`) | weekly (Monday) | npm and GitHub Actions update PRs |

All workflows default to `permissions: contents: read` and have per-job timeouts. A new push to a
pull request cancels the PR's previous run; runs on `main` are never cancelled, so every commit on
`main` keeps a result.

## CI (`ci.yml`)

### `check`: lint, typecheck, test, build (Ubuntu)

Runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `node scripts/check-secrets.mjs --all`,
`pnpm build`, then `node scripts/bundle-size-check.mjs`.

`pnpm lint` is `scripts/lint.mjs --all`, the same checks the pre-commit hook runs on staged files:
file hygiene (`scripts/check-hygiene.mjs`: conflict markers, LF endings, final newlines, trailing
whitespace, files over 1 MiB, paths that differ only in case, executable bits, relative Markdown
links), Biome, shellcheck on shell scripts and git hooks, actionlint on the workflows, and
`pnpm vectors:check`. In CI a missing tool fails the step; locally it's skipped with a warning. The
job installs actionlint and shellcheck from their releases, pinned by version and SHA-256 like
gitleaks, because versions disagree on rules (the runner image's shellcheck 0.9 rejects `test -nt`,
which 0.11 accepts as POSIX). Keep the pins at the versions Homebrew installs.

Unit tests run one package at a time (`pnpm test --concurrency=1 --continue`, also on macOS):
every package's Vitest starts a worker per core, so running them together on a 3–4 vCPU runner makes
timing-sensitive tests many times slower than on a dev machine. `--continue` reports every failing
package instead of stopping at the first. `TEST_TIME_SCALE=5` stretches Vitest's default timeouts
(`scripts/vitest/setup-fast-check.ts`) and the budgets of tests that assert an algorithm stays fast
(each such test multiplies its budget by it). Tests that race a timeout against a delay (retry
backoff, a killed process, a drained connection) keep fixed bounds: scaling them could hide the bug
they guard against.

`pnpm vectors:check` regenerates the macOS app's test vectors (`apps/macos/Packages/DailyDoListDomain`)
from `@ddl/core` in memory and fails if the committed JSON differs, so a change to dates, paths,
tasks or wiki links that would make the Swift port disagree is caught on Linux, before the macOS
workflow runs. After an intended change, run `pnpm vectors` (or `pnpm lint:fix`) and commit the
updated files.

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm check:secrets
pnpm build && pnpm size:check
```

### `test-macos`: unit tests on macOS

`pnpm test` on `macos-latest`. Some tests only exercise their real code path on macOS: the local
filesystem watcher (FSEvents-backed recursive `fs.watch`), the macOS computer-use helpers, and the
Chrome-based browser tests. Reproduce with `pnpm test` on a Mac.

### `bench`: benchmarks

1. `pnpm bench --concurrency=1 --env-mode=loose` with `BENCH_BUDGET_MULTIPLIER=2`. Every package with
   a `bench` script runs `vitest bench --run` and writes `bench-results.json`. Packages run one at a
   time so suites don't compete for CPU. `--env-mode=loose` is needed because Turbo's default strict
   env mode strips variables that `turbo.json` doesn't declare for the task, so the multiplier would
   otherwise never reach Vitest.
2. `node scripts/bench-check.mjs` prints a table (package, benchmark, p50, p99, samples, status) to
   the log and the job summary. It fails if any benchmark test failed or if no results were found.
3. The results are uploaded as the `bench-results` artifact.

Budgets are p99 latencies asserted inside each `*.bench.ts`, multiplied by
`BENCH_BUDGET_MULTIPLIER` (1 locally, 2 in CI because shared runners are slower and noisier):

```ts
const MULTIPLIER = Number(process.env.BENCH_BUDGET_MULTIPLIER ?? 1);

test("parseTasks: 2k-line note", async ({ bench }) => {
  const result = await bench("parseTasks: 2k-line note", () => parseTasks(NOTE_2K)).run();
  expect(result.latency.p99).toBeLessThan(4 * MULTIPLIER);
});
```

A package opts in with
`"bench": "vitest bench --run --reporter=default --reporter=json --outputFile.json=bench-results.json"`.

```sh
BENCH_BUDGET_MULTIPLIER=2 pnpm bench --concurrency=1 --env-mode=loose
pnpm bench:check                      # or: node scripts/bench-check.mjs packages/core
```

### `e2e`: Playwright functional and perf tests

1. Restores `~/.cache/ms-playwright`, keyed by the `@playwright/test` version in `pnpm-lock.yaml`.
2. `pnpm --filter @ddl/web exec playwright install --with-deps chromium`. System packages aren't
   cached, so this always runs; the browser download is skipped on a cache hit.
3. `pnpm vim:check` (~25 s), the vim-mode gate, in one Chromium session (see
   `packages/editor/test/vim/README.md`):
   - regenerates `packages/editor/test/vim/vectors.jsonl` (the vim behavior contract the Swift port
     replays too) and fails with a per-case diff if the committed file differs, if a catalog case
     throws, or if a `defaultKeymap` entry or ex command lost its catalog coverage;
   - runs vim.js's own test suite against plain CodeMirror 6 (upstream's setup; all must pass) and
     against the Daily Do List editor (only the listed, deliberate differences may fail);
   - replays every vector against the Daily Do List editor (only listed skips may differ).
   After an intended change (a dependency upgrade, a new catalog case) run `pnpm vim:vectors` and
   commit the regenerated file after reviewing its diff.
4. `pnpm e2e` (project `functional`). The report and traces are uploaded as
   `playwright-report-functional`.
5. `pnpm e2e:perf` (project `perf`) with `PERF_BUDGET_MULTIPLIER=2`. The perf specs write
   `apps/web/perf-results.json` and fail when a metric exceeds budget × multiplier.
   `.github/scripts/perf-summary.mjs` renders the numbers into the job summary. The report and
   `perf-results.json` are uploaded as `playwright-report-perf`.

The perf step runs even when functional tests fail, so perf numbers are always available. In CI
(`CI=true`) Playwright uses its bundled Chromium; locally it can use installed Chrome. The perf
summary understands `{ "multiplier": 2, "results": [{ "name": "tab:switch", "value": 12.3,
"unit": "ms", "budget": 30, "passed": true }] }`, and falls back to showing raw JSON for other shapes.

```sh
pnpm --filter @ddl/web exec playwright install chromium   # once
pnpm vim:check
pnpm e2e
PERF_BUDGET_MULTIPLIER=2 pnpm e2e:perf && node .github/scripts/perf-summary.mjs
```

The vim scripts prefer Playwright's bundled Chromium (what CI uses) and fall back to the installed
Google Chrome; `VIM_CHROMIUM_CHANNEL=chrome` forces Chrome.

### `evals-mock`: deterministic agent evals

`pnpm eval:mock` runs every suite in `evals/src/suites/` in mock mode (no network, no real model).
It fails when any suite misses its thresholds. Safety-critical rule: the rules layer must never
"allow" a case whose expected verdict is `require_approval` or `deny`.
`.github/scripts/eval-summary.mjs` renders suites, pass counts, critical failures, metrics and failed
cases into the job summary. Results are uploaded as `eval-results-mock`.

```sh
pnpm eval:mock && node .github/scripts/eval-summary.mjs
```

## macOS app (`macos.yml`)

One job, `app`, on `macos-latest`, only when `apps/macos`, the daemon, a package the daemon
bundles or the vim behavior vectors (`packages/editor/test/vim`, replayed by `DailyDoListVim`)
change (the two path lists in the workflow must stay in sync). It selects the newest non-beta
Xcode, builds the daemon, runs every Swift package's tests (including the vim vector replay),
compiles the Foundation-only packages the iPhone app will reuse (`DailyDoListModels`,
`DailyDoListClient`, `DailyDoListDomain`, `DailyDoListVim`) for iOS, runs the integration tests
against the real daemon with the mock agent, builds a release "Daily Do List.app" with the bundled
daemon, and uploads the zipped app as the `daily-do-list-macos` artifact (kept 14 days; ad hoc
signed, not notarized).

```sh
pnpm --filter @ddl/daemon build
apps/macos/scripts/test.sh                 # every package, then the app shell
apps/macos/scripts/test.sh integration     # real daemon, mock agent
apps/macos/scripts/build-app.sh --release --with-daemon --zip
```

With only the Command Line Tools installed (no Xcode), `test.sh` adds the framework and rpath flags
Swift Testing needs.

## Budgets

| Budget | Defined in | Local | CI |
| --- | --- | --- | --- |
| Hot-path p99 latency | each `*.bench.ts` | ×1 | ×2 (`BENCH_BUDGET_MULTIPLIER`) |
| Unit-test timing guards ("stays fast" assertions) and default timeouts | those tests, `scripts/vitest/setup-fast-check.ts` | ×1 | ×5 (`TEST_TIME_SCALE`) |
| Swift performance tests (debug build) | `*PerformanceTests.swift` in the Swift packages | ×1 | ×4 (`PERF_BUDGET_MULTIPLIER`), editor ×2 (`EDITOR_PERF_BUDGET_MULTIPLIER`) |
| UI perf: startup, daily-note open, tab switch, thread open, keystroke latency, long tasks | `apps/web/e2e/perf/`, see `docs/PERFORMANCE.md` | ×1 | ×2 (`PERF_BUDGET_MULTIPLIER`) |
| Bundle size, gzip: initial JS ≤ 320 kB, initial CSS ≤ 40 kB, total JS ≤ 1200 kB | top of `scripts/bundle-size-check.mjs` | same | same |
| Eval thresholds (accuracy, false-allow rate, …) | each eval suite | same | same |

For the bundle budget, "initial" means the HTML entry chunk plus everything it statically imports,
i.e. what must download before the app boots. Lazy chunks count only toward total JS. The chunk
graph comes from `apps/web/dist/.vite/manifest.json` (Vite `build.manifest: true`) or, as a
fallback, from the tags in `dist/index.html`. Sizes use zlib's default gzip level and kB = 1000
bytes, matching Vite's build report. Raising any budget needs a justification in the PR's "Perf
impact" section.

## Security (`security.yml`)

### `gitleaks`: secret scan of the full history

Downloads the official gitleaks release binary (MIT), pinned by version and verified against a
pinned SHA-256 before use. The `gitleaks-action` wrapper isn't used because it requires a license
for organizations. The job scans the entire git history (`fetch-depth: 0`) using `.gitleaks.toml`,
which extends the default ruleset. `--redact` keeps secrets out of the public log. This complements
`scripts/check-secrets.mjs`, which runs in the pre-commit hook (staged files), the pre-push hook
(`--range`: every commit being pushed) and in `check`, and covers repo-specific patterns plus
forbidden files (`.env*`, `.daily-do-list/`, keys, shell history). The hooks run gitleaks too: the
pre-commit hook when it's installed, the pre-push hook always (it refuses to push without it).

- **False positive** (e.g. a synthetic token in a fixture): add `gitleaks:allow` to that line
  (and `secret-scan:ignore` for `check-secrets.mjs`), or add the finding's fingerprint to
  `.gitleaksignore`. Avoid path allowlists: gitleaks then skips those files entirely.
- **Real leak:** rotate the credential first. The history is public, and rewriting it does not
  un-leak a secret.
- **Upgrading gitleaks:** update `GITLEAKS_VERSION` and `GITLEAKS_SHA256` in the workflow. Take
  the SHA from the `linux_x64` line of the release's `gitleaks_<version>_checksums.txt`. Dependabot
  can't bump this.

```sh
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner -v   # git history
gitleaks dir . --config .gitleaks.toml --redact --no-banner -v               # working tree
```

### `codeql`: static analysis

Analyzes `javascript-typescript` and `actions` (the workflows themselves: script injection,
excessive permissions, …) with the `security-extended` queries. Findings appear under Security →
Code scanning. This is CodeQL's *advanced setup*, so keep "default setup" disabled in the
repository settings, or the uploads conflict. Only this job gets `security-events: write`.

### `dependency-review`: new vulnerable dependencies (pull requests)

Fails a PR that introduces a dependency with a known high or critical vulnerability. It relies on
the dependency graph, which is enabled by default for public repositories.

## Live evals (`evals.yml`)

Runs weekly and on demand. Manual runs accept optional `suite` and `filter` inputs. The `gate` job
checks whether the `OPENROUTER_API_KEY` secret exists. Without it, the job posts a notice and
`live` is skipped, so the workflow stays green. `live` runs `pnpm eval` against the real model. The
key is exposed only to that one step, never to dependency installation. Results appear in the job
summary and in the `eval-results-live` artifact (kept 90 days). Every run costs OpenRouter credits,
so prefer the `suite` input for ad-hoc runs.

```sh
# OPENROUTER_API_KEY in ~/.daily-do-list/.env or the environment
pnpm eval --suite safety && node .github/scripts/eval-summary.mjs
```

## Dependabot

- **npm**, weekly. Minor and patch updates are grouped into one PR. The `@earendil-works/pi-*`
  harness packages are grouped together because they move in lockstep. Majors arrive as individual
  PRs.
- **GitHub Actions**, weekly and grouped. Dependabot updates the pinned SHAs and their `# vX.Y.Z`
  comments in the workflows and in `.github/actions/*`.
- Both ecosystems wait 7 days after a release (`cooldown`), which limits exposure to compromised
  publishes.

## Supply-chain hardening

- Third-party actions are pinned to full commit SHAs, with the version in a trailing comment. To
  bump one manually, resolve the tag with
  `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`. If the result is an annotated tag,
  dereference it with `gh api repos/<owner>/<repo>/git/tags/<sha>`.
- The default token is read-only. Checkouts use `persist-credentials: false`. Nothing uses
  `pull_request_target`. `workflow_dispatch` inputs reach scripts through environment variables,
  never `${{ }}` interpolation.
- The only secret is `OPENROUTER_API_KEY`, used in a single step of a workflow that fork PRs can't
  trigger.
- pnpm 10 blocks dependency lifecycle scripts except those listed in `onlyBuiltDependencies`
  (`pnpm-workspace.yaml`).
- [actionlint](https://github.com/rhysd/actionlint) checks the workflows (and, through shellcheck,
  their `run:` scripts) in `pnpm lint`, in the pre-commit hook when a workflow or local action
  changes, and in `check`. To upgrade it, update `ACTIONLINT_VERSION` and `ACTIONLINT_SHA256` in
  `ci.yml`, taking the SHA from the `linux_amd64` line of `actionlint_<version>_checksums.txt`.
  shellcheck publishes no checksums: take `SHELLCHECK_SHA256` from
  `shasum -a 256 shellcheck-v<version>.linux.x86_64.tar.xz` after downloading the release asset.

## Repository settings

**Secrets**

- `OPENROUTER_API_KEY` (optional): enables the live evals workflow.

**Security**

- Enable **Private vulnerability reporting** (`SECURITY.md` points reporters to it).
- Enable Dependabot alerts and security updates, secret scanning, and push protection. All are free
  for public repositories.
- Keep CodeQL **default setup off**, because `security.yml` is the advanced setup.

**Actions**

- Set Workflow permissions to "Read repository contents and packages permissions".
- Require approval before running workflows from fork pull requests by first-time contributors.

**Branch ruleset for `main`**

- Require a pull request with at least one approval. Block force pushes and deletions.
- Required status checks: `Lint, typecheck, test, build`, `Unit tests (macOS)`, `Benchmarks`,
  `E2E and perf (Playwright)`, `Evals (mock)`, `Secret scan (gitleaks)`,
  `CodeQL (javascript-typescript)`, `CodeQL (actions)`, `Dependency review`. Job names are the
  check names, so rename jobs deliberately.
- Either require branches to be up to date or use a merge queue; both workflows also run on
  `merge_group`. A job skipped by its condition (e.g. dependency review in the queue) counts as
  passing.

**Housekeeping**

- The issue templates use the default `bug` and `enhancement` labels.
