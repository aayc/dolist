#!/usr/bin/env node
// Points git at the repo's versioned hooks (.githooks). No-op outside a git checkout (e.g. CI tarballs).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git") || process.env.CI) process.exit(0);
try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // Not fatal: hooks are a convenience; CI enforces the same checks.
}
