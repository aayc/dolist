# DailyDoListDomain

Pure domain logic of Daily Do List for the native Swift apps, ported from the TypeScript core
(`packages/core/src`) so that the app computes **exactly** the same daily-note paths, task
identities and badge anchors as the daemon and the web app. Foundation only (plus the wire models
of `DailyDoListModels`); value types, `Sendable`, Swift 6 strict concurrency.

Exactness is proven by cross-language test vectors: a script runs the TypeScript core on a fixed
corpus (about 20,000 cases) and the Swift tests assert identical results.

## What is ported

| Swift | TypeScript (`packages/core/src`) |
| --- | --- |
| `LocalDate` (calendar math, ISO, instants ↔ dates) | `dates.ts` |
| `MomentFormat.format` / `.parse` / `.weekOfYear` | `dates.ts` (`formatLocalDate`, `formatDate`, `parseDateWithFormat`, `weekOfYear`) |
| `DailyNotes` (paths, parsing, listing, adjacency, navigation anchor, templates, weekly notes, window) | `daily-notes.ts` |
| `NoteTemplate.render` | `template.ts` |
| `VaultPath` | `paths.ts` |
| `TextTools` (`normalize`, `diceSimilarity`, `isPrefixExtension`, `truncate`, `hash`, `splitLines`) | `text.ts` |
| `TaskParser`, `ParsedTask`, `TaskStatus` | `markdown/tasks.ts` |
| `TaskTracker`, `TrackedTask`, `TaskDiff` | `markdown/task-tracker.ts` |
| `TaskAnchors`, `TaskAnchor` | `markdown/anchors.ts` (tasks) |
| `LineAnchors` (`anchorableLines`, `resolve`), `LineAnchor`, `AnchoredLine` | `markdown/anchors.ts` (`anchorableLines`, `resolveLineAnchors`) |
| `AgentText` (`parse`, `isAgentLine`, `stripMarker`, `marker`, `markLine`), `AgentLine` | `markdown/agent-text.ts` |
| `TextMerge` (`diffLines`, `merge`, `lines`), `LineHunk`, `MergeResult` | `merge.ts` (`diffLines`, `mergeText`) |
| `WikiLinks` (`parse`, `resolve`) | `markdown/wikilinks.ts` |
| `VaultTree` | `apps/web/src/features/explorer/tree.ts` |
| `RemoteAccess` (remote hosts, machine and sync service URLs, device names, pairing codes, sync ids) | `remote.ts`, `SYNC_ID_PATTERN` of `sync-service.ts` |
| `Fuzzy` | Swift-native, modeled on `apps/web/src/lib/fuzzy.ts` |

What "exactly" takes, beyond the algorithms:

- **Strings are UTF-16**, like JavaScript: lengths, offsets (`from`, `to`, `textFrom`, wikilink
  spans), bigrams, truncation and regex atoms count code units (an emoji is two). Comparisons use
  code units too (Swift's `==` equates NFC and NFD spellings; JavaScript's `===` doesn't).
- **JavaScript case mapping**: `toLowerCase()` with full mappings and the Final_Sigma rule
  (`ΟΔΟΣ` → `οδος`), and the case-insensitive regex rule used when parsing dates (a non-ASCII
  character never matches an ASCII one: `ſ` ≠ `s`, `K` ≠ `k`).
- **JavaScript whitespace** (`\s`, `trim()`): includes NBSP, U+2028/2029, U+3000, BOM….
- **Regex backtracking**: date formats are matched with the same first-match order as the regex
  the core builds (greedy digits, e.g. `YYYYMD` reads `202611` as January 1st); templates emulate
  `{{…}}`'s lazy format (`{{date:   }}` keeps one blank).
- **Local times like ECMAScript**: a wall-clock time skipped by a clock change reads with the
  offset from before the change (local midnight in a spring-forward gap is 01:00), repeated times
  resolve to the earlier instant. Every `Date` conversion takes a `TimeZone` (default `.current`).
- **Natural order** (`VaultPath.compare`, `VaultTree`): ICU collation as in
  `localeCompare(…, { numeric: true, sensitivity: "base" })`, via Foundation plus one fix (ICU
  sorts `ß` as `ss`; Foundation doesn't). Pass a `locale` (default `.current`).

### Beyond the TypeScript API

- The core **throws** when settings would put a note outside the vault (`../` in a folder or
  format). `DailyNotes.checkedPath`, `checkedWeeklyPath`, `checkedDate` and `VaultPath.validated` /
  `validatedJoin` throw `InvalidPathError` exactly where it does. `DailyNotes.path(for:)`,
  `weeklyPath`, `date(forPath:)` and `VaultPath.normalize` / `join` never fail: they agree on every
  valid input and drop an escaping `..` otherwise. `templatePath` returns nil for a template
  outside the vault.
- `DailyNotes.friendlyTitle(_:today:)`: a daily note's header title, "Thursday, September 24",
  with the year only when it isn't `today`'s ("Monday, December 29, 2025"). English, through
  `MomentFormat` like the web app's `formatLocalDate`, so both show the same text.
- `MomentFormat.parse(_:format:referenceYear:)`: a week without a year (`[W]ww`) resolves in
  `referenceYear` (default: the current year, like the core's `new Date().getFullYear()`).
- `TaskTracker.track(previous:parsed:now:similarityThreshold:idFactory:)` takes a non-escaping
  `idFactory`, so tests can count ids (`t1`, `t2`, …); the default makes `tsk_` + 10 base-36
  characters like the core. `TaskAnchor(record:)` and `LineAnchor(record:)` build anchors from a
  `TaskAgentRecord` (a task's, or one with `anchor == .line`).
- Agent markers (`%%agent:<threadId>%%` ending a line) are matched by scanning back from the end
  of the line, which finds the same match as the core's end-anchored regex. `TaskParser` leaves
  them out of task texts and notes and sets `ParsedTask.agent` (and `TrackedTask.agent`), like
  `parseTasks`. `AgentLine.markerFrom` is a UTF-16 offset.
- `TextMerge` compares lines by UTF-16 code units (NFC and NFD spellings differ, as in
  JavaScript) and keeps a `\r` with its line. Like the core, a deletion among identical lines can
  align with the other side's edit of another copy and report a conflict.
- `VaultTree`: nodes with stable ids (their paths), `outlineChildren` for `OutlineGroup`,
  `node(at:)`, `ancestors(of:)` / `revealing(_:in:)` to expand to a file, `visibleRows` for a flat
  outline list. Folders implied by file paths are created; distinct Unicode spellings of a folder
  stay distinct.
- `RemoteAccess` is checked against the core's own test cases (`RemoteAccessTests`), not
  vectors. URLs are read like the WHATWG parser reads them (IPv4 shorthands such as `127.1`,
  default ports, case), except that hosts must be ASCII (the core would convert an international
  name to punycode) and credentials are refused even when empty: stricter, never looser.
- `Fuzzy.match(_:in:)` / `Fuzzy.rank(query:candidates:limit:)` (and a keyed generic `rank`):
  case-insensitive subsequence matching with the web app's scoring (word starts after
  `space / \ - _ . : ( [ {`, camelCase humps and digits; first-character bonus; streaks; gap
  penalty; exact case breaks ties) plus path awareness: characters matched in the file name count
  extra and its first character counts like the very first one. Ties: shorter candidate, then
  input order. Offsets are UTF-16 for highlighting.

## Test vectors

`apps/macos/scripts/generate-vectors.ts` imports the TypeScript core from source and writes
`Tests/DailyDoListDomainTests/Vectors/*.json`:

| File | Cases | Covers |
| --- | ---: | --- |
| `dates-format.json` | 9,401 | every token on 781 dates 1900–2100 (year ends, leap days, week-year boundaries, odd and invalid years) × 68 formats with literals and unterminated brackets; instants; 13 time zones around clock changes (skipped midnights in Santiago, Havana, Beirut, São Paulo, Tehran; Samoa's skipped day; Lord Howe's 30-minute DST); `weekOfYear` for 10 (dow, doy) systems; `addDays`, `daysBetween`, compare, validity, ISO |
| `dates-parse.json` | 2,882 | round trips over 54 formats, curated rejections (weekday contradictions, week 53, day 366, case-insensitive names and literals, regex backtracking), seeded fuzz and mutations of valid inputs, `parseISODate` |
| `daily-notes.json` | 3,023 | 35 settings (folders with slashes, backslashes, NFD, root; nested and week formats; escaping settings that throw) × dates, path ↔ date round trips, noise paths, adjacency with gaps, listing, navigation anchors, template paths, weekly paths, windows |
| `template.json` | 330 | every variable form, blanks and case, braces edge cases, `$&` in titles, CRLF |
| `paths.json` | 2,380 | normalization (escapes, NUL, backslashes), every helper, `joinPath`, natural order pairs |
| `text.json` | 1,379 | normalization with every kind of whitespace and tricky case mappings, Dice, prefix extension, truncation around surrogates, cyrb53, line splitting |
| `wikilinks.json` | 325 | parsing (embeds, subpaths, aliases, empty and nested brackets, offsets after emoji) and resolution (case, NFC/NFD, extensions, shortest path) |
| `tasks.json` | 448 | 69 curated documents (fences, frontmatter limits, BOM, CRLF, nesting, notes, emoji/CJK/combining marks) + 220 seeded random documents (1,267 tasks), line edits, blank texts, statuses |
| `tracker.json` | 319 steps | 85 edit sequences: typing char by char, prefix extensions, typo fixes, reorders, duplicates, deletions, rewrites, thresholds, nesting, notes, Unicode, 45 seeded random edit sequences, and targeted cases that pin each matcher constant (distance weight and cap, prefix score, fuzzy budget and minimum window, duplicate alignment budget and ties, anchor lookup, score ties) |
| `anchors.json` | 89 | curated cases (deleted tasks, empty and duplicate ids, shared lines) and seeded random edits |
| `agent-text.json` | 592 | agent markers on 230 lines (ids of every length and alphabet, markers mid-line, blanks and tabs, emoji offsets) with `parseAgentLine`, `stripAgentMarker`, `markAgentLine` × 5 ids; `parseTasks` and `anchorableLines` on 86 documents with agent lines; `resolveLineAnchors` on 276 edited documents |
| `merge.json` | 607 | `diffLines` on 200 random line lists; `mergeText` on curated merges and 400 random edit pairs (insertions at the same place, adjacent hunks, deletions, conflicts, NFC/NFD, `\r`) |

Output is deterministic: times are formatted in `America/Los_Angeles` (the Swift tests use the
same `TimeZone`), `new Date()` / `Date.now()` are pinned to 2026-09-23 09:30 there, and every
random corpus comes from fast-check with a fixed seed. Strings are always well-formed UTF-16
(Swift strings can't hold lone surrogates). Biome formats the JSON; the check compares parsed
JSON, so formatting never makes a file stale.

```sh
pnpm exec tsx apps/macos/scripts/generate-vectors.ts          # regenerate (then commit)
pnpm exec tsx apps/macos/scripts/generate-vectors.ts --check  # CI: exit 1 with a diff summary if stale
```

Regenerate after changing anything in `packages/core/src` these files cover (or upgrading
fast-check, which may reshuffle the random corpus); a Swift failure then shows exactly which cases
the port has to follow. The tests read the files from the source tree (`#filePath`), so they are
excluded from the test target's resources.

Every constant and tie-break of the tracker is pinned by at least one vector (checked by mutating
the Swift port), except the duplicate-alignment tie scale (2^20): it only matters when summed line
distances within one group of identical tasks exceed a million.

## Running the tests

```sh
apps/macos/scripts/test.sh DailyDoListDomain                                  # all tests (debug)
apps/macos/scripts/test.sh DailyDoListDomain -- --filter PerformanceTests     # budgets only
apps/macos/scripts/test.sh DailyDoListDomain -- -c release --filter PerformanceTests
```

Suites run serially (they nest in `DomainTests`) so that the performance medians aren't skewed by
the vector suites; the whole run takes about a second. Tests only use the public API (no
`@testable`), so they also build in release. `PERF_BUDGET_MULTIPLIER` scales the budgets on slow
machines.

### Performance

Same shapes as the core's `tasks.bench.ts` (2,000-line note, ~1,200 tasks), median of 11 runs on
an Apple-silicon Mac:

| | Budget | Debug (test build) | Release |
| --- | ---: | ---: | ---: |
| `TaskParser.parse`, 2,000 lines | 5 ms | ~3.1 ms | ~0.36 ms |
| `TaskTracker.track`, one edited task | 15 ms | ~6.3 ms | ~0.75 ms |
| `TaskAnchors.resolve`, 50 anchors | 15 ms | ~7.6 ms | ~0.82 ms |

Hot loops work on UTF-16 buffers through raw pointers with `while` loops, and use flat
open-addressing tables instead of `Dictionary`: in unoptimized builds, array subscripts,
`for … in` ranges and generic collections cost 10–20× more.
