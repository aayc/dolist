#!/usr/bin/env node
// Keeps a cached SwiftPM build directory valid across CI checkouts. A checkout gives every file a
// new modification time, which makes the Swift driver recompile everything; the driver compares
// each source's time with the one it recorded. This records, next to the build, each tracked
// file's blob and time, and gives unchanged files their recorded time back after a restore.
// Changed and new files get the current time, which always differs from any recorded one, so
// they (and whatever depends on them) are rebuilt.
//
//   node apps/macos/scripts/ci-mtimes.mjs restore <build dir>   # after restoring the cache
//   node apps/macos/scripts/ci-mtimes.mjs save <build dir>      # after building, before saving it
//
// Times are whole seconds, so they survive any archive format exactly.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [command, buildDir] = process.argv.slice(2);
if (!["restore", "save"].includes(command) || !buildDir) {
  console.error("usage: ci-mtimes.mjs restore|save <build dir>");
  process.exit(2);
}
// The checkout this script is in (apps/macos/scripts/), wherever it runs from.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = join(resolve(buildDir), "ci-mtimes.json");

/** Tracked files under apps/macos: path → blob id. */
function trackedFiles() {
  const out = execFileSync("git", ["-C", repo, "ls-files", "-s", "-z", "--", "apps/macos"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Map();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [, blob] = record.slice(0, tab).split(" ");
    files.set(record.slice(tab + 1), blob);
  }
  return files;
}

const files = trackedFiles();
if (command === "restore") {
  const recorded = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).files : {};
  const now = Math.floor(Date.now() / 1000);
  let kept = 0;
  let changed = 0;
  for (const [path, blob] of files) {
    const entry = recorded[path];
    const time = entry && entry[0] === blob ? entry[1] : now;
    if (time === now) changed += 1;
    else kept += 1;
    utimesSync(join(repo, path), time, time);
  }
  console.log(`ci-mtimes: ${kept} unchanged file(s) keep their times, ${changed} changed or new`);
} else {
  const out = {};
  for (const [path, blob] of files) {
    out[path] = [blob, Math.floor(statSync(join(repo, path)).mtimeMs / 1000)];
  }
  mkdirSync(resolve(buildDir), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ version: 1, files: out }));
  console.log(`ci-mtimes: recorded ${files.size} file(s) in ${manifest}`);
}
