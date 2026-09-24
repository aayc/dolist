import http from "node:http";
import type { AddressInfo } from "node:net";
import { type ToolResult, type ToolSpec, toolResultText } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLlmClient } from "../llm/mock";
import { LlmError } from "../llm/types";
import { TOOL } from "./contracts";
import {
  createPinnedTransport,
  createWebTools,
  htmlToText,
  isBlockedAddress,
  type LookupAddresses,
  WEB_FETCH_MAX_BYTES,
  type WebFetchDetails,
} from "./web";

const PUBLIC_IP = "93.184.216.34";
const publicLookup: LookupAddresses = async () => [{ address: PUBLIC_IP, family: 4 }];

interface FetchCall {
  url: string;
  init: RequestInit;
}

type Route = Response | (() => Response);

function fakeFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    return typeof route === "function" ? route() : route;
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function html(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function tools(options: Parameters<typeof createWebTools>[0] = {}) {
  const [webFetch, webSearch] = createWebTools({ lookup: publicLookup, ...options });
  return { webFetch: webFetch as ToolSpec, webSearch: webSearch as ToolSpec };
}

async function fetchWith(
  routes: Record<string, Route>,
  input: unknown,
  lookup: LookupAddresses = publicLookup,
) {
  const fake = fakeFetch(routes);
  const { webFetch } = tools({ fetch: fake.fetch, lookup });
  const result = await webFetch.execute(input, { toolCallId: "call_1" });
  return { result, calls: fake.calls, text: toolResultText(result) };
}

const ARTICLE = `<!doctype html><html><head><title>Test &amp; Page</title>
<style>.x { color: red }</style><script>var s = "<p>not text</p>";</script></head>
<body><nav><a href="/home">Home</a> <a href="/about">About</a></nav>
<main><h1>Main Title</h1>
<p>Hello&nbsp;world, this is <b>bold</b> and <a href="/docs/intro">the intro</a>. Caf&eacute; &#x2014; &#8220;quoted&#8221;.</p>
<h2>Details</h2>
<ul><li>First item</li><li>Second <a href="https://other.example/x">link</a></li></ul>
<pre>code  line 1
  indented &lt;tag&gt;</pre>
<table><tr><th>Name</th><th>Price</th></tr><tr><td>Tea</td><td>$3</td></tr></table>
<p><a href="#top">Back to top</a> <a href="javascript:alert(1)">evil</a> <a href="/x">${"long ".repeat(40)}</a></p>
<p>${"Filler sentence to make the main region substantial. ".repeat(4)}</p>
</main><footer>Copyright junk</footer></body></html>`;

describe("web_fetch", () => {
  it("is a read-only network tool with an approval-card description", () => {
    const { webFetch, webSearch } = tools();
    expect(webFetch.name).toBe(TOOL.webFetch);
    expect(webSearch.name).toBe(TOOL.webSearch);
    expect(webFetch.safety).toMatchObject({ readOnly: true, category: "network" });
    expect(webFetch.safety.describe?.({ url: "https://example.com/a" })).toBe(
      "Fetch https://example.com/a",
    );
    expect(webFetch.parameters).toMatchObject({ required: ["url"], additionalProperties: false });
  });

  it("GETs the page and converts HTML to readable markdown-ish text", async () => {
    const { result, calls, text } = await fetchWith(
      { "https://example.com/post": html(ARTICLE) },
      { url: "https://example.com/post" },
    );
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.body).toBeUndefined();
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/DailyDoList/);

    expect(text).toContain("Title: Test & Page");
    expect(text).toContain("URL: https://example.com/post");
    expect(text).toContain("# Main Title");
    expect(text).toContain("## Details");
    expect(text).toContain(
      "Hello world, this is bold and [the intro](https://example.com/docs/intro).",
    );
    expect(text).toContain("Café — “quoted”.");
    expect(text).toContain("- First item\n- Second [link](https://other.example/x)");
    expect(text).toContain("```\ncode  line 1\n  indented <tag>\n```");
    expect(text).toContain("Name | Price\nTea | $3");
    expect(text).toContain("Back to top evil");
    expect(text).not.toContain("[Back to top]");
    expect(text).not.toMatch(/Home|About|Copyright|not text|color: red/);
    expect(result.details).toEqual({
      url: "https://example.com/post",
      finalUrl: "https://example.com/post",
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Test & Page",
      truncated: false,
    } satisfies WebFetchDetails);
  });

  it("passes plain text and JSON through", async () => {
    const { text, result } = await fetchWith(
      {
        "https://api.example.com/v1": new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      },
      { url: "https://api.example.com/v1" },
    );
    expect(result.isError).toBeUndefined();
    expect(text).toBe('URL: https://api.example.com/v1\n\n{"ok":true}');
  });

  it("ignores anything but the url and maxChars: requests are always bodiless GETs", async () => {
    const { calls } = await fetchWith(
      { "https://example.com/": html("<p>hi</p>") },
      { url: "https://example.com/", method: "POST", body: "payload", headers: { Cookie: "x" } },
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(Object.keys(calls[0]?.init.headers as object).sort()).toEqual(["accept", "user-agent"]);
  });

  it.each([
    ["http://127.0.0.1/"],
    ["http://localhost:7331/api/notes"],
    ["http://app.localhost/"],
    ["http://10.1.2.3/"],
    ["http://172.20.0.1/"],
    ["http://192.168.1.1/admin"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://100.64.0.1/"],
    ["http://0.0.0.0/"],
    ["http://[::1]/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://[fd12:3456::1]/"],
    ["http://[fe80::1]/"],
    ["http://2130706433/"],
    ["http://0x7f.1/"],
  ])("refuses private or reserved destination %s without connecting", async (url) => {
    const { result, calls } = await fetchWith({}, { url });
    expect(result.isError).toBe(true);
    expect(toolResultText(result)).toMatch(/private or reserved/);
    expect(calls).toHaveLength(0);
  });

  it("refuses hostnames that resolve to any private address", async () => {
    const internal: LookupAddresses = async () => [{ address: "10.0.0.7", family: 4 }];
    const mixed: LookupAddresses = async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: "fd00::7", family: 6 },
    ];
    for (const lookup of [internal, mixed]) {
      const { result, calls } = await fetchWith({}, { url: "https://intranet.example/" }, lookup);
      expect(toolResultText(result)).toMatch(/resolves to a private or reserved network address/);
      expect(calls).toHaveLength(0);
    }
  });

  it("re-checks every redirect hop and follows public ones", async () => {
    const blocked = await fetchWith(
      { "https://example.com/go": redirect("http://169.254.169.254/latest/meta-data/iam") },
      { url: "https://example.com/go" },
    );
    expect(blocked.result.isError).toBe(true);
    expect(blocked.text).toMatch(/private or reserved/);
    expect(blocked.calls.map((c) => c.url)).toEqual(["https://example.com/go"]);

    const followed = await fetchWith(
      {
        "https://example.com/a": redirect("/b", 301),
        "https://example.com/b": redirect("https://www.example.org/final", 307),
        "https://www.example.org/final": html("<title>Final</title><p>Landed.</p>"),
      },
      { url: "https://example.com/a" },
    );
    expect(followed.result.isError).toBeUndefined();
    expect(followed.result.details).toMatchObject({
      finalUrl: "https://www.example.org/final",
      title: "Final",
    });
    expect(followed.text).toContain("Landed.");
  });

  it("gives up after five redirects", async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 7; i++) routes[`https://example.com/${i}`] = () => redirect(`/${i + 1}`);
    const { result, calls } = await fetchWith(routes, { url: "https://example.com/0" });
    expect(toolResultText(result)).toMatch(/Too many redirects/);
    expect(calls).toHaveLength(6);
  });

  it.each([
    ["file:///etc/passwd", /Only http and https/],
    ["ftp://example.com/file", /Only http and https/],
    ["javascript:alert(1)", /Only http and https/],
    ["https://user:pass@example.com/", /embedded credentials/],
    ["not a url", /Invalid URL/],
  ])("rejects %s", async (url, message) => {
    const { result, calls } = await fetchWith({}, { url });
    expect(result.isError).toBe(true);
    expect(toolResultText(result)).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("stops reading bodies at 2 MB", async () => {
    let produced = 0;
    const chunk = new TextEncoder().encode(`${"x".repeat(64 * 1024 - 1)}\n`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 10 * WEB_FETCH_MAX_BYTES) controller.close();
        else {
          produced += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const { result, text } = await fetchWith(
      {
        "https://example.com/big.txt": new Response(body, {
          headers: { "content-type": "text/plain" },
        }),
      },
      { url: "https://example.com/big.txt", maxChars: 100_000 },
    );
    expect(produced).toBeLessThan(WEB_FETCH_MAX_BYTES + 256 * 1024);
    expect(result.details).toMatchObject({ truncated: true });
    expect(text).toMatch(/exceeded 2 MB/);
  });

  it("truncates to maxChars with a notice and clamps silly values", async () => {
    const long = `<p>${"word ".repeat(5_000)}</p>`;
    const { text, result } = await fetchWith(
      { "https://example.com/": html(long) },
      { url: "https://example.com/", maxChars: 1_000 },
    );
    expect(text).toMatch(/\[Content truncated: showing the first 1000 of \d+ characters/);
    expect(result.details).toMatchObject({ truncated: true });
    const tiny = await fetchWith(
      { "https://example.com/": html(long) },
      { url: "https://example.com/", maxChars: 3 },
    );
    expect(tiny.text).toMatch(/showing the first 200 of/);
  });

  it("reports HTTP errors as error results with details", async () => {
    const { result, text } = await fetchWith(
      { "https://example.com/missing": html("<h1>Not Found</h1><p>Nothing here.</p>", 404) },
      { url: "https://example.com/missing" },
    );
    expect(result.isError).toBe(true);
    expect(text.startsWith("HTTP 404")).toBe(true);
    expect(text).toContain("Nothing here.");
    expect(result.details).toMatchObject({ status: 404 });
  });

  it("does not dump binary content", async () => {
    const png = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), {
      headers: { "content-type": "image/png" },
    });
    const { result, text } = await fetchWith(
      { "https://example.com/a.png": png },
      { url: "https://example.com/a.png" },
    );
    expect(result.isError).toBe(true);
    expect(text).toMatch(/image\/png.*cannot read/);
  });

  it("returns an error result when aborted or when the network fails", async () => {
    const controller = new AbortController();
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        }),
    );
    const { webFetch } = tools({ fetch: hanging as unknown as typeof fetch });
    const aborted = await webFetch.execute(
      { url: "https://example.com/" },
      { toolCallId: "c", signal: controller.signal },
    );
    expect(toolResultText(aborted)).toBe("Fetch aborted");

    const failing = await fetchWith({}, { url: "https://example.com/down" });
    expect(failing.text).toMatch(/Fetch failed for https:\/\/example.com\/down: fetch failed/);
  });

  it("reports DNS failures", async () => {
    const nxdomain: LookupAddresses = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    const { text } = await fetchWith({}, { url: "https://nope.invalid/" }, nxdomain);
    expect(text).toMatch(/DNS lookup failed for nope.invalid \(ENOTFOUND\)/);
  });
});

describe("default pinned transport", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function canary(): Promise<{ port: number; hits: () => number }> {
    let hits = 0;
    server = http.createServer((_req, res) => {
      hits++;
      res.end("internal secret");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, hits: () => hits };
  }

  it("refuses to connect when the name resolves to a private address at connect time", async () => {
    const { port, hits } = await canary();
    const transport = createPinnedTransport(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(
      transport(`http://rebind.test:${port}/`, {
        method: "GET",
        headers: {},
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow(/private or reserved/);
    expect(hits()).toBe(0);
  });

  it("defeats DNS rebinding between the check and the connection", async () => {
    const { port, hits } = await canary();
    let lookups = 0;
    const rebinding: LookupAddresses = async () =>
      lookups++ === 0 ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    const [webFetch] = createWebTools({ lookup: rebinding });
    const result = (await webFetch?.execute(
      { url: `http://rebind.test:${port}/` },
      { toolCallId: "c" },
    )) as ToolResult;
    expect(result.isError).toBe(true);
    expect(toolResultText(result)).toMatch(/private or reserved/);
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(hits()).toBe(0);
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.0.10",
    "169.254.169.254",
    "100.100.100.100",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "[::1]",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:c0a8:0101::1",
    "::7f00:1",
    "fc00::1",
    "fdff::1",
    "fe80::1%lo0",
    "ff02::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    PUBLIC_IP,
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:0808:0808::1",
  ])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("htmlToText", () => {
  it("prefers <main>/<article> but falls back to the body when they are nearly empty", () => {
    const withMain = htmlToText(
      `<body><div>Sidebar noise</div><main><p>${"Real content. ".repeat(30)}</p></main></body>`,
      "https://e.com/",
    );
    expect(withMain.text).not.toContain("Sidebar noise");
    const emptyMain = htmlToText(
      `<body><main><p>tiny</p></main><div>${"Body text that matters. ".repeat(20)}</div></body>`,
      "https://e.com/",
    );
    expect(emptyMain.text).toContain("Body text that matters.");
  });

  it("drops navigational boilerplate but keeps ambiguous content such as a food menu", () => {
    const filler = "Opening hours are noon to ten. ".repeat(10);
    const page = htmlToText(
      `<body><main>
        <div class="vector-dropdown"><ul><li><a href="https://de.example/">Deutsch</a></li><li><div class="x">nested</div></li></ul></div>
        <div role="navigation">Jump links</div><div aria-hidden="true">Decorative</div>
        <div hidden>Hidden panel</div><div style="display: none">Invisible</div>
        <section id="cookie-consent">We use cookies</section><aside class="share-buttons">Share this</aside>
        <div data-hidden="x" class="menu"><h2>Menu</h2><ul><li>Soup of the day</li></ul></div>
        <p>${filler}</p><p>After boilerplate</p>
      </main></body>`,
      "https://e.com/",
    );
    expect(page.text).toContain("## Menu\n\n- Soup of the day");
    expect(page.text).toContain("After boilerplate");
    expect(page.text).not.toMatch(
      /Deutsch|nested|Jump links|Decorative|Hidden panel|Invisible|cookies|Share this/,
    );
  });

  it("reads href exactly, never data-href", () => {
    const page = htmlToText(
      `<body><p><a data-href="https://tracker.example/" href="/real">Real link</a> ${"text ".repeat(60)}</p></body>`,
      "https://e.com/",
    );
    expect(page.text).toContain("[Real link](https://e.com/real)");
  });

  it("survives an unclosed <nav>", () => {
    const page = htmlToText(
      `<body><nav><a href="/">Home</a><p>${"Article text. ".repeat(30)}</p></body>`,
      "https://e.com/",
    );
    expect(page.text).toContain("Article text.");
  });

  it("links sparingly: absolute http(s) only, short labels, capped count", () => {
    const anchors = Array.from({ length: 80 }, (_, i) => `<a href="/p/${i}">Page ${i}</a>`).join(
      " ",
    );
    const page = htmlToText(
      `<body><p>${anchors} <a href="mailto:a@b.c">mail</a> <a href="https://e.com/same">https://e.com/same</a></p></body>`,
      "https://e.com/base/",
    );
    const links = page.text.match(/\]\(https?:\/\/[^)]+\)/g) ?? [];
    expect(links).toHaveLength(60);
    expect(page.text).toContain("[Page 0](https://e.com/p/0)");
    expect(page.text).toContain("mail");
    expect(page.text).not.toContain("mailto:");
    expect(page.text).not.toContain("[https://e.com/same]");
  });

  it("decodes entities and ignores comments, raw text and unknown entities", () => {
    const page = htmlToText(
      "<body><!-- hidden --><p>a &lt; b &amp;&amp; c &gt; d &unknown; &#128512; &#xD800;</p><textarea>raw <b>kept</b></textarea></body>",
      "https://e.com/",
    );
    expect(page.text).toContain("a < b && c > d &unknown; 😀 &#xD800;");
    expect(page.text).toContain("raw <b>kept</b>");
    expect(page.text).not.toContain("hidden");
  });

  it("stays fast on hostile markup", () => {
    const hostile = `<body>${'<a href="'.repeat(20_000)}${"<div>".repeat(20_000)}</body>`;
    const started = performance.now();
    htmlToText(hostile, "https://e.com/");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("web_search", () => {
  it("searches through the LLM web plugin and formats sources", async () => {
    const llm = new MockLlmClient(
      [
        {
          text: "1. Weather in Paris — forecast page.",
          citations: [
            { url: "https://weather.example/paris", title: "Paris [forecast]" },
            { url: "https://news.example/a b" },
          ],
          usage: { inputTokens: 900, outputTokens: 60, costUsd: 0.021 },
        },
      ],
      { defaultModel: "deepseek/deepseek-v4.1-flash" },
    );
    const { webSearch } = tools({ llm });
    const controller = new AbortController();
    const result = await webSearch.execute(
      { query: " paris weather ", maxResults: 3 },
      { toolCallId: "c", signal: controller.signal },
    );

    expect(llm.calls[0]).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      plugins: [{ id: "web", max_results: 3 }],
      reasoning: "off",
      purpose: "web-search",
      signal: controller.signal,
      messages: [{ role: "user", content: "Search query: paris weather" }],
    });
    expect(toolResultText(result)).toBe(
      "1. Weather in Paris — forecast page.\n\nSources:\n1. [Paris \\[forecast\\]](https://weather.example/paris)\n2. [https://news.example/a b](https://news.example/a%20b)",
    );
    expect(result.details).toMatchObject({ query: "paris weather", costUsd: 0.021 });
  });

  it("uses searchModel, clamps maxResults and handles missing citations", async () => {
    const llm = new MockLlmClient(["No results."]);
    const { webSearch } = tools({ llm, searchModel: "perplexity/sonar" });
    const result = await webSearch.execute({ query: "x", maxResults: 50 }, { toolCallId: "c" });
    expect(llm.calls[0]).toMatchObject({
      model: "perplexity/sonar",
      plugins: [{ id: "web", max_results: 10 }],
    });
    expect(toolResultText(result)).toContain("No source links were returned");
    expect(webSearch.safety.describe?.({ query: "x" })).toBe('Search the web for "x"');
  });

  it("returns error results without an LLM, for bad input and on failure", async () => {
    expect((await tools().webSearch.execute({ query: "x" }, { toolCallId: "c" })).isError).toBe(
      true,
    );
    const llm = new MockLlmClient([new LlmError("OpenRouter 401: User not found.", 401, false)]);
    const { webSearch } = tools({ llm });
    expect(toolResultText(await webSearch.execute({ query: "  " }, { toolCallId: "c" }))).toMatch(
      /non-empty/,
    );
    const failed = await webSearch.execute({ query: "x" }, { toolCallId: "c" });
    expect(failed.isError).toBe(true);
    expect(toolResultText(failed)).toBe("Web search failed: OpenRouter 401: User not found.");
  });
});
