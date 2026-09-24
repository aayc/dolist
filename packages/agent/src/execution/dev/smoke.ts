/**
 * Manual smoke test for the local execution provider (not part of CI; needs network):
 *
 *   pnpm --filter @ddl/agent exec tsx src/execution/dev/smoke.ts [--headed] [--computer] [--keep]
 *
 * Uses a throwaway DDL home (never your real profile). Opens https://example.com in the agent
 * browser, prints the snapshot, takes a screenshot and counts screencast frames. With --computer
 * (macOS) it also runs the permission check and takes one desktop screenshot — it never clicks or
 * types. Images are only written (to the temp dir) with --keep.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleLogger } from "@ddl/core";
import { createExecutionProvider } from "../index";
import type { FrameListener } from "../types";

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const home = await mkdtemp(join(tmpdir(), "ddl-smoke-"));
const provider = await createExecutionProvider(
  { kind: "local", home, browser: { headless: !args.has("--headed") } },
  { logger: createConsoleLogger("info") },
);
console.log("capabilities", provider.capabilities);

try {
  if (provider.browser) {
    const session = await provider.browser.session("smoke");
    const frames: Parameters<FrameListener>[0][] = [];
    const unsubscribe = session.onFrame((frame) => frames.push(frame));
    const started = performance.now();
    const snap = await session.navigate("https://example.com");
    console.log(
      `navigate: ${Math.round(performance.now() - started)}ms → ${snap.title} (${snap.url})`,
    );
    console.log(snap.snapshot);
    const link = /link "([^"]+)" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.snapshot);
    if (link) console.log(`first link: "${link[1]}" → ref ${link[2]}`);
    const shot = await session.screenshot();
    console.log(
      `screenshot: ${shot.width}×${shot.height} ${shot.mimeType}, ${shot.data.length} base64 chars`,
    );
    if (keep) await writeFile(join(home, "browser.jpg"), Buffer.from(shot.data, "base64"));
    await session.scroll("down", 200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    unsubscribe();
    const sample = frames.at(-1);
    console.log(
      `frames: ${frames.length} (actions: ${frames
        .map((f) => f.action?.kind)
        .filter(Boolean)
        .join(", ")})`,
      sample
        ? { url: sample.url, title: sample.title, size: `${sample.width}×${sample.height}` }
        : {},
    );
    const text = await session.extractText({ maxChars: 300 });
    console.log(`extractText: ${JSON.stringify(text)}`);
  } else {
    console.log("browser: unavailable (no Chrome/Chromium found)");
  }

  if (args.has("--computer")) {
    if (!provider.computer) {
      console.log("computer: unavailable on this platform/config");
    } else {
      console.log("computer.check()", await provider.computer.check());
      const shot = await provider.computer.screenshot();
      console.log(
        `desktop screenshot: ${shot.width}×${shot.height}, scale ${shot.scale.toFixed(4)} px/pt, ${shot.data.length} base64 chars`,
      );
      if (keep) await writeFile(join(home, "desktop.jpg"), Buffer.from(shot.data, "base64"));
    }
  }
} finally {
  await provider.dispose();
  if (keep) console.log(`kept outputs in ${home}`);
  else await rm(home, { recursive: true, force: true });
}
