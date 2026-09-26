import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolResultText } from "@ddl/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL } from "../../tools/contracts";
import { NavigationBlockedError, StaleRefError } from "../errors";
import { createExecutionTools } from "../tools";
import type { BrowserSession, BrowserSnapshot, ExecutionProvider } from "../types";
import type { Frame } from "../util/frame-hub";
import { jpegSize } from "../util/jpeg";
import { LocalBrowserController } from "./browser";
import { resolveBrowserExecutable } from "./browser-executable";

const resolved = resolveBrowserExecutable();
const TIMEOUT = 30_000;

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Test Home</title>
<h1>Welcome</h1>
<nav><a href="/next">Next page</a> <a href="/popup" target="_blank">Popup link</a></nav>
<form action="/search" method="get">
  <label for="q">Search</label><input id="q" name="q">
  <label for="pw">Password</label><input id="pw" type="password" name="pw">
  <label for="color">Color</label>
  <select id="color" name="color"><option value="r">Red</option><option value="g">Green</option></select>
  <button type="submit">Go</button>
</form>
<button onclick="document.getElementById('status').textContent = 'Changed!'">Change text</button>
<button onclick="document.getElementById('status').textContent = confirm('Delete it?') ? 'yes' : 'no'">Confirm me</button>
<p id="status">Original</p>
<iframe title="Inner frame" srcdoc="<button onclick=&quot;this.textContent='Inner clicked'&quot;>Inner button</button>"></iframe>`,
  "/next": `<!doctype html><title>Next page</title><h1>Second</h1><a href="/">Home</a>`,
  "/compose": `<!doctype html><title>Compose</title>
<form id="form" action="/search" method="get"><label for="subject">Subject</label><input id="subject" name="q"></form>
<label for="body">Body</label><textarea id="body"></textarea>
<div id="chat" contenteditable="true" role="textbox" aria-label="Message"></div>
<p id="state"></p>
<script>
  const events = [];
  const byId = (id) => document.getElementById(id);
  const show = () => {
    byId("state").textContent = JSON.stringify({
      subject: byId("subject").value,
      body: byId("body").value,
      chat: byId("chat").innerText,
      events,
    });
  };
  byId("chat").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      events.push("sent");
    }
  });
  byId("form").addEventListener("submit", (e) => {
    e.preventDefault();
    events.push("submitted");
  });
  document.addEventListener("input", show);
  document.addEventListener("keyup", show);
</script>`,
  "/popup": `<!doctype html><title>Popup page</title><p>Popped up</p>`,
  "/article": `<!doctype html><title>Article</title><nav>Menu Links</nav>
<main><h1>Big   story</h1><p>First    paragraph.</p>\n\n\n<p>${"Second paragraph. ".repeat(12).trim()}</p><p style="display:none">hidden</p></main>`,
};

function refOf(snapshot: BrowserSnapshot, pattern: RegExp): string {
  for (const line of snapshot.snapshot.split("\n")) {
    if (pattern.test(line)) {
      const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(line)?.[1];
      if (ref) return ref;
    }
  }
  throw new Error(`No ref for ${pattern} in:\n${snapshot.snapshot}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!resolved)("LocalBrowserController (real Chrome)", () => {
  let server: Server;
  let base: string;
  let profileDir: string;
  let controller: LocalBrowserController;
  let session: BrowserSession;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        res.setHeader("content-type", "text/html");
        res.end(
          `<!doctype html><title>Results</title><p>You searched for ${q.replace(/[<>&]/g, "")}</p>`,
        );
        return;
      }
      const body = PAGES[url.pathname];
      res.statusCode = body ? 200 : 404;
      res.setHeader("content-type", "text/html");
      res.end(body ?? "<title>Not found</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    profileDir = await mkdtemp(join(tmpdir(), "ddl-browser-profile-"));
    if (!resolved) throw new Error("unreachable");
    controller = new LocalBrowserController({
      profileDir,
      browser: resolved,
      settleMaxMs: 1_500,
      // CI runners sometimes take over 30 s to start Chrome; a longer bound only delays a failure.
      launchTimeoutMs: 120_000,
    });
    session = await controller.session("thread-1");
  }, 150_000);

  afterAll(async () => {
    await controller?.dispose();
    await new Promise((resolve) => server?.close(resolve));
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  }, 30_000);

  it(
    "navigates and returns a snapshot with element refs",
    async () => {
      const snap = await session.navigate(`${base}/`);
      expect(snap.url).toBe(`${base}/`);
      expect(snap.title).toBe("Test Home");
      expect(snap.snapshot).toMatch(/link "Next page" \[ref=e\d+\]/);
      expect(snap.snapshot).toMatch(/button "Go" \[ref=e\d+\]/);
      expect(controller.has("thread-1")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "clicks by ref, navigates, and rejects refs from the previous page",
    async () => {
      const home = await session.navigate(`${base}/`);
      const nextRef = refOf(home, /link "Next page"/);
      const next = await session.click({ ref: nextRef });
      expect(next.url).toBe(`${base}/next`);
      expect(next.title).toBe("Next page");
      await expect(session.click({ ref: refOf(home, /button "Go"/) })).rejects.toBeInstanceOf(
        StaleRefError,
      );
      await expect(session.click({ ref: "not-a-ref" })).rejects.toBeInstanceOf(StaleRefError);
    },
    TIMEOUT,
  );

  it(
    "types with submit and never exposes password values",
    async () => {
      const home = await session.navigate(`${base}/`);
      const afterPassword = await session.type(
        { ref: refOf(home, /textbox "Password"/) },
        "hunter2-secret",
      );
      expect(afterPassword.snapshot).not.toContain("hunter2-secret");
      expect(afterPassword.snapshot).toMatch(/textbox "Password" .*: •+ \(hidden\)/);
      const afterSearch = await session.type(
        { ref: refOf(afterPassword, /textbox "Search"/) },
        "kittens",
      );
      expect(afterSearch.snapshot).toMatch(/textbox "Search" .*: kittens/);
      const results = await session.type({ selector: "#q" }, "puppies", { submit: true });
      expect(results.title).toBe("Results");
      expect(results.snapshot).toContain("You searched for puppies");
    },
    TIMEOUT,
  );

  it(
    "appends when clear is false, selects options by label and presses keys",
    async () => {
      const home = await session.navigate(`${base}/`);
      const search = refOf(home, /textbox "Search"/);
      await session.type({ ref: search }, "red");
      const appended = await session.type({ ref: search }, " panda", { clear: false });
      expect(appended.snapshot).toMatch(/textbox "Search" .*: red panda/);
      const selected = await session.selectOption({ ref: refOf(appended, /combobox "Color"/) }, [
        "Green",
      ]);
      expect(selected.snapshot).toMatch(/option "Green" \[selected\]/);
      await session.click({ ref: search });
      const results = await session.press("enter");
      expect(results.title).toBe("Results");
      expect(results.snapshot).toContain("You searched for red panda");
    },
    TIMEOUT,
  );

  it(
    "never presses Enter for a line break, so only submit submits",
    async () => {
      await session.navigate(`${base}/compose`);
      await session.type({ selector: "#subject" }, "Hi");
      await session.type({ selector: "#subject" }, " there\nfriend", { clear: false });
      await session.type({ selector: "#body" }, "Dear Sam,");
      await session.type({ selector: "#body" }, "\nSee you soon", { clear: false });
      await session.type({ selector: "#chat" }, "one\ntwo", { clear: false });
      const state = async () =>
        JSON.parse(/\{"subject".*\}/.exec(await session.extractText())?.[0] ?? "null");
      expect(await state()).toEqual({
        subject: "Hi therefriend",
        body: "Dear Sam,\nSee you soon",
        chat: "one\ntwo",
        events: [],
      });
      await session.type({ selector: "#chat" }, "!", { clear: false, submit: true });
      expect((await state()).events).toEqual(["sent"]);
    },
    TIMEOUT,
  );

  it(
    "clicks by visible text, inside iframes, and reports dialogs",
    async () => {
      const home = await session.navigate(`${base}/`);
      const changed = await session.click({ text: "Change text" });
      expect(changed.snapshot).toContain("Changed!");
      const inner = await session.click({ ref: refOf(changed, /button "Inner button"/) });
      expect(inner.snapshot).toContain("Inner clicked");
      const confirmed = await session.click({ ref: refOf(home, /button "Confirm me"/) });
      expect(confirmed.snapshot).toMatch(/paragraph .*: "?no"?$/m);
      expect(confirmed.notes?.join("\n")).toMatch(
        /confirm dialog \("Delete it\?"\); it was dismissed/,
      );
    },
    TIMEOUT,
  );

  it(
    "adopts popups and goes back through history and tabs",
    async () => {
      const home = await session.navigate(`${base}/`);
      const popup = await session.click({ ref: refOf(home, /link "Popup link"/) });
      expect(popup.title).toBe("Popup page");
      expect(popup.notes?.join("\n")).toContain("opened a new tab");
      const backHome = await session.back();
      expect(backHome.url).toBe(`${base}/`);
      expect(backHome.notes?.join("\n")).toContain("closed");
      await session.click({ ref: refOf(backHome, /link "Next page"/) });
      const back = await session.back();
      expect(back.url).toBe(`${base}/`);
    },
    TIMEOUT,
  );

  it(
    "takes JPEG screenshots and extracts readable text",
    async () => {
      await session.navigate(`${base}/article`);
      const shot = await session.screenshot();
      expect(shot.mimeType).toBe("image/jpeg");
      expect(shot.data.startsWith("/9j/")).toBe(true);
      expect({ width: shot.width, height: shot.height }).toEqual({ width: 1280, height: 800 });
      expect(jpegSize(Buffer.from(shot.data, "base64"))).toEqual({ width: 1280, height: 800 });
      const full = await session.screenshot({ fullPage: true });
      expect(full.width).toBeLessThanOrEqual(1280);

      const text = await session.extractText();
      expect(text).toBe(
        `Big story\n\nFirst paragraph.\n\n${"Second paragraph. ".repeat(12).trim()}`,
      );
      expect(await session.extractText({ maxChars: 5 })).toMatch(/^Big s\n\[\.\.\. truncated/);
    },
    TIMEOUT,
  );

  it(
    "streams screencast frames while subscribed and emits a frame per action",
    async () => {
      await session.navigate(`${base}/`);
      const frames: Frame[] = [];
      const unsubscribe = session.onFrame((frame) => frames.push(frame));
      await waitFor(() => frames.length > 0);
      await session.click({ text: "Change text" });
      await waitFor(() => frames.some((f) => f.action?.kind === "click"));
      const clickFrame = frames.find((f) => f.action?.kind === "click");
      expect(clickFrame).toMatchObject({
        mimeType: "image/jpeg",
        url: `${base}/`,
        title: "Test Home",
      });
      expect(clickFrame?.action?.x).toBeGreaterThan(0);
      expect(clickFrame?.width).toBe(1280);
      unsubscribe();
      const count = frames.length;
      await session.click({ text: "Change text" });
      await new Promise((r) => setTimeout(r, 300));
      expect(frames.length).toBe(count);
    },
    TIMEOUT,
  );

  it(
    "refuses non-http(s) navigations",
    async () => {
      for (const url of [
        "file:///etc/hosts",
        "chrome://settings",
        "javascript:alert(1)",
        "data:text/html,hi",
      ]) {
        await expect(session.navigate(url)).rejects.toBeInstanceOf(NavigationBlockedError);
      }
      const blank = await session.navigate("about:blank");
      expect(blank.snapshot).toBe("(empty page)");
      const missing = await session.navigate(`${base}/missing`);
      expect(missing.notes).toContain("The server answered HTTP 404 Not Found");
    },
    TIMEOUT,
  );

  it(
    "works end to end through the model-facing tools",
    async () => {
      const forwarded: string[] = [];
      const provider: ExecutionProvider = {
        id: "local",
        capabilities: { shell: false, browser: true, computer: false },
        shell: { exec: () => Promise.reject(new Error("unused")) },
        browser: controller,
        prepareWorkspace: async (key) => ({ key, dir: tmpdir() }),
        dispose: async () => {},
      };
      const tools = new Map(
        createExecutionTools(provider, {
          threadId: "thread-tools",
          taskId: null,
          workspace: { key: "thread-tools", dir: tmpdir() },
          capabilities: ["browser"],
          onFrame: (surface, frame) =>
            forwarded.push(`${surface}:${frame.action?.kind ?? "frame"}`),
        }).map((tool) => [tool.name, tool]),
      );
      const call = (name: string, input: unknown) =>
        tools.get(name)?.execute(input, { toolCallId: name }) ?? Promise.reject(new Error(name));

      const opened = toolResultText(await call(TOOL.browserNavigate, { url: `${base}/` }));
      expect(opened).toContain("Page title: Test Home");
      const searchRef = /textbox "Search" \[ref=((?:f\d+)?e\d+)\]/.exec(opened)?.[1];
      expect(searchRef).toBeDefined();
      const typed = await call(TOOL.browserType, {
        ref: searchRef,
        element: "Search box",
        text: "otters",
        submit: true,
      });
      expect(toolResultText(typed)).toContain("You searched for otters");
      const stale = await call(TOOL.browserClick, { ref: searchRef, element: "Search box" });
      expect(stale.isError).toBe(true);
      expect(toolResultText(stale)).toMatch(/not in the current page snapshot/);
      const shot = await call(TOOL.browserScreenshot, {});
      expect(shot.content.some((c) => c.type === "image")).toBe(true);
      await waitFor(() => forwarded.includes("browser:type"));
      expect(forwarded.every((entry) => entry.startsWith("browser:"))).toBe(true);
      await controller.close("thread-tools");
    },
    TIMEOUT,
  );

  it(
    "keeps sessions isolated and recreates closed ones",
    async () => {
      const other = await controller.session("thread-2");
      expect(other).not.toBe(session);
      await other.navigate(`${base}/next`);
      const mine = await session.navigate(`${base}/`);
      expect(mine.title).toBe("Test Home");
      expect((await other.snapshot()).title).toBe("Next page");

      await controller.close("thread-2");
      expect(controller.has("thread-2")).toBe(false);
      await expect(other.snapshot()).rejects.toThrow(/closed/);
      const reopened = await controller.session("thread-2");
      expect(reopened).not.toBe(other);
      expect((await reopened.snapshot()).snapshot).toBe("(empty page)");
      await controller.close("thread-2");
    },
    TIMEOUT,
  );
});
