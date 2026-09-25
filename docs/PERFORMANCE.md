# Performance

The editor has to feel instant, and the agent has to feel alive. Both are measured on every change.

## UI budgets (Playwright, `pnpm e2e:perf`)

Measured against a production build with the in-browser mock backend (`?mock=1&perf=1`), so the
numbers reflect UI work only. `window.__ddlPerf` records named `performance.measure`s; the perf
spec writes `apps/web/perf-results.json`.

| Measure | What it covers | Budget |
| --- | --- | --- |
| `app:interactive` | navigation start → editor ready with today's note | 800 ms |
| `daily:open` | `⌘⇧D` keydown → today's note visible (cached / uncached) | 50 / 150 ms |
| `daily:prev` | `⌘⇧P` keydown → previous daily note visible | 50 / 150 ms |
| `tab:switch` | switching between a 2 000-line note and today's note | 30 ms |
| `thread:open` | badge click → thread rendered | 100 ms |
| `keystroke` (p95) | keydown → next frame after the DOM update, 2 000-line note | 16 ms |
| `keystroke (vim)` (p95) | the same with vim mode on: insert-mode typing, then normal-mode motions, `x` and `u` | 16 ms |
| long tasks | tasks > 50 ms while typing (both modes) | 0 |

CI multiplies budgets by `PERF_BUDGET_MULTIPLIER=2` (slower shared runners). The perf run disables
Chrome's frame-rate limiter so "→ next frame" measures work, not vsync alignment.

Latest local run (Apple Silicon): keystroke p95 1.6 ms (vim mode 1.8 ms), daily open ~4–5 ms, tab
switch 14 ms, thread open 9 ms, first load 106 ms, zero long tasks.

Vim mode adds one handler to the keystroke path. The mode indicator and pending-keys display in the
status bar update from one coalesced callback per keystroke, and only when the value changes, so
typing in insert mode renders no React.

## Launch: daemon and macOS app

| Measure | Now | Before |
| --- | --- | --- |
| Daemon spawn → first healthy `/api/health` (warm disk cache) | ~250 ms | ~810 ms |
| Daemon, first start after boot (cold disk cache) | ~400 ms | ~1 400 ms |
| macOS app: process start → today's note on screen (warm, managed daemon) | ~500 ms | ~2 200 ms |

Measure the daemon with a timer around spawn → token file → `/api/health`; the macOS app prints
its launch timeline with `DDL_BOOT_TRACE=1` (see `apps/macos/README.md`). The first launch after
installing or rebuilding the app is slower (~1–2 s) while macOS verifies the new binary.

What keeps it fast:

- **The daemon loads optional dependencies on first use.** It's bundled with esbuild code
  splitting: the agent runtime, the Pi harness (`@ddl/agent/pi`, ~400 ms to load) and Playwright
  (~150 ms, imported where Chrome launches) live outside `main.js`. `apps/daemon/build.mjs` fails
  the build if anything but the Pi harness chunk imports them statically. Never re-export them
  from a package index.
- **The app remembers where Node is.** Finding it means running the login shell and
  `node --version` (~300 ms); `$DDL_HOME/node-location.json` skips that while the binary is
  unchanged and is refreshed in the background after each launch.
- **No work on the launch path that scales with the bundle.** Launch-at-login only checks that
  the app is signed, not the hash of every bundled file (that alone cost ~300 ms, seconds cold).
- The supervisor polls a starting daemon every 20 ms (loopback requests are cheap).

## Micro-benchmarks (`pnpm bench` then `pnpm bench:check`)

Vitest 5 benchmarks (`*.bench.ts`) assert p99 budgets inside the test and write
`bench-results.json`; `scripts/bench-check.mjs` aggregates them. Budgets scale with
`BENCH_BUDGET_MULTIPLIER` (CI: 2).

| Benchmark | Budget (p99) |
| --- | --- |
| `parseTasks`, 2 000-line note | 4 ms |
| `trackTasks`, 2 000-line note, one edit | 12 ms |
| `resolveTaskAnchors`, 50 anchors in 2 000 lines | 12 ms |
| Editor: 500 single-char inserts, 2 000 lines, 30 badges | 500 ms |
| Live preview decorations, 60 / 150-line viewport | 2 / 4 ms |
| Agent-line decorations (agent text, markers), 150-line viewport | 1 ms |
| Vault listing / search, 2 000 notes (warm) | see `packages/storage/src/storage.bench.ts` |
| 3-way merge, 2 000-line note | see `packages/storage/src/storage.bench.ts` |

Note: Vitest warns that module export getters add overhead inside benchmarks (Vite's module
transform). That makes the numbers slightly pessimistic relative to production, which is fine for
budgets.

## Bundle budget (`pnpm build && pnpm size:check`)

| Bundle | Budget (gzip) | Current |
| --- | --- | --- |
| Initial JS (entry + static imports) | 320 kB | ~319 kB |
| Initial CSS | 40 kB | ~7 kB |
| Total JS | 1 200 kB | ~813 kB |

The initial JS is dominated by CodeMirror core and `@codemirror/lang-markdown`, which statically
embeds `@codemirror/lang-html` (and with it the JS/CSS parsers, ~60 kB gz). Vim is loaded on
demand — in parallel with startup when vim mode is on: `@ddl/editor`'s `vim.ts` is a tiny loader
in the main bundle, and `vim-integration.ts` (the engine plus ex commands, clipboard registers,
vimrc and the status plugin) is one lazy chunk of ~42 kB gz. Don't import `vim-integration` or
`@replit/codemirror-vim` statically. A future win: patch `lang-markdown` (via `pnpm patch`) to drop
the HTML embedding.

The app's own startup code is one chunk only while the entry reaches `app/services.ts` before the
modules it shares with the lazy chunks: importing `commands/labels` from `bootstrap.tsx` or
`commands/keyboard.ts` makes Rolldown split a `services` chunk out and costs ~1 kB gz. The tooltip
layer (~1.3 kB gz) is installed from `App` for that reason; the size check catches a regression.

## Design rules that keep it fast

- The keystroke path is O(line): no network, no full-document parse, no React render per keystroke.
  The editor is uncontrolled; persistence is debounced; badges are mapped through CodeMirror
  transactions and re-resolved at most every ~150 ms.
- One editor instance, one cached `EditorState` per open note: tab switches don't re-parse.
- Live preview decorates only the visible ranges with a single syntax-tree pass.
- Streaming agent text is appended to the DOM directly, not re-rendered through React per token.
- Secondary UI is code-split and prefetched on idle; a small "preloadable lazy" helper renders
  already-loaded chunks synchronously (plain `React.lazy` suspends even when prefetched).
- Startup fetches the tree, today's note, settings and agent status in parallel.

## Agent latency

The target is a visible acknowledgment on a new task within ~2–3 s of finishing typing: settle
(0.7 s after leaving the line, 2.5 s otherwise) + batch (150 ms) + the orchestrator's first tool
call. The triage eval measures time-to-first-tool-call (target p95 < 6 s with the live model);
orchestrator turns use low thinking effort for speed.

Where the time goes with the Cursor harness (measured against the real CLI, Apple Silicon):

| Step | Time |
| --- | --- |
| Our pipeline: note saved → task settled → orchestrator → subagent → done, fake model, settle excluded | ~7 ms |
| Settle (cursor left the line / otherwise) + batch window | 0.85 s / 2.65 s |
| A new CLI session: spawn + `initialize` ~0.35 s, the process's first `session/new` ~3 s | ~3.5 s |
| Resuming a session the harness suspended after 5 idle minutes | ~4.8 s |
| `session/set_model`, only when the model changed (the choice persists in the private config) | ~1.2 s |
| Model time to first token (Claude Opus 5.5, short prompt) | ~2.5 s |

Typing in a watched note, or a watched note changing on disk, warms the harness (at most every
5 s): the orchestrator's suspended session resumes in the background, so the ~4.8 s is spent while
you type and the task settles; and the Cursor harness starts and initializes a spare CLI for the
next session (~0.35 s off it, more when the machine is busy). The rest of a session's start can't
move earlier: the CLI reads the session's `AGENTS.md` during its first `session/new`, which is
also the slow part. `smoke-cursor.ts --prewarm` checks a session started from a spare CLI.
