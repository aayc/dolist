import type { CitedSource, ToolResult, ToolSpec } from "@ddl/core";
import { TOOL } from "../tools/contracts";

const MAX_SOURCES = 500;
const MAX_TITLE = 200;
const MAX_SNIPPET = 300;
/** Stops at `)` so a markdown link's URL ends where the link does. */
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+/g;

/**
 * Web pages the agents found or read in this process. When a thread cites one of them (in a
 * message or a note line it wrote), the thread keeps a copy as a `CitedSource`, which is all a
 * client ever shows in a citation preview.
 */
export class SourceCatalog {
  private readonly sources = new Map<string, CitedSource>();

  record(sources: readonly CitedSource[]): void {
    for (const source of sources) {
      const url = cleanUrl(source.url);
      if (!url) continue;
      const known = this.sources.get(url);
      this.sources.delete(url);
      this.sources.set(url, { ...known, ...source, url });
    }
    while (this.sources.size > MAX_SOURCES) {
      const oldest = this.sources.keys().next().value;
      if (oldest === undefined) break;
      this.sources.delete(oldest);
    }
  }

  /** The known pages among those `text` links to, in order of appearance. */
  citedIn(text: string): CitedSource[] {
    const out = new Map<string, CitedSource>();
    for (const match of text.matchAll(URL_RE)) {
      const url = cleanUrl(match[0]);
      const source = url ? this.sources.get(url) : undefined;
      if (source && !out.has(source.url)) out.set(source.url, source);
    }
    return [...out.values()];
  }

  /** `tool` (web_search / web_fetch), remembering the pages its results describe. */
  observe(tool: ToolSpec): ToolSpec {
    if (tool.name !== TOOL.webSearch && tool.name !== TOOL.webFetch) return tool;
    return {
      ...tool,
      execute: async (input, ctx) => {
        const result = await tool.execute(input, ctx);
        this.record(sourcesFromResult(tool.name, result));
        return result;
      },
    };
  }
}

/** What a web tool's result says about the pages it found (search) or read (fetch). */
export function sourcesFromResult(toolName: string, result: ToolResult): CitedSource[] {
  if (result.isError) return [];
  const details = (result.details ?? {}) as Record<string, unknown>;
  if (toolName === TOOL.webSearch) {
    const citations = Array.isArray(details.citations) ? details.citations : [];
    return citations.flatMap((citation): CitedSource[] => {
      if (typeof citation !== "object" || citation === null) return [];
      const c = citation as Record<string, unknown>;
      if (typeof c.url !== "string") return [];
      return [
        source(
          c.url,
          typeof c.title === "string" ? c.title : undefined,
          typeof c.content === "string" ? c.content : undefined,
        ),
      ];
    });
  }
  if (toolName === TOOL.webFetch) {
    const url = typeof details.finalUrl === "string" ? details.finalUrl : details.url;
    if (typeof url !== "string") return [];
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    // The page text follows the Title/URL header and a blank line.
    const body = text.split("\n\n").slice(1).join(" ");
    const title = typeof details.title === "string" ? details.title : undefined;
    const fetched = [source(url, title, body)];
    return typeof details.url === "string" && details.url !== url
      ? [...fetched, source(details.url, title, body)]
      : fetched;
  }
  return [];
}

function source(url: string, title?: string, snippet?: string): CitedSource {
  const out: CitedSource = { url };
  const cleanTitle = title?.replace(/\s+/g, " ").trim();
  const cleanSnippet = snippet?.replace(/\s+/g, " ").trim();
  if (cleanTitle) out.title = clip(cleanTitle, MAX_TITLE);
  if (cleanSnippet) out.snippet = clip(cleanSnippet, MAX_SNIPPET);
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The URL without trailing sentence punctuation; null for anything but http(s). */
function cleanUrl(raw: string): string | null {
  const url = raw.trim().replace(/[.,;:!?]+$/, "");
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}
