#!/usr/bin/env node
/**
 * Secret & sensitive-file scanner. This repository is PUBLIC — this runs as a pre-commit hook
 * (staged content), as a pre-push hook (every commit about to be pushed) and in CI (all tracked
 * files), alongside gitleaks.
 *
 *   node scripts/check-secrets.mjs --staged              # scan the git index (pre-commit)
 *   node scripts/check-secrets.mjs --all                 # scan tracked + untracked, non-ignored files
 *   node scripts/check-secrets.mjs --range "<revisions>" # scan what those commits add (pre-push),
 *                                                        # e.g. "origin/main..HEAD" or "--all"
 *
 * False positive? Put `secret-scan:ignore` on the offending line (with a justification nearby).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const rangeIndex = process.argv.indexOf("--range");
const mode = rangeIndex !== -1 ? "range" : process.argv.includes("--all") ? "all" : "staged";

/** Files that must never be committed, regardless of content. */
const FORBIDDEN_FILES = [
  {
    re: /(^|\/)\.env(\.(?!example$)[^/]+)?$/,
    why: "environment file (use .env.example for templates)",
  },
  { re: /\.(pem|key|p12|pfx|keystore|jks)$/i, why: "private key / certificate material" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, why: "SSH key" },
  { re: /(^|\/)\.(netrc|npmrc\.local|pypirc|vault-token)$/, why: "credential file" },
  {
    re: /(^|\/)[^/]*_history$|(^|\/)\.(bash|zsh|python|node_repl)_history$/,
    why: "shell/REPL history",
  },
  { re: /(^|\/)(credentials|service-account)[^/]*\.json$/i, why: "cloud credentials" },
  { re: /(^|\/)\.daily-do-list\//, why: "local agent state (threads, approvals, workspaces)" },
  { re: /(^|\/)daemon-token$/, why: "local daemon bearer token" },
  { re: /(^|\/)sync-token$/, why: "sync service vault token" },
  { re: /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i, why: "database (may hold vault contents)" },
  { re: /(^|\/)(auth|secrets?)\.json$/i, why: "auth/secrets file" },
];

/** Content patterns. Keep specific to avoid noise; each has a stable id for reporting. */
const PATTERNS = [
  { id: "openrouter-key", re: /sk-or-(?:v1-)?[a-f0-9]{48,}/ },
  { id: "anthropic-key", re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}/ },
  {
    id: "openai-key",
    re: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/,
  },
  { id: "openai-legacy-key", re: /\bsk-[A-Za-z0-9]{48}\b/ },
  { id: "cursor-api-key", re: /\b(?:cursor_[A-Za-z0-9_-]{24,}|key_[a-f0-9]{48,})\b/ },
  { id: "xai-key", re: /\bxai-[A-Za-z0-9]{40,}\b/ },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "aws-secret-key", re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    id: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "bearer-token", re: /\bBearer\s+(?![$<{])[A-Za-z0-9._~+/-]{24,}/ },
  {
    id: "generic-secret-assignment",
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{24,}["']/i,
  },
  // `.env`/shell/YAML-style `SOME_API_KEY=value` with a literal value (not `$VAR`, `<placeholder>`).
  {
    id: "env-secret-assignment",
    re: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|SECRET|PASSWORD)\s*[:=]\s*["']?(?![$<{(`])[A-Za-z0-9/+_.=-]{16,}/,
  },
  // Personal absolute paths leak usernames/machine layout; use `~` or env vars instead.
  {
    id: "absolute-home-path",
    re: /(?:^|[\s"'`(=])\/(?:Users|home)\/(?!runner\b|user\b|me\b|you\b|<)[a-z][a-z0-9._-]+\//i,
  },
];

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|wasm)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function git(args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function mask(value) {
  return value.length <= 10 ? "****" : `${value.slice(0, 6)}…(${value.length} chars)`;
}

const findings = [];

function checkPath(path, where = path) {
  for (const rule of FORBIDDEN_FILES) {
    if (rule.re.test(path)) findings.push(`${where}: forbidden file — ${rule.why}`);
  }
}

function checkLine(where, line) {
  if (line.includes("secret-scan:ignore")) return;
  for (const { id, re } of PATTERNS) {
    const m = re.exec(line);
    if (m) findings.push(`${where}: ${id} (${mask(m[0].trim())})`);
  }
}

function skipsContent(path) {
  return BINARY_EXT.test(path) || path.endsWith("pnpm-lock.yaml");
}

/** Working tree or index: every line of every file. */
function scanFiles() {
  const files =
    mode === "all"
      ? git(["ls-files", "-co", "--exclude-standard"])
      : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  for (const path of files.split("\n").filter(Boolean)) {
    checkPath(path);
    if (skipsContent(path)) continue;
    let content;
    try {
      if (mode === "staged") {
        content = git(["show", `:${path}`]);
      } else {
        const st = statSync(path, { throwIfNoEntry: false });
        content = st?.isFile() && st.size <= MAX_BYTES ? readFileSync(path, "utf8") : null;
      }
    } catch {
      continue;
    }
    if (!content || content.includes("\u0000")) continue;
    content.split("\n").forEach((line, i) => {
      checkLine(`${path}:${i + 1}`, line);
    });
  }
}

/** Commits: the files they add and every line they add (what a push would publish). */
function scanRange(revisions) {
  const names = git(["log", "--format=", "--name-only", "--diff-filter=ACMR", ...revisions]);
  for (const path of new Set(names.split("\n").filter(Boolean))) checkPath(path);

  const log = git(["log", "--no-color", "-p", "--unified=0", "--format=%x00%h", ...revisions]);
  let commit = "";
  let path = null;
  let lineNumber = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("\u0000")) {
      commit = line.slice(1);
      path = null;
    } else if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : null;
    } else if (line.startsWith("@@")) {
      lineNumber = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (line.startsWith("+") && path && !skipsContent(path)) {
      checkLine(`${path}:${lineNumber} (commit ${commit})`, line.slice(1));
      lineNumber++;
    }
  }
}

if (mode === "range") {
  const revisions = (process.argv[rangeIndex + 1] ?? "").split(/\s+/).filter(Boolean);
  if (revisions.length === 0) {
    console.error("check-secrets: --range needs revisions, e.g. --range origin/main..HEAD");
    process.exit(2);
  }
  scanRange(revisions);
} else {
  scanFiles();
}

if (findings.length > 0) {
  console.error(
    `\n✖ check-secrets: ${findings.length} potential secret(s)/sensitive file(s) found:\n`,
  );
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    "\nThis repository is public. Remove the value (use env vars / ~/.daily-do-list/.env) or, for a verified false positive, add `secret-scan:ignore` to that line.\n",
  );
  if (mode === "range") {
    console.error(
      "The value is in a commit: fix it with `git commit --amend` or an interactive rebase before pushing, then rotate the secret if it was real.\n",
    );
  }
  process.exit(1);
}
console.log(`✔ check-secrets: no secrets found (${mode})`);
