/**
 * Smoke test of the OpenRouter client: plain completion, json_schema output, reasoning off vs
 * default latency, and web-plugin search with citations.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/smoke-llm.ts [--offline] [--rounds=2]
 *
 * `--offline` targets a local mock of OpenRouter (latencies there are simulated). The API key is
 * read from the environment or ~/.daily-do-list/.env and never printed.
 */
import { createConsoleLogger } from "@ddl/core";
import { createOpenRouterClient } from "../src/llm/openrouter";
import {
  type LlmClient,
  type LlmCompletionRequest,
  LlmError,
  type ReasoningEffort,
} from "../src/llm/types";
import { loadOpenRouterKey } from "./lib/env";
import { type MockOpenRouter, startMockOpenRouter } from "./lib/mock-openrouter";

const MODEL = "deepseek/deepseek-v4.1-flash";
const offline = process.argv.includes("--offline");
const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 2);

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  console.log(`  ${ok ? "✓" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function timed(llm: LlmClient, request: LlmCompletionRequest) {
  const started = performance.now();
  const completion = await llm.complete(request);
  return { completion, wallMs: Math.round(performance.now() - started) };
}

async function main(): Promise<void> {
  let mock: MockOpenRouter | undefined;
  try {
    mock = offline ? await startMockOpenRouter() : undefined;
    const llm = createOpenRouterClient({
      apiKey: offline ? "offline-mock-key" : await loadOpenRouterKey(),
      defaultModel: MODEL,
      ...(mock ? { baseUrl: mock.baseUrl } : {}),
      logger: createConsoleLogger("warn"),
    });
    console.log(
      `OpenRouter client smoke test — ${offline ? "OFFLINE (local mock, simulated latency)" : "LIVE"} — ${MODEL}\n`,
    );

    console.log("1. plain completion (reasoning off)");
    const plain = await timed(llm, {
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      reasoning: "off",
      maxTokens: 20,
      purpose: "smoke",
    });
    console.log(
      `  → "${plain.completion.text.trim()}" in ${plain.completion.latencyMs}ms, ${usage(plain.completion)}`,
    );
    check("plain completion returned text", plain.completion.text.trim().length > 0);

    console.log("\n2. json_schema structured output");
    const structured = await timed(llm, {
      system: "Extract the requested fields.",
      messages: [
        { role: "user", content: "It is a mild 21 degrees Celsius in Paris this afternoon." },
      ],
      jsonSchema: {
        name: "weather",
        schema: {
          type: "object",
          properties: { city: { type: "string" }, temperatureC: { type: "number" } },
          required: ["city", "temperatureC"],
          additionalProperties: false,
        },
      },
      reasoning: "off",
      maxTokens: 100,
      purpose: "smoke",
    });
    console.log(
      `  → ${JSON.stringify(structured.completion.json)} in ${structured.completion.latencyMs}ms, ${usage(structured.completion)}`,
    );
    const parsed = structured.completion.json as
      | { city?: string; temperatureC?: number }
      | undefined;
    check("structured output parsed", parsed?.city === "Paris" && parsed.temperatureC === 21);

    console.log(`\n3. reasoning latency (${rounds} rounds each)`);
    const question =
      "A train leaves at 3:40pm and the trip takes 2h35m. When does it arrive? Answer briefly.";
    const efforts: Array<ReasoningEffort | undefined> = ["off", undefined, "low"];
    const averages = new Map<string, number>();
    for (const effort of efforts) {
      const latencies: number[] = [];
      const outputs: number[] = [];
      let answer = "";
      for (let i = 0; i < rounds; i++) {
        const { completion } = await timed(llm, {
          messages: [{ role: "user", content: question }],
          ...(effort ? { reasoning: effort } : {}),
          maxTokens: 4_000,
          purpose: "smoke",
        });
        latencies.push(completion.latencyMs);
        outputs.push(completion.usage.outputTokens);
        answer = completion.text.trim().replace(/\s+/g, " ").slice(0, 60);
      }
      const label = effort ?? "default";
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      averages.set(label, avg);
      console.log(
        `  ${label.padEnd(8)} avg ${String(avg).padStart(5)}ms  output tokens [${outputs.join(", ")}]  "${answer}"`,
      );
    }
    const off = averages.get("off") ?? 0;
    const fallback = averages.get("default") ?? 0;
    check("reasoning off is faster than the default", off < fallback, `${off}ms vs ${fallback}ms`);

    console.log("\n4. web plugin search");
    const search = await timed(llm, {
      system: "List the most relevant results with their URLs. Be brief.",
      messages: [{ role: "user", content: "Search query: what is example.com used for" }],
      plugins: [{ id: "web", max_results: 3 }],
      reasoning: "off",
      maxTokens: 400,
      purpose: "smoke",
    });
    console.log(`  → ${search.completion.text.trim().replace(/\s+/g, " ").slice(0, 160)}…`);
    for (const citation of search.completion.citations ?? [])
      console.log(`    · ${citation.title ?? "(untitled)"} — ${citation.url}`);
    console.log(`  ${search.completion.latencyMs}ms, ${usage(search.completion)}`);
    check("web search returned citations", (search.completion.citations?.length ?? 0) > 0);

    if (mock) {
      const bodies = mock.requests.map((r) => r.body);
      check(
        "reasoning off sent as effort none",
        bodies.some((b) => JSON.stringify(b.reasoning) === '{"effort":"none"}'),
      );
      check(
        "json_schema sent as strict response_format",
        bodies.some((b) => (JSON.stringify(b.response_format) ?? "").includes('"strict":true')),
      );
      check(
        "usage accounting requested",
        bodies.every((b) => JSON.stringify(b.usage) === '{"include":true}'),
      );
    }
  } catch (error) {
    if (error instanceof LlmError) {
      const hint =
        error.status === 401
          ? " — OpenRouter rejected the API key; update OPENROUTER_API_KEY in ~/.daily-do-list/.env"
          : "";
      check(
        "OpenRouter request succeeded",
        false,
        `${error.message} (status ${error.status ?? "n/a"}, retryable ${error.retryable})${hint}`,
      );
    } else {
      throw error;
    }
  } finally {
    await mock?.close();
  }
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function usage(completion: {
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}): string {
  const cost =
    completion.usage.costUsd === undefined ? "cost n/a" : `$${completion.usage.costUsd.toFixed(6)}`;
  return `${completion.usage.inputTokens} in / ${completion.usage.outputTokens} out, ${cost}`;
}

main().catch((error: unknown) => {
  console.error(`✖ smoke-llm failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
