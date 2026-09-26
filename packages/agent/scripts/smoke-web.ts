/**
 * Live smoke test of `web_fetch` over the real network with the default address-pinned transport
 * (no API key needed), plus SSRF refusals. `web_search` runs too when an OpenRouter key is present.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/smoke-web.ts
 */
import { errorMessage, type ToolSpec, toolResultText } from "@ddl/core";
import { createOpenRouterClient } from "../src/llm/openrouter";
import { createWebTools, type WebFetchDetails } from "../src/tools/web";
import { loadOpenRouterKey } from "./lib/env";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  console.log(`  ${ok ? "✓" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run(tool: ToolSpec, input: Record<string, unknown>) {
  const started = performance.now();
  const result = await tool.execute(input, { toolCallId: "smoke" });
  return { result, text: toolResultText(result), ms: Math.round(performance.now() - started) };
}

async function main(): Promise<void> {
  const apiKey = await loadOpenRouterKey().catch(() => undefined);
  const llm = apiKey
    ? createOpenRouterClient({ apiKey, defaultModel: "deepseek/deepseek-v4.1-flash" })
    : undefined;
  const [webFetch, webSearch] = createWebTools(llm ? { llm } : {});
  if (!webFetch || !webSearch) throw new Error("web tools missing");

  console.log("web_fetch (live, pinned transport)");
  const example = await run(webFetch, { url: "https://example.com/" });
  console.log(`    ${example.ms}ms → ${example.text.replace(/\s+/g, " ").slice(0, 140)}`);
  check(
    "fetches and extracts a simple page",
    !example.result.isError && example.text.includes("Example Domain"),
  );

  const redirected = await run(webFetch, { url: "http://github.com/", maxChars: 2_000 });
  const details = redirected.result.details as WebFetchDetails | undefined;
  console.log(
    `    ${redirected.ms}ms → final ${details?.finalUrl} (${details?.status}), title "${details?.title}"`,
  );
  check(
    "follows http→https redirects",
    details?.finalUrl.startsWith("https://") === true && !redirected.result.isError,
  );

  const big = await run(webFetch, {
    url: "https://en.wikipedia.org/wiki/Lighthouse",
    maxChars: 3_000,
  });
  console.log(`    ${big.ms}ms → ${big.text.split("\n").slice(0, 6).join(" | ").slice(0, 200)}`);
  check(
    "large article truncated to maxChars with a notice",
    big.text.includes("[Content truncated") && !big.result.isError,
  );

  console.log("\nSSRF refusals");
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:7331/api/notes",
    "http://[::1]/",
    "http://10.0.0.1/",
  ]) {
    const refused = await run(webFetch, { url });
    check(
      `refuses ${url}`,
      refused.result.isError === true && /private or reserved/.test(refused.text),
      `${refused.ms}ms`,
    );
  }

  console.log("\nweb_search");
  const search = await run(webSearch, {
    query: "OpenRouter web search plugin documentation",
    maxResults: 3,
  });
  console.log(`    ${search.ms}ms → ${search.text.replace(/\s+/g, " ").slice(0, 240)}`);
  if (llm)
    check(
      "web search returns results with sources",
      !search.result.isError && search.text.includes("Sources:"),
      search.result.isError ? search.text : undefined,
    );
  else console.log("    (skipped check: no OPENROUTER_API_KEY)");

  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`✖ smoke-web failed: ${errorMessage(error)}`);
  process.exit(1);
});
