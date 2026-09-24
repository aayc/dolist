#!/usr/bin/env node
/**
 * Secret & sensitive-file scanner. This repository is PUBLIC — this runs as a pre-commit hook
 * (staged content) and in CI (all tracked files), alongside gitleaks in CI.
 *
 *   node scripts/check-secrets.mjs --staged   # scan the git index (pre-commit)
 *   node scripts/check-secrets.mjs --all      # scan tracked + untracked, non-ignored files
 *
 * False positive? Put `secret-scan:ignore` on the offending line (with a justification nearby).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const mode = process.argv.includes("--all") ? "all" : "staged";

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
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "aws-secret-key", re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    id: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    id: "generic-secret-assignment",
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{24,}["']/i,
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
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listFiles() {
  if (mode === "all")
    return git(["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean);
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).split("\n").filter(Boolean);
}

function readContent(path) {
  if (mode === "staged") return git(["show", `:${path}`]);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
  return readFileSync(path, "utf8");
}

function mask(value) {
  return value.length <= 10 ? "****" : `${value.slice(0, 6)}…(${value.length} chars)`;
}

const findings = [];
for (const path of listFiles()) {
  for (const rule of FORBIDDEN_FILES) {
    if (rule.re.test(path)) findings.push(`${path}: forbidden file — ${rule.why}`);
  }
  if (BINARY_EXT.test(path) || path.endsWith("pnpm-lock.yaml")) continue;
  let content;
  try {
    content = readContent(path);
  } catch {
    continue;
  }
  if (!content || content.includes("\u0000")) continue;
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("secret-scan:ignore")) return;
    for (const { id, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) findings.push(`${path}:${i + 1}: ${id} (${mask(m[0].trim())})`);
    }
  });
}

if (findings.length > 0) {
  console.error(
    `\n✖ check-secrets: ${findings.length} potential secret(s)/sensitive file(s) found:\n`,
  );
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    "\nThis repository is public. Remove the value (use env vars / ~/.daily-do-list/.env) or, for a verified false positive, add `secret-scan:ignore` to that line.\n",
  );
  process.exit(1);
}
console.log(`✔ check-secrets: no secrets found (${mode})`);
