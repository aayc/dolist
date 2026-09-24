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
| long tasks | tasks > 50 ms while typing | 0 |

CI multiplies budgets by `PERF_BUDGET_MULTIPLIER=2` (slower shared runners). The perf run disables
Chrome's frame-rate limiter so "→ next frame" measures work, not vsync alignment.

Latest local run (Apple Silicon): keystroke p95 1.7 ms, daily open ~4–5 ms, tab switch 8 ms,
thread open 15 ms, first load 105 ms, zero long tasks.

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
| Vault listing / search, 2 000 notes (warm) | see `packages/storage/src/storage.bench.ts` |
| 3-way merge, 2 000-line note | see `packages/storage/src/storage.bench.ts` |

Note: Vitest warns that module export getters add overhead inside benchmarks (Vite's module
transform). That makes the numbers slightly pessimistic relative to production, which is fine for
budgets.

## Bundle budget (`pnpm build && pnpm size:check`)

| Bundle | Budget (gzip) | Current |
| --- | --- | --- |
| Initial JS (entry + static imports) | 320 kB | ~307 kB |
| Initial CSS | 40 kB | ~5 kB |
| Total JS | 1 200 kB | ~790 kB |

The initial JS is dominated by CodeMirror core and `@codemirror/lang-markdown`, which statically
embeds `@codemirror/lang-html` (and with it the JS/CSS parsers, ~60 kB gz). Vim (~300 kB of
source) is loaded on demand — in parallel with startup when vim mode is on. A future win: patch
`lang-markdown` (via `pnpm patch`) to drop the HTML embedding.

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
