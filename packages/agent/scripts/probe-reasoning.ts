/**
 * Measures how OpenRouter's `reasoning` parameter variants behave for a model (latency and
 * reasoning tokens), to pick the mapping used by the OpenRouter client and the Pi harness.
 *
 *   pnpm --filter @ddl/agent exec tsx scripts/probe-reasoning.ts [model] [rounds]
 */
import { OPENROUTER_BASE_URL } from "../src/llm/openrouter";
import { loadOpenRouterKey } from "./lib/env";

const model = process.argv[2] ?? "deepseek/deepseek-v4.1-flash";
const rounds = Number(process.argv[3] ?? 2);

const VARIANTS: Array<{ label: string; reasoning?: Record<string, unknown> }> = [
  { label: "default (omitted)" },
  { label: "effort:none", reasoning: { effort: "none" } },
  { label: "enabled:false", reasoning: { enabled: false } },
  { label: "exclude:true", reasoning: { exclude: true } },
  { label: "max_tokens:0", reasoning: { max_tokens: 0 } },
  { label: "effort:low", reasoning: { effort: "low" } },
  { label: "effort:low+exclude", reasoning: { effort: "low", exclude: true } },
  { label: "effort:high", reasoning: { effort: "high" } },
  { label: "effort:max", reasoning: { effort: "max" } },
];

const PROMPT =
  "A train leaves at 3:40pm and the trip takes 2h35m. When does it arrive? Answer briefly.";

async function main(): Promise<void> {
  const apiKey = await loadOpenRouterKey();
  console.log(`model=${model} rounds=${rounds}`);
  for (const variant of VARIANTS) {
    const latencies: number[] = [];
    const reasoningTokens: number[] = [];
    let status = "ok";
    let sample = "";
    let reasoningChars = 0;
    for (let i = 0; i < rounds; i++) {
      const started = performance.now();
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Daily Do List (probe)",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: PROMPT }],
          max_tokens: 2048,
          usage: { include: true },
          ...(variant.reasoning ? { reasoning: variant.reasoning } : {}),
        }),
      });
      const latency = Math.round(performance.now() - started);
      const body = (await response.json()) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string; reasoning?: string | null } }>;
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
      };
      if (!response.ok || body.error) {
        status = `HTTP ${response.status}: ${body.error?.message ?? "error"}`.slice(0, 160);
        break;
      }
      latencies.push(latency);
      reasoningTokens.push(body.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
      const message = body.choices?.[0]?.message;
      sample = (message?.content ?? "").replace(/\s+/g, " ").slice(0, 60);
      reasoningChars = message?.reasoning?.length ?? 0;
    }
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    console.log(
      `${variant.label.padEnd(20)} ${status === "ok" ? `avg ${String(avg).padStart(5)}ms  reasoning_tokens=[${reasoningTokens.join(",")}] reasoning_chars=${reasoningChars}  "${sample}"` : status}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
