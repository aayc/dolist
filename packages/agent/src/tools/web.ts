/**
 * Read-only web tools: `web_fetch` (GET a URL, HTML → readable text) and `web_search` (OpenRouter
 * web plugin via the LlmClient). `web_fetch` refuses private/reserved network destinations on every
 * hop, and the default transport pins connections to the addresses it validated so DNS rebinding
 * cannot swap in an internal address between the check and the connection.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import {
  errorResult,
  type Logger,
  silentLogger,
  type ToolResult,
  type ToolSpec,
  textResult,
  truncate,
} from "@ddl/core";
import type { LlmClient, LlmUrlCitation } from "../llm/types";
import { TOOL } from "./contracts";

export type LookupAddresses = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface WebToolsOptions {
  /** Required by `web_search`; without it the tool returns an error result. */
  llm?: LlmClient;
  /** Replaces the default address-pinned transport (tests, custom environments). */
  fetch?: typeof fetch;
  /** DNS resolution used for SSRF checks. Default: `dns.promises.lookup` with `all: true`. */
  lookup?: LookupAddresses;
  logger?: Logger;
  /** Model for `web_search`. Default: the LLM client's default model. */
  searchModel?: string;
}

export interface WebFetchDetails {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  truncated: boolean;
}

export interface WebSearchDetails {
  query: string;
  model: string;
  citations: LlmUrlCitation[];
  costUsd?: number;
}

export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 100_000;
const MIN_MAX_CHARS = 200;
const ERROR_BODY_CHARS = 1_500;
const MIN_READABLE_CHARS = 200;
const SEARCH_TIMEOUT_MS = 45_000;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const USER_AGENT = "Mozilla/5.0 (compatible; DailyDoList/0.1; +web_fetch)";
const REQUEST_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5",
};

export function createWebTools(options: WebToolsOptions = {}): ToolSpec[] {
  const lookup = options.lookup ?? defaultLookup;
  const custom = options.fetch;
  const transport: WebTransport = custom
    ? (url, init) => custom(url, init)
    : createPinnedTransport(lookup);
  const logger = (options.logger ?? silentLogger).child({ component: "web-tools" });
  return [createWebFetchTool(transport, lookup, logger), createWebSearchTool(options, logger)];
}

// ── web_fetch ────────────────────────────────────────────────────────────────

export interface WebTransportInit {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
}

export type WebTransport = (url: string, init: WebTransportInit) => Promise<Response>;

/** The default transport: node:http(s) GET whose sockets connect only to SSRF-checked addresses. */
export function createPinnedTransport(lookup: LookupAddresses = defaultLookup): WebTransport {
  const guarded = guardedLookup(lookup);
  return (url, init) => pinnedRequest(url, init, guarded);
}

function createWebFetchTool(
  transport: WebTransport,
  lookup: LookupAddresses,
  logger: Logger,
): ToolSpec {
  return {
    name: TOOL.webFetch,
    label: "Fetch web page",
    description:
      "Fetch a public http(s) URL with a GET request and return its readable content (HTML is converted to text with headings, lists and key links). Cannot log in, submit forms or run JavaScript — use the browser tools for that.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
        maxChars: {
          type: "integer",
          minimum: MIN_MAX_CHARS,
          maximum: MAX_MAX_CHARS,
          description: `Maximum characters of content to return (default ${DEFAULT_MAX_CHARS}).`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    safety: {
      readOnly: true,
      category: "network",
      describe: (input) => `Fetch ${truncate(stringField(input, "url") ?? "a web page", 160)}`,
    },
    promptGuidelines: [
      "Use to read a specific page; prefer canonical URLs over tracking or redirect links.",
    ],
    async execute(input, ctx) {
      const parsed = parseFetchInput(input);
      if ("error" in parsed) return errorResult(parsed.error);
      const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      try {
        const page = await fetchPage(parsed.url, transport, lookup, signal);
        return renderPage(page, parsed.maxChars);
      } catch (error) {
        if (ctx.signal?.aborted) return errorResult("Fetch aborted");
        if (timeout.aborted) {
          return errorResult(
            `Timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s fetching ${parsed.url.href}`,
          );
        }
        if (error instanceof BlockedUrlError) return errorResult(error.message);
        logger.debug("fetch failed", { url: parsed.url.href, error: messageOf(error) });
        return errorResult(`Fetch failed for ${parsed.url.href}: ${messageOf(error)}`);
      }
    },
  };
}

function parseFetchInput(input: unknown): { url: URL; maxChars: number } | { error: string } {
  const raw = stringField(input, "url")?.trim();
  if (!raw) return { error: "web_fetch requires a `url` string" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Invalid URL: ${truncate(raw, 200)}` };
  }
  const requested = numberField(input, "maxChars");
  const maxChars =
    requested === undefined
      ? DEFAULT_MAX_CHARS
      : Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(requested)));
  return { url, maxChars };
}

interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  body: Uint8Array;
  bodyTruncated: boolean;
}

async function fetchPage(
  start: URL,
  transport: WebTransport,
  lookup: LookupAddresses,
  signal: AbortSignal,
): Promise<FetchedPage> {
  let current = start;
  for (let redirects = 0; ; redirects++) {
    await assertPublicUrl(current, lookup);
    const response = await transport(current.href, {
      method: "GET",
      headers: REQUEST_HEADERS,
      redirect: "manual",
      signal,
    });
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`HTTP ${response.status} redirect without a Location header`);
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
        throw new Error(`Too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS})`);
      }
      current = new URL(location, current);
      continue;
    }
    const { bytes, truncated } = await readCapped(response, WEB_FETCH_MAX_BYTES);
    return {
      url: start.href,
      finalUrl: current.href,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      body: bytes,
      bodyTruncated: truncated,
    };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks, total), truncated: false };
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks, maxBytes), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
}

function renderPage(page: FetchedPage, maxChars: number): ToolResult<WebFetchDetails> {
  const kind = classifyContent(page.contentType, page.body);
  const details: WebFetchDetails = {
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    contentType: page.contentType,
    truncated: page.bodyTruncated,
  };
  const failed = page.status >= 400;
  if (kind === "binary") {
    return withDetails(
      errorResult(
        `${page.finalUrl} returned ${page.contentType || "binary content"} (HTTP ${page.status}), which web_fetch cannot read. Use the browser tools for documents and media.`,
      ),
      details,
    );
  }
  const decoded = decodeText(page.body, page.contentType, kind === "html");
  let content = decoded.trim();
  if (kind === "html") {
    const extracted = htmlToText(decoded, page.finalUrl);
    content = extracted.text;
    if (extracted.title) details.title = extracted.title;
  }
  const limit = failed ? Math.min(maxChars, ERROR_BODY_CHARS) : maxChars;
  const notes: string[] = [];
  if (content.length > limit) {
    notes.push(
      failed
        ? `[Error page truncated to ${limit} characters.]`
        : `[Content truncated: showing the first ${limit} of ${content.length} characters. Call web_fetch with a larger maxChars (up to ${MAX_MAX_CHARS}) for more.]`,
    );
    content = content.slice(0, limit).trimEnd();
    details.truncated = true;
  }
  if (page.bodyTruncated) {
    notes.push(
      `[The response exceeded ${WEB_FETCH_MAX_BYTES / (1024 * 1024)} MB; only the beginning was read.]`,
    );
  }
  if (kind === "html" && !failed && content.length < MIN_READABLE_CHARS) {
    notes.push("[Little readable text: the page may need JavaScript. Try the browser tools.]");
  }
  const header = [
    failed ? `HTTP ${page.status}${page.statusText ? ` ${page.statusText}` : ""}` : undefined,
    details.title ? `Title: ${details.title}` : undefined,
    `URL: ${page.finalUrl}`,
  ].filter((line): line is string => line !== undefined);
  const text = [header.join("\n"), content || "(empty response)", ...notes].join("\n\n");
  return failed ? withDetails(errorResult(text), details) : textResult(text, details);
}

function withDetails<D>(result: ToolResult, details: D): ToolResult<D> {
  return { ...result, details };
}

type ContentKind = "html" | "text" | "binary";

const TEXT_MIME_TYPES = new Set(
  "application/json application/xml application/javascript application/x-javascript application/x-ndjson application/yaml application/x-yaml application/toml application/csv".split(
    " ",
  ),
);

function classifyContent(contentType: string, body: Uint8Array): ContentKind {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime)) return "text";
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  if (mime !== "" && mime !== "application/octet-stream") return "binary";
  const head = body.subarray(0, 1024);
  if (head.includes(0)) return "binary";
  const sniff = Buffer.from(head).toString("latin1").toLowerCase();
  return /<!doctype html|<html[\s>]/.test(sniff) ? "html" : "text";
}

function decodeText(bytes: Uint8Array, contentType: string, isHtml: boolean): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset && isHtml) {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ── SSRF protection ──────────────────────────────────────────────────────────

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

const BLOCKED_IPV6: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const BLOCK_LIST = (() => {
  const list = new net.BlockList();
  for (const [address, prefix] of BLOCKED_IPV4) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of BLOCKED_IPV6) list.addSubnet(address, prefix, "ipv6");
  return list;
})();

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(ip);
  if (family === 4) return BLOCK_LIST.check(ip, "ipv4");
  if (family !== 6) return true;
  // BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules.
  if (BLOCK_LIST.check(ip, "ipv6")) return true;
  const embedded = embeddedIPv4(ip);
  return embedded !== undefined && BLOCK_LIST.check(embedded, "ipv4");
}

/** IPv4 address carried inside NAT64, 6to4 or IPv4-compatible IPv6 addresses. */
function embeddedIPv4(ip: string): string | undefined {
  const h = parseIPv6(ip);
  if (!h) return undefined;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    h0 === 0x64 &&
    h1 === 0xff9b &&
    (h2 === 1 || (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0))
  ) {
    return v4(h6, h7);
  }
  if (h0 === 0x2002) return v4(h1, h2);
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return v4(h6, h7);
  return undefined;
}

function parseIPv6(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  const groups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = "", tail] = ip.split("::");
  const first = groups(head);
  if (tail === undefined) return first.length === 8 ? first : undefined;
  const last = groups(tail);
  return [...first, ...new Array<number>(8 - first.length - last.length).fill(0), ...last];
}

async function assertPublicUrl(url: URL, lookup: LookupAddresses): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https URLs can be fetched (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new BlockedUrlError("URLs with embedded credentials are not allowed");
  }
  await resolvePublicAddresses(url.hostname, lookup);
}

async function resolvePublicAddresses(
  hostname: string,
  lookup: LookupAddresses,
): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const blocked = () =>
    new BlockedUrlError(
      `${host} is a private or reserved network address; only public hosts can be fetched`,
    );
  const family = net.isIP(host.replace(/%.*$/, ""));
  if (family !== 0) {
    if (isBlockedAddress(host)) throw blocked();
    return [{ address: host, family }];
  }
  if (host === "localhost" || host.endsWith(".localhost")) throw blocked();
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`DNS lookup failed for ${host}${code ? ` (${code})` : ""}`);
  }
  if (addresses.length === 0) throw new Error(`DNS lookup returned no addresses for ${host}`);
  // Every address must be public: a mixed answer is how rebinding attacks smuggle in internal IPs.
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new BlockedUrlError(`${host} resolves to a private or reserved network address`);
  }
  return addresses;
}

const defaultLookup: LookupAddresses = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

function guardedLookup(lookup: LookupAddresses): net.LookupFunction {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, lookup).then(
      (addresses) => {
        const family = options.family;
        const wanted =
          family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : undefined;
        const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
        const [first] = usable;
        if (!first) {
          callback(
            Object.assign(new Error(`No IPv${wanted} address for ${hostname}`), {
              code: "ENOTFOUND",
            }),
            "",
          );
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, ""),
    );
  };
}

/** GET over node:http(s) whose connection only uses addresses that passed the SSRF check. */
function pinnedRequest(
  url: string,
  init: WebTransportInit,
  lookup: net.LookupFunction,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(target, {
      method: "GET",
      headers: { ...init.headers, "accept-encoding": "gzip, deflate, br" },
      lookup,
      signal: init.signal,
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const status = response.statusCode ?? 0;
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          try {
            headers.append(name, item);
          } catch {
            // Skip header values that the WHATWG Headers class rejects.
          }
        }
      }
      if (status === 204 || status === 205 || status === 304 || isRedirect(status)) {
        response.resume();
        resolve(new Response(null, { status, statusText: response.statusMessage ?? "", headers }));
        return;
      }
      const decoder = contentDecoder(response.headers["content-encoding"]);
      let body: Readable = response;
      if (decoder) {
        body = pipeline(response, decoder, () => {});
        headers.delete("content-encoding");
        headers.delete("content-length");
      }
      try {
        const stream = Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
        resolve(
          new Response(stream, { status, statusText: response.statusMessage ?? "", headers }),
        );
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.end();
  });
}

function contentDecoder(
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

// ── HTML → text ──────────────────────────────────────────────────────────────

const SKIPPED_ELEMENTS = new Set(
  "script style noscript svg nav footer template iframe canvas select button object embed audio video map head".split(
    " ",
  ),
);
const MINIMAL_SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "head",
]);
/** Contents are raw text in HTML, so tags inside them must not be tokenized. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
const VOID_ELEMENTS = new Set(
  "area base br col embed hr img input link meta source track wbr".split(" "),
);
const BLOCK_ELEMENTS = new Set(
  "address article aside blockquote body caption dd details dialog div dl dt fieldset figcaption figure footer form header hr main nav ol p section summary table tbody tfoot thead ul".split(
    " ",
  ),
);
const MAX_LINKS = 60;
const MAX_LINK_TEXT = 120;
const MIN_MAIN_REGION_CHARS = 250;
const BOILERPLATE_ROLE =
  /^(navigation|menu|menubar|search|dialog|alertdialog|banner|contentinfo|complementary)$/i;
/** Deliberately narrow: ambiguous words such as "menu" or "header" often mark real content. */
const BOILERPLATE_NAME =
  /(?:^|[\s_-])(nav|navbar|navigation|breadcrumbs?|dropdown|sidebar|footer|cookies?|consent|gdpr|share|sharing|social|advert|advertisement|ads|sponsored|popup|modal|newsletter|interlanguage)(?=$|[\s_-])/i;

/**
 * Linear-time tokenizer: attribute quotes are not balanced, so a `>` inside an attribute value
 * ends the tag early. That only costs a few stray characters, while quote-aware patterns can
 * backtrack quadratically on hostile markup and block the event loop.
 */
const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g;

export interface ExtractedPage {
  title?: string;
  text: string;
}

/** Readable, markdown-ish text: headings, list items, table rows, code blocks and some links. */
export function htmlToText(html: string, baseUrl: string): ExtractedPage {
  const title = extractTitle(html);
  const body = regionOf(html, "body") ?? html;
  const main = regionOf(html, "main") ?? regionOf(html, "article", true);
  let text = main ? renderHtml(main, baseUrl, SKIPPED_ELEMENTS, true) : "";
  if (text.length < MIN_MAIN_REGION_CHARS) {
    const full = renderHtml(body, baseUrl, SKIPPED_ELEMENTS, true);
    if (full.length > text.length) text = full;
  }
  // Unclosed boilerplate elements can swallow the rest of the page; retry skipping only scripts.
  if (text.length < MIN_MAIN_REGION_CHARS) {
    const permissive = renderHtml(body, baseUrl, MINIMAL_SKIPPED_ELEMENTS, false);
    if (permissive.length > text.length) text = permissive;
  }
  return title ? { title, text } : { text };
}

function extractTitle(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!raw) return undefined;
  const title = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return title ? truncate(title, 300) : undefined;
}

/** The first `<tag>` … last `</tag>` span (first closing tag unless `lastClose`). */
function regionOf(html: string, tag: string, lastClose = false): string | undefined {
  const lower = html.toLowerCase();
  const start = lower.search(new RegExp(`<${tag}[\\s>]`));
  if (start === -1) return undefined;
  const close = `</${tag}>`;
  const end = lastClose ? lower.lastIndexOf(close) : lower.indexOf(close, start);
  return end > start ? html.slice(start, end + close.length) : html.slice(start);
}

function renderHtml(
  html: string,
  baseUrl: string,
  skipped: ReadonlySet<string>,
  skipBoilerplate: boolean,
): string {
  const out = new TextBuilder();
  const lower = html.toLowerCase();
  let skipDepth = 0;
  /** A boilerplate element being skipped, tracked by name so nested same-name tags balance. */
  let skipElement: { name: string; depth: number } | undefined;
  let preDepth = 0;
  let cellIndex = 0;
  let linkCount = 0;
  let link: { href: string | undefined; start: number } | undefined;
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let match = TAG_RE.exec(html); match; match = TAG_RE.exec(html)) {
    const skipping = skipDepth > 0 || skipElement !== undefined;
    if (!skipping && match.index > last) {
      out.text(decodeEntities(html.slice(last, match.index)), preDepth > 0);
    }
    last = TAG_RE.lastIndex;
    const [raw, closing, rawName, attributes = ""] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    const isClose = closing === "/";
    const opensElement = !isClose && !VOID_ELEMENTS.has(name) && !raw.endsWith("/>");
    if (!isClose && RAW_TEXT_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, last);
      const resume = end === -1 ? html.length : lower.indexOf(">", end) + 1 || html.length;
      if (!skipping && !skipped.has(name)) {
        out.text(decodeEntities(html.slice(last, end === -1 ? html.length : end)), false);
      }
      TAG_RE.lastIndex = resume;
      last = resume;
      continue;
    }
    if (skipElement) {
      if (name === skipElement.name) {
        if (isClose) skipElement = --skipElement.depth === 0 ? undefined : skipElement;
        else if (opensElement) skipElement.depth++;
      }
      continue;
    }
    if (skipped.has(name)) {
      if (isClose) skipDepth = Math.max(0, skipDepth - 1);
      else if (opensElement) skipDepth++;
      continue;
    }
    if (skipDepth > 0) continue;
    if (skipBoilerplate && opensElement && isBoilerplate(attributes)) {
      skipElement = { name, depth: 1 };
      continue;
    }
    const heading = /^h([1-6])$/.exec(name)?.[1];
    if (heading) {
      out.block();
      if (!isClose) out.raw(`${"#".repeat(Number(heading))} `);
    } else if (name === "li") {
      out.line();
      if (!isClose) out.raw("- ");
    } else if (name === "br") {
      out.line();
    } else if (name === "pre") {
      if (isClose) {
        preDepth = Math.max(0, preDepth - 1);
        if (preDepth === 0) {
          out.line();
          out.raw("```");
          out.block();
        }
      } else {
        if (preDepth === 0) {
          out.block();
          out.raw("```\n");
        }
        preDepth++;
      }
    } else if (name === "tr") {
      out.line();
      cellIndex = 0;
    } else if (name === "td" || name === "th") {
      if (!isClose && cellIndex++ > 0) out.raw(" | ");
    } else if (name === "a") {
      if (!isClose) link = { href: attributeValue(attributes, "href"), start: out.length };
      else if (link) {
        if (linkCount < MAX_LINKS && out.linkify(link.start, resolveLink(link.href, baseUrl))) {
          linkCount++;
        }
        link = undefined;
      }
    } else if (BLOCK_ELEMENTS.has(name)) {
      out.block();
    }
  }
  if (skipDepth === 0 && !skipElement && last < html.length) {
    out.text(decodeEntities(html.slice(last)), preDepth > 0);
  }
  return out.finish();
}

function isBoilerplate(attributes: string): boolean {
  if (!attributes.trim()) return false;
  const role = attributeValue(attributes, "role");
  if (role && BOILERPLATE_ROLE.test(role)) return true;
  if (attributeValue(attributes, "aria-hidden") === "true") return true;
  if (/(?:^|\s)hidden(?=[\s=/]|$)/i.test(attributes.replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
  const style = attributeValue(attributes, "style");
  if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  return (
    BOILERPLATE_NAME.test(attributeValue(attributes, "class") ?? "") ||
    BOILERPLATE_NAME.test(attributeValue(attributes, "id") ?? "")
  );
}

const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

/** Attribute value by exact name (`data-href` never matches `href`). */
function attributeValue(attributes: string, name: string): string | undefined {
  let pattern = ATTRIBUTE_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    ATTRIBUTE_PATTERNS.set(name, pattern);
  }
  const match = pattern.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function resolveLink(href: string | undefined, baseUrl: string): string | undefined {
  if (!href || href.startsWith("#")) return undefined;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Output buffer; only inspects its tail so building stays linear in the page size. */
class TextBuilder {
  private out = "";

  get length(): number {
    return this.out.length;
  }

  text(chunk: string, preformatted: boolean): void {
    if (preformatted) {
      this.out += chunk;
      return;
    }
    const collapsed = chunk.replace(/\s+/g, " ");
    if (collapsed === "") return;
    const afterSpace = this.out === "" || isSpace(this.out.at(-1));
    if (collapsed === " ") {
      if (!afterSpace) this.out += " ";
      return;
    }
    this.out += afterSpace ? collapsed.trimStart() : collapsed;
  }

  raw(text: string): void {
    this.out += text;
  }

  line(): void {
    let end = this.out.length;
    while (end > 0 && (this.out[end - 1] === " " || this.out[end - 1] === "\t")) end--;
    if (end < this.out.length) this.out = this.out.slice(0, end);
    if (this.out && !this.out.endsWith("\n")) this.out += "\n";
  }

  block(): void {
    this.line();
    if (this.out && !this.out.endsWith("\n\n")) this.out += "\n";
  }

  /** Turns the text written since `start` into a markdown link when it reads like one. */
  linkify(start: number, href: string | undefined): boolean {
    if (start > this.out.length) return false;
    const label = this.out.slice(start).trim();
    if (!href || !label || label.length > MAX_LINK_TEXT || label.includes("\n") || label === href) {
      return false;
    }
    const leading = this.out.slice(start).match(/^\s*/)?.[0] ?? "";
    const escapedLabel = label.replace(/[[\]]/g, "\\$&");
    const escapedHref = href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
    const trailing = this.out.slice(start).match(/\s*$/)?.[0] ?? "";
    this.out = `${this.out.slice(0, start)}${leading}[${escapedLabel}](${escapedHref})${trailing}`;
    return true;
  }

  finish(): string {
    return this.out
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

const LATIN1_ENTITIES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...LATIN1_ENTITIES.split(" ").map((name, i): [string, string] => [
    name,
    String.fromCodePoint(160 + i),
  ]),
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ensp", " "],
  ["emsp", " "],
  ["thinsp", " "],
  ["shy", ""],
  ["zwj", ""],
  ["zwnj", ""],
  ["lrm", ""],
  ["rlm", ""],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["bull", "•"],
  ["trade", "™"],
  ["euro", "€"],
  ["larr", "←"],
  ["rarr", "→"],
  ["uarr", "↑"],
  ["darr", "↓"],
  ["minus", "−"],
  ["prime", "′"],
  ["Prime", "″"],
  ["oelig", "œ"],
  ["OElig", "Œ"],
  ["scaron", "š"],
  ["Scaron", "Š"],
  ["check", "✓"],
]);

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      if (
        !Number.isInteger(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return entity;
      }
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(body) ?? entity;
  });
}

// ── web_search ───────────────────────────────────────────────────────────────

const SEARCH_SYSTEM_PROMPT = [
  "You are a web search assistant. Using only the web search results provided, list the most relevant results for the query.",
  "For each result give the page title, its URL and one sentence on what it offers. Prefer primary, authoritative and recent sources.",
  "Never invent URLs or facts that are not in the search results. Be concise; no preamble.",
].join(" ");

function createWebSearchTool(options: WebToolsOptions, logger: Logger): ToolSpec {
  return {
    name: TOOL.webSearch,
    label: "Search the web",
    description:
      "Search the web and get a concise list of relevant results with source links. Use web_fetch afterwards to read a result in full.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          description: `Number of results (default ${DEFAULT_SEARCH_RESULTS}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    safety: {
      readOnly: true,
      category: "network",
      describe: (input) =>
        `Search the web for "${truncate(stringField(input, "query") ?? "", 120)}"`,
    },
    promptGuidelines: [
      "Use to discover pages; then web_fetch the most promising results for details.",
    ],
    async execute(input, ctx) {
      const { llm } = options;
      if (!llm) return errorResult("web_search is unavailable: no language model is configured");
      const query = stringField(input, "query")?.trim();
      if (!query) return errorResult("web_search requires a non-empty `query` string");
      const requested = numberField(input, "maxResults");
      const maxResults =
        requested === undefined
          ? DEFAULT_SEARCH_RESULTS
          : Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(requested)));
      try {
        const completion = await llm.complete({
          model: options.searchModel ?? llm.defaultModel,
          system: SEARCH_SYSTEM_PROMPT,
          messages: [{ role: "user", content: `Search query: ${query}` }],
          plugins: [{ id: "web", max_results: maxResults }],
          reasoning: "off",
          maxTokens: 1_500,
          timeoutMs: SEARCH_TIMEOUT_MS,
          purpose: "web-search",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const citations = completion.citations ?? [];
        const details: WebSearchDetails = { query, model: completion.model, citations };
        if (completion.usage.costUsd !== undefined) details.costUsd = completion.usage.costUsd;
        return textResult(formatSearchResults(completion.text, citations), details);
      } catch (error) {
        if (ctx.signal?.aborted) return errorResult("Web search aborted");
        logger.debug("web search failed", { error: messageOf(error) });
        return errorResult(`Web search failed: ${messageOf(error)}`);
      }
    },
  };
}

function formatSearchResults(text: string, citations: readonly LlmUrlCitation[]): string {
  const summary = text.trim() || "(the search returned no summary)";
  if (citations.length === 0) return `${summary}\n\n(No source links were returned.)`;
  const sources = citations.map((citation, i) => {
    const label = (citation.title?.trim() || citation.url).replace(/[[\]]/g, "\\$&");
    const href = citation.url.replace(/[()\s]/g, (c) => encodeURIComponent(c));
    return `${i + 1}. [${label}](${href})`;
  });
  return `${summary}\n\nSources:\n${sources.join("\n")}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stringField(input: unknown, key: string): string | undefined {
  const value = isRecord(input) ? input[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function numberField(input: unknown, key: string): number | undefined {
  const value = isRecord(input) ? input[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}
