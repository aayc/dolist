# CI/CD

Everything that gates a merge runs in GitHub Actions, and every job can be reproduced locally with
the commands below. Workflows live in `.github/workflows/`. Jobs share one setup step,
`.github/actions/setup`: pnpm (version from `packageManager`), Node.js (from `.nvmrc`), a pnpm store
cache, then `pnpm install --frozen-lockfile`.

| Workflow | Declared triggers | Jobs |
| --- | --- | --- |
| CI (`ci.yml`) | push to `main`, pull requests, merge queue, manual | `check`, `test` (3 shards), `test-macos` (2), `bench`, `e2e` (4), `perf`, `vim`, `evals-mock` |
| Security (`security.yml`) | push to `main`, pull requests, merge queue, weekly (Mon 05:27 UTC), manual | `gitleaks`, `codeql` (JS/TS + Actions), `dependency-review` (PRs) |
| macOS app (`macos.yml`) | push to `main` and pull requests touching the app, the daemon, the sync service, what they bundle or the vim vectors; manual | `app` |
| Linux bundle (`linux-bundle.yml`) | push to `main` and pull requests touching `deploy/linux`, the daemon, the sync service, the web app or what they bundle; manual | `bundle`, `setup` |
| Evals (live) (`evals.yml`) | weekly (Mon 06:43 UTC), manual | `gate`, `live` |
| Dependabot (`dependabot.yml`) | weekly (Monday) | npm and GitHub Actions update PRs |

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
- `dependency-review` runs only for pull requests, so it doesn't run at all for now.
- The weekly schedules haven't come due since the repository was created, so whether they fire
  is still unknown.

Why the triggers don't fire: nothing in the repository explains it. Actions is enabled with every
workflow `active`, the workflows are valid (the same files run when dispatched), no commit message
carries a skip directive, the pushes come from the owner's account (not a workflow token), and
`main` has no rulesets or protection. GitHub records every push, and the third-party apps on the
repository get their check suites for it, but no `github-actions` check suite is ever created. The
one push that did start runs created `main`; every push since, and a throwaway pull request,
started nothing. It began during a GitHub incident (billing information, 2026-09-24) and didn't
recover once the incident was resolved, so it looks like state stuck on GitHub's side. To fix it,
the owner can turn Actions off and on again for the repository (Settings → Actions → General) or
disable and re-enable each workflow (`gh workflow disable`/`enable`), then check that the next
push starts runs (`gh run list --repo aayc/dolist --event push`). If it still doesn't, ask GitHub
Support, citing a push commit that has other apps' check suites and none from Actions.

## CI (`ci.yml`)

Every job runs on its own runner, all at once; the longest ones are split into shards. A cold run
(nothing cached) takes about 2 minutes, a run where nothing it tests changed about 40 seconds.

### Caching: what runs

Every suite is a turbo task (`test`, `typecheck`, `build`, `bench`, `e2e`, `e2e:perf`,
`vim:check`, `eval:mock`), and turbo keys each task by everything it reads: its package's files,
the packages it depends on (the `transit` task), the lockfile entries it uses, the declared env
vars, the files in `globalDependencies` (`.nvmrc`, `tsconfig.base.json`, `scripts/vitest/**`),
and extra `inputs` in a package's `turbo.json` where a task reads further (the e2e tasks read the
daemon, the sync service and the packages they bundle; the agent's tests read
`evals/datasets`). A task whose key is unchanged replays its logs and outputs (`dist/`,
`bench-results.json`, `perf-results.json`, `eval-results/`) instead of running.

- Each job restores `.turbo/cache` with `.github/actions/turbo-cache` (actions/cache, one entry
  per job and shard, the latest from this branch or `main`) and saves it at the end, pruned to
  the tasks the job ran (`.github/scripts/prune-turbo-cache.mjs`, from turbo's run summaries).
- Runs on `main` set `TURBO_FORCE=true`: everything runs, and refreshes the cache that branches
  start from. A mistake in a task's key can't hide there.
- The Playwright jobs ask turbo first (`.github/scripts/turbo-hit.mjs`) and skip installing
  Chromium when their task will replay.
- Caches are scoped by GitHub: a branch reads its own and `main`'s, never another branch's, so a
  pull request can't feed results to `main`.

Locally the same cache lives in the main checkout's `.turbo/cache` (worktrees share it): a second
`pnpm check` replays whatever didn't change. `pnpm test:changed` runs only the tests that import a
file changed since `main`, across packages (Vitest's `--changed` over the projects in the root
`vitest.config.ts`); `pnpm check:changed` adds lint and the secret scan on the changed files and
the typecheck. Both take another base as an argument (`pnpm test:changed HEAD`).

### `check`: lint, typecheck, build (Ubuntu)

Runs `pnpm lint`, `node scripts/check-secrets.mjs --all`, `pnpm typecheck`, `pnpm build`, then
`node scripts/bundle-size-check.mjs`. The lint checks run in parallel; locally, `pnpm lint` skips
swift-format while no Swift file changed since it last passed.

`pnpm lint` is `scripts/lint.mjs --all`, the same checks the pre-commit hook runs on staged files:
file hygiene (`scripts/check-hygiene.mjs`: conflict markers, LF endings, final newlines, trailing
whitespace, files over 1 MiB, paths that differ only in case, executable bits, relative Markdown
links), Biome, swift-format on the Swift sources (`.swift-format`), shellcheck on shell scripts and
git hooks, actionlint on the workflows, and `pnpm vectors:check`. This job runs it with
`--skip swift`; the macOS workflow lints Swift with Xcode's swift-format, the version local
toolchains ship. In CI a missing tool fails the step; locally it's skipped with a warning. The
job installs actionlint and shellcheck from their releases, pinned by version and SHA-256 like
gitleaks, because versions disagree on rules (the runner image's shellcheck 0.9 rejects `test -nt`,
which 0.11 accepts as POSIX). Keep the pins at the versions Homebrew installs.

`pnpm vectors:check` regenerates the macOS app's test vectors (`apps/macos/Packages/DailyDoListDomain`)
from `@ddl/core` in memory and fails if the committed JSON differs, so a change to dates, paths,
tasks or wiki links that would make the Swift port disagree is caught on Linux, before the macOS
workflow runs. After an intended change, run `pnpm vectors` (or `pnpm lint:fix`) and commit the
updated files.

```sh
pnpm lint && pnpm typecheck && pnpm check:secrets
pnpm build && pnpm size:check
```

### `test`: unit tests (Ubuntu, 3 shards)

`pnpm turbo run test --concurrency=1 --continue`, sharded by package: `agent`, `daemon`, and
`rest` (everything else). On a runner, packages run one at a time: every package's Vitest starts a
worker per core, so running them together on a 4 vCPU runner makes timing-sensitive tests many
times slower than on a dev machine. `--continue` reports every failing package instead of stopping
at the first. `TEST_TIME_SCALE=5` stretches Vitest's default timeouts
(`scripts/vitest/setup-fast-check.ts`) and the budgets of tests that assert an algorithm stays fast
(each such test multiplies its budget by it). Tests that race a timeout against a delay (retry
backoff, a killed process, a drained connection) keep fixed bounds: scaling them could hide the bug
they guard against.

```sh
pnpm test                 # every package (turbo replays unchanged ones)
pnpm test:changed         # only the tests that import what changed since main
```

### `test-macos`: unit tests on macOS (2 shards)

What touches the OS, on `macos-latest`: the agent's `src/execution`, `src/harness`,
`test/persistence` and `test/journal.test.ts` (processes, shells, the macOS computer-use helpers,
Chrome, files), and every test of storage (the FSEvents-backed recursive `fs.watch`), connectors
(stdio servers), sync (sockets) and the daemon (case-insensitive paths, the Trash), in two shards:
`daemon`, and `agent and storage`. The rest is platform-independent logic that runs on Linux
only. Reproduce with `pnpm test` on a Mac.

### `bench`: benchmarks

1. `pnpm bench --concurrency=1` with `BENCH_BUDGET_MULTIPLIER=2` (declared in the task's `env`, so
   it reaches Vitest and is part of the cache key). Every package with a `bench` script runs
   `vitest bench --run` and writes `bench-results.json`. Packages run one at a time so suites don't
   compete for CPU; a package whose inputs didn't change replays its results.
2. `node scripts/bench-check.mjs` prints a table (package, benchmark, p50, p99, samples, status) to
   the log and the job summary. It fails if any benchmark test failed or if no results were found.
3. The results are uploaded as the `bench-results` artifact.

Budgets are p99 latencies asserted inside each `*.bench.ts`, multiplied by
`BENCH_BUDGET_MULTIPLIER` (1 locally, 2 in CI because shared runners are slower and noisier):

```ts
const MULTIPLIER = Number(process.env.BENCH_BUDGET_MULTIPLIER ?? 1);

test("parseTasks: 2k-line note", async ({ bench }) => {
  const result = await bench("parseTasks: 2k-line note", () => parseTasks(NOTE_2K)).run();
  expect(result.latency.p99).toBeLessThan(6 * MULTIPLIER);
});
```

tinybench takes at least 64 samples over at least a second. A benchmark whose run takes hundreds of
milliseconds passes `run({ iterations: 24, time: 0, … })` instead (the typing and import-preview
benchmarks): p99 of either is the worst sample, so the budget means the same.

A package opts in with
`"bench": "vitest bench --run --reporter=default --reporter=json --outputFile.json=bench-results.json"`.

```sh
BENCH_BUDGET_MULTIPLIER=2 pnpm bench --concurrency=1
pnpm bench:check                      # or: node scripts/bench-check.mjs packages/core
```

### `e2e`: Playwright functional tests (4 shards)

1. Restores `~/.cache/ms-playwright`, keyed by the `@playwright/test` version in `pnpm-lock.yaml`,
   and installs Chromium (`.github/actions/playwright`). GitHub's Ubuntu images ship Google Chrome
   and the libraries Chromium needs, so the slow `--with-deps` (apt) runs only when `ldd` finds one
   missing. Skipped when the job's turbo task will replay.
2. `pnpm turbo run e2e --filter=@ddl/web -- --shard=N/4` (project `functional`, a quarter of the
   tests on each runner). Playwright's web server builds the web app (`vite build`) and starts
   `packages/agent/scripts/e2e-daemons.ts`, which starts a real daemon per test (from source, with
   `tsx`: nothing else to build), each on a temporary `DDL_HOME` and demo vault, plus a fake
   OpenRouter and a sync service in the same process; nothing reaches the network. On failure the
   report and traces are uploaded as `playwright-report-functional-N`.

### `perf`: Playwright perf tests

`pnpm turbo run e2e:perf --filter=@ddl/web` (project `perf`, the same web server) with
`PERF_BUDGET_MULTIPLIER=2`, on a runner of its own so nothing competes with the measurements. The
perf specs write `apps/web/perf-results.json` (restored on a cache hit) and fail when a metric
exceeds budget × multiplier. `.github/scripts/perf-summary.mjs` renders the numbers into the job
summary. The report and `perf-results.json` are uploaded as `playwright-report-perf`.

In CI (`CI=true`) Playwright uses its bundled Chromium; locally it can use installed Chrome.
Locally the harness's control port is `DDL_E2E_PORT` (default 4173), so two checkouts can run side
by side; `DDL_E2E_LOG_LEVEL=debug` shows the daemons' logs. The perf summary understands
`{ "multiplier": 2, "results": [{ "name": "tab:switch", "value": 12.3, "unit": "ms", "budget": 30,
"passed": true }] }`, and falls back to showing raw JSON for other shapes.

```sh
pnpm --filter @ddl/web exec playwright install chromium   # once
pnpm e2e                                                   # or: pnpm e2e -- --shard=1/4
PERF_BUDGET_MULTIPLIER=2 pnpm e2e:perf && node .github/scripts/perf-summary.mjs
```

### `vim`: vim mode

`pnpm turbo run vim:check --filter=@ddl/editor`, the vim-mode gate, in one Chromium (see
`packages/editor/test/vim/README.md`). Its four parts run at once, the long ones on a pool of pages
(one per core but one, at most 6; `VIM_PAGES` overrides): it

- regenerates `packages/editor/test/vim/vectors.jsonl` (the vim behavior contract the Swift port
  replays too) and fails with a per-case diff if the committed file differs, if a catalog case
  throws, or if a `defaultKeymap` entry or ex command lost its catalog coverage;
- runs vim.js's own test suite against plain CodeMirror 6 (upstream's setup; all must pass) and
  against the Daily Do List editor (only the listed, deliberate differences may fail);
- replays every vector against the Daily Do List editor (only listed skips may differ).

After an intended change (a dependency upgrade, a new catalog case) run `pnpm vim:vectors` and
commit the regenerated file after reviewing its diff. The vim scripts prefer Playwright's bundled
Chromium (what CI uses) and fall back to the installed Google Chrome; `VIM_CHROMIUM_CHANNEL=chrome`
forces Chrome.

```sh
pnpm vim:check
```

### `evals-mock`: deterministic agent evals

`pnpm eval:mock` (in CI through turbo, so unchanged agent code replays the last results) runs every
suite in `evals/src/suites/` in mock mode (no network, no real model).
It fails when any suite misses its thresholds. Safety-critical rule: the rules layer must never
"allow" a case whose expected verdict is `require_approval` or `deny`.
`.github/scripts/eval-summary.mjs` renders suites, pass counts, critical failures, metrics and failed
cases into the job summary. Results are uploaded as `eval-results-mock`.

```sh
pnpm eval:mock && node .github/scripts/eval-summary.mjs
```

## macOS app (`macos.yml`)

One job, `app`, on `macos-latest`. On push and pull requests it runs only when `apps/macos`, the
daemon, the sync service (`apps/sync`), a package they bundle or the vim behavior vectors
(`packages/editor/test/vim`, replayed by `DailyDoListVim`) change (the two path lists in the
workflow must stay in sync); a manual run always runs. It selects the newest non-beta Xcode, lints
the Swift formatting (`node scripts/lint.mjs --all --only swift`, strict swift-format), builds the
daemon and the sync service (the integration tests run two synced daemons through the real sync
service), runs every Swift package's tests (including the vim vector replay), compiles for iOS the
Foundation-only code the iPhone app will reuse (`DailyDoListModels`, `DailyDoListClient`,
`DailyDoListDomain`, `DailyDoListVim`, and `DailyDoListDrawing`'s `DailyDoListDrawingModel`
library, built as `DailyDoListDrawing:DailyDoListDrawingModel`), runs the integration tests
against the real daemon with the mock agent, builds a release "Daily Do List.app" with the bundled
daemon, smoke-tests the bundled `ddl-computer` (where the daemon looks for it, validly signed, and
answering the passive `hello` and `permissions` methods), and uploads the zipped app as the
`daily-do-list-macos` artifact (kept 14 days; ad hoc signed, not notarized).

```sh
node scripts/lint.mjs --all --only swift   # or pnpm lint:fix to format
pnpm --filter @ddl/daemon --filter @ddl/sync build
apps/macos/scripts/test.sh                 # every package, then the app shell
apps/macos/scripts/test.sh integration     # real daemon, mock agent
apps/macos/scripts/build-app.sh --release --with-daemon --zip
```

With only the Command Line Tools installed (no Xcode), `test.sh` adds the framework and rpath flags
Swift Testing needs.

## Linux bundle (`linux-bundle.yml`)

The always-on machine's kit (`deploy/linux`, see [ALWAYS_ON.md](./ALWAYS_ON.md)), only when the
kit, the daemon, the sync service, the web app or a package they bundle change (the two path
lists in the workflow must stay in sync). Both jobs run for x64 on `ubuntu-latest` and for arm64
on `ubuntu-24.04-arm` (GitHub's arm64 runners; the recommended Azure size is Arm64), each on its
own architecture, so there are four checks:

| Check | Runner |
| --- | --- |
| `Linux bundle (x64, smoke test)`, `Linux setup kit (x64, systemd)` | `ubuntu-latest` |
| `Linux bundle (arm64, smoke test)`, `Linux setup kit (arm64, systemd)` | `ubuntu-24.04-arm` |

- `bundle` builds `ddl-linux-<arch>.tar.gz` with `deploy/linux/build-bundle.sh`, then
  `deploy/linux/smoke-test.sh` unpacks it into a temporary folder and starts the sync service and
  the daemon (`DDL_AGENT_MODE=mock`, a temporary `DDL_HOME` and vault, free loopback ports, and
  the `config.json` that `setup.sh` writes: always-on placement, a remote host, the local sync
  service). `smoke-check.mjs` checks both health endpoints; the token, Host and proxy-header
  guards; the built web app on the loopback Host; a note reaching the sync service; the agent
  running as the always-on machine (placement `always_on_host`, lease held with priority
  `host`); and pairing: the pairing page on the remote Host (no token), a code from the `pair`
  CLI, `POST /api/pair` (single use), the device token on the remote Host, `devices`, and
  `revoke` (the token then gets 401). Tokens are never printed. Both processes must then stop
  cleanly on SIGTERM. The bundle is uploaded as the `ddl-linux-<arch>` artifact (kept 7 days).
- `setup` installs that bundle on a fresh runner (a disposable VM with systemd) with
  `deploy/linux/setup-test.sh`: `setup.sh` installs and starts the services (the agent in mock
  mode through the env file, which `setup.sh` must keep) and names the machine in the vault's
  settings; a second run, the installed copy and an upgrade through `--bundle` must leave the
  settings unchanged. It checks the service user, the `0700` folders and `0600` secrets,
  `config.json`, the root-owned release, `systemd-analyze verify` on the units, the services'
  sandbox from inside (no new privileges, read-only system, no `/home`, private `/tmp`, only
  their own folders writable), runs `smoke-check.mjs` as the service user against the running
  services (its CLI calls are the documented `sudo -u ddl -H node … pair`), stops both, and checks
  that no token reached any output or the journal. It runs only with `CI=true` or
  `DDL_SETUP_TEST_DISPOSABLE=1`; the kit's README shows how to run it in an OrbStack machine.

```sh
deploy/linux/build-bundle.sh                                   # this machine's CPU; --arch x64|arm64
deploy/linux/smoke-test.sh deploy/linux/build/ddl-linux-arm64.tar.gz   # Linux or macOS
```

## Budgets

| Budget | Defined in | Local | CI |
| --- | --- | --- | --- |
| Hot-path p99 latency | each `*.bench.ts` | ×1 | ×2 (`BENCH_BUDGET_MULTIPLIER`) |
| Unit-test timing guards ("stays fast" assertions) and default timeouts | those tests, `scripts/vitest/setup-fast-check.ts` | ×1 | ×5 (`TEST_TIME_SCALE`) |
| Swift performance tests (debug build) | `*PerformanceTests.swift` in the Swift packages | ×1 | ×4 (`PERF_BUDGET_MULTIPLIER`), editor ×2 (`EDITOR_PERF_BUDGET_MULTIPLIER`) |
| UI perf: startup, daily-note open, tab switch, thread open, keystroke latency, long tasks | `apps/web/e2e/perf/`, see `docs/PERFORMANCE.md` | ×1 | ×2 (`PERF_BUDGET_MULTIPLIER`) |
| Bundle size, gzip: initial JS ≤ 320 kB, initial CSS ≤ 40 kB, total JS ≤ 1300 kB | top of `scripts/bundle-size-check.mjs` | same | same |
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

The JavaScript/TypeScript analysis takes about two minutes and is the workflow's longest job. It
analyzes the test code too (about 40% of the TypeScript); a `paths-ignore` for `**/*.test.ts`,
`**/*.bench.ts`, `apps/web/e2e/**` and `packages/*/test/**` in a CodeQL config file would roughly
halve it, at the cost of findings in code that never ships. That trade is deliberately not made.

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

**Branch ruleset for `main`** (recommended, not enabled)

`main` has no protection today: the lead merges branches into `main` locally and pushes, with CI
dispatched on the branch and on `main` (see [How runs start today](#how-runs-start-today-by-hand)).
The ruleset to enable once work lands through pull requests:

- Require a pull request with at least one approval. Block force pushes and deletions.
- Required status checks: `Lint, typecheck, build`, `Unit tests (Linux, agent)`,
  `Unit tests (Linux, daemon)`, `Unit tests (Linux, rest)`, `Unit tests (macOS, daemon)`,
  `Unit tests (macOS, agent and storage)`, `Benchmarks`, `E2E (Playwright, 1/4)` … `4/4`,
  `Perf (Playwright)`, `Vim mode (vectors, vim.js suite, replay)`, `Evals (mock)`,
  `Secret scan (gitleaks)`, `CodeQL (javascript-typescript)`, `CodeQL (actions)`,
  `Dependency review`. Job names are the check names, so rename jobs deliberately.
- Either require branches to be up to date or use a merge queue; both workflows also run on
  `merge_group`. A job skipped by its condition (e.g. dependency review in the queue) counts as
  passing.

**Housekeeping**

- The issue templates use the default `bug` and `enhancement` labels.
