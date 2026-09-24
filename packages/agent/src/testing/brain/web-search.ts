/**
 * Fake OpenRouter web plugin: for `plugins: [{ id: "web" }]` requests (the `web_search` tool),
 * a short result list plus `url_citation` annotations on reserved example domains.
 */

import { excerpt, slugify, upperFirst } from "./text";
import { lastUserText } from "./transcript";
import type { AssistantTurn, BrainRequest, UrlCitation } from "./types";

const SOURCES = [
  {
    host: "https://www.example.com/guides",
    label: "guide",
    blurb: "A practical overview with the main options.",
  },
  {
    host: "https://example.org/reviews",
    label: "reviews",
    blurb: "Hands-on comparisons and prices.",
  },
  {
    host: "https://example.net/answers",
    label: "Q&A",
    blurb: "Common questions answered briefly.",
  },
];

export function searchResults(query: string, maxResults = 3): UrlCitation[] {
  const slug = slugify(query);
  const title = upperFirst(excerpt(query, 60));
  return SOURCES.slice(0, Math.max(1, Math.min(maxResults, SOURCES.length))).map((source) => ({
    url: `${source.host}/${slug}`,
    title: `${title} — ${source.label}`,
    content: source.blurb,
  }));
}

export function webSearchTurn(request: BrainRequest): AssistantTurn {
  const prompt = lastUserText(request.messages);
  const query = prompt.replace(/^Search query:\s*/i, "").trim() || "anything";
  const max = request.plugins?.find((plugin) => plugin.id === "web")?.max_results ?? 3;
  const citations = searchResults(query, max);
  const text = citations.map((c, i) => `${i + 1}. ${c.title} — ${c.url} — ${c.content}`).join("\n");
  return { text, citations };
}
