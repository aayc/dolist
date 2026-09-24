#!/usr/bin/env node
/**
 * File hygiene the formatters don't cover, for every kind of file. Runs from `scripts/lint.mjs`:
 * in the pre-commit hook (staged content) and in `pnpm lint` / CI (every file).
 *
 *   node scripts/check-hygiene.mjs --staged   # the git index (pre-commit)
 *   node scripts/check-hygiene.mjs --all      # tracked + untracked, non-ignored files
 *
 * - no merge-conflict markers
 * - LF line endings, a final newline, no trailing whitespace (Markdown may end a line with spaces:
 *   two of them are a line break, see .editorconfig)
 * - nothing over 1 MiB except the generated test vectors
 * - no two paths that differ only in case (they collide on macOS and Windows checkouts)
 * - shell scripts and git hooks are executable, and executables start with a shebang
 * - relative Markdown links point at files that exist in the repository
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, normalize } from "node:path/posix";

const mode = process.argv.includes("--all") ? "all" : "staged";

const MAX_BYTES = 1024 * 1024;
/** Generated test data that is big by design (each is regenerated, never edited by hand). */
const BIG_BY_DESIGN = [/^packages\/editor\/test\/vim\/vectors\.jsonl$/];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|wasm)$/i;
/** Test fixtures whose exact bytes are the test (truncated files, CRLF, BOMs). */
const VERBATIM = /(^|\/)fixtures\//;
/** Patches carry diff context lines, where a trailing space is content. */
const KEEPS_TRAILING_SPACE = /\.(md|patch|diff)$/i;
const MUST_BE_EXECUTABLE = /(^\.githooks\/[^/]+$|\.sh$)/;
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/;

function git(args, options = {}) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
}

function list(output) {
  return output.split("\0").filter(Boolean);
}

/** Index modes (`100755` = executable) of every tracked or staged path. */
function indexModes() {
  const modes = new Map();
  for (const entry of list(git(["ls-files", "-s", "-z"]))) {
    const tab = entry.indexOf("\t");
    modes.set(entry.slice(tab + 1), entry.slice(0, 6));
  }
  return modes;
}

const modes = indexModes();
const repoPaths =
  mode === "all"
    ? list(git(["ls-files", "-co", "--exclude-standard", "-z"]))
    : list(git(["ls-files", "-z"]));
const checked =
  mode === "all"
    ? repoPaths
    : list(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));

const findings = [];
const report = (where, problem) => findings.push(`${where}: ${problem}`);

function read(path) {
  try {
    if (mode === "staged") return git(["show", `:${path}`], { encoding: "buffer" });
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

function isExecutable(path) {
  const indexed = modes.get(path);
  if (mode === "staged" || indexed) return indexed === "100755";
  return ((statSync(path, { throwIfNoEntry: false })?.mode ?? 0) & 0o111) !== 0;
}

function checkText(path, text) {
  const lines = text.split("\n");
  if (text.length > 0 && !text.endsWith("\n")) report(path, "no newline at the end of the file");
  let crlf = false;
  lines.forEach((line, i) => {
    const where = `${path}:${i + 1}`;
    if (line.includes("\r") && !crlf) {
      crlf = true;
      report(where, "CRLF line ending (use LF)");
    }
    if (CONFLICT_MARKER.test(line)) report(where, "merge-conflict marker");
    if (!KEEPS_TRAILING_SPACE.test(path) && /[ \t]+\r?$/.test(line)) {
      report(where, "trailing whitespace");
    }
  });
  if (path.endsWith(".md")) checkLinks(path, lines);
}

const known = new Set(repoPaths);
const knownDirs = new Set(repoPaths.flatMap((p) => ancestors(p)));

function ancestors(path) {
  const dirs = [];
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    dirs.push(path.slice(0, i));
  }
  return dirs;
}

const INLINE_LINK = /\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s<>]+)>?/;
const HTML_LINK = /\b(?:href|src)="([^"]+)"/g;

/** Links GitHub resolves inside the repository: no scheme, not just an anchor. */
function localTarget(raw) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) return null;
  const target = raw.replace(/[?#].*$/, "");
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function checkLinks(path, lines) {
  let fence = null;
  lines.forEach((line, i) => {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (!fence) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const prose = line.replace(/`+[^`]*`+/g, "");
    const targets = [
      ...[...prose.matchAll(INLINE_LINK)].map((m) => m[1]),
      ...[...prose.matchAll(HTML_LINK)].map((m) => m[1]),
      REFERENCE_LINK.exec(prose)?.[1],
    ];
    for (const raw of targets) {
      const target = raw && localTarget(raw);
      if (!target) continue;
      const resolved = normalize(
        target.startsWith("/") ? target.slice(1) : `${dirname(path)}/${target}`,
      ).replace(/\/$/, "");
      // Above the repository root, a relative link is a GitHub page (`../../security/…`).
      if (resolved.startsWith("..")) continue;
      if (!(known.has(resolved) || knownDirs.has(resolved))) {
        report(`${path}:${i + 1}`, `broken link to ${raw}`);
      }
    }
  });
}

for (const path of checked) {
  const content = read(path);
  if (!content) continue;
  if (content.length > MAX_BYTES && !BIG_BY_DESIGN.some((re) => re.test(path))) {
    report(path, `${(content.length / 1024 / 1024).toFixed(1)} MiB (limit 1 MiB)`);
  }
  const executable = isExecutable(path);
  const shebang = content.subarray(0, 2).toString() === "#!";
  if (MUST_BE_EXECUTABLE.test(path) && !executable) {
    report(path, "not executable (git add --chmod=+x)");
  } else if (executable && !shebang) {
    report(path, "executable without a #! line (git add --chmod=-x)");
  }
  if (BINARY_EXT.test(path) || VERBATIM.test(path) || content.includes(0)) continue;
  checkText(path, content.toString("utf8"));
}

const byLowerCase = new Map();
for (const path of repoPaths) {
  const key = path.toLowerCase();
  byLowerCase.set(key, [...(byLowerCase.get(key) ?? []), path]);
}
const checkedSet = new Set(checked);
for (const paths of byLowerCase.values()) {
  if (paths.length > 1 && paths.some((p) => checkedSet.has(p))) {
    report(paths.join(", "), "paths differ only in case");
  }
}

if (findings.length > 0) {
  console.error(`\n✖ check-hygiene: ${findings.length} problem(s):\n`);
  for (const f of findings) console.error(`  ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`✔ check-hygiene: ${checked.length} file(s) ok (${mode})`);
