#!/usr/bin/env node
/**
 * Whether `turbo run <args>` would replay every task from the cache: prints `hit=true|false` and
 * appends it to $GITHUB_OUTPUT, so a job can skip setup that only a real run needs (installing the
 * browsers). `TURBO_FORCE=true` (runs on main) is never a hit.
 *
 *   node .github/scripts/turbo-hit.mjs e2e --filter=@ddl/web -- --shard=1/4
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const turboArgs = split === -1 ? args : args.slice(0, split);
const passThrough = split === -1 ? [] : args.slice(split);

let hit = false;
if (process.env.TURBO_FORCE !== "true") {
  const dry = execFileSync(
    "pnpm",
    ["exec", "turbo", "run", ...turboArgs, "--dry=json", ...passThrough],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const tasks = JSON.parse(dry).tasks.filter((task) => task.command !== "<NONEXISTENT>");
  hit = tasks.length > 0 && tasks.every((task) => task.cache?.status === "HIT");
}

console.log(`hit=${hit}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `hit=${hit}\n`);
