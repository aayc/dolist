import {
  type JsonSchema,
  TOOL_NAME_RE,
  type ToolResult,
  type ToolSpec,
  toolResultText,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import { TOOL } from "../tools/contracts";
import { StaleRefError } from "./errors";
import { createExecutionTools } from "./tools";
import type {
  BrowserController,
  BrowserSession,
  BrowserSnapshot,
  BrowserTarget,
  Capability,
  ComputerController,
  ComputerScreenshot,
  ExecutionProvider,
  ExecutionToolContext,
  FrameListener,
} from "./types";
import { type Frame, FrameHub } from "./util/frame-hub";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const frame = (label: string): Frame => ({
  mimeType: "image/jpeg",
  data: Buffer.from(label).toString("base64"),
  width: 1280,
  height: 800,
  ts: 1,
  action: { kind: label },
});

class FakeSession implements BrowserSession {
  readonly key: string;
  readonly calls: unknown[][] = [];
  readonly frames = new FrameHub();
  notes: string[] | undefined;
  failWith: Error | undefined;

  constructor(key: string) {
    this.key = key;
  }

  private result(call: unknown[]): Promise<BrowserSnapshot> {
    this.calls.push(call);
    if (this.failWith) return Promise.reject(this.failWith);
    const notes = this.notes;
    this.notes = undefined;
    return Promise.resolve({
      url: "https://example.com/",
      title: "Example",
      snapshot: '- button "Go" [ref=e1]',
      ...(notes ? { notes } : {}),
    });
  }

  navigate(url: string) {
    return this.result(["navigate", url]);
  }
  snapshot() {
    return this.result(["snapshot"]);
  }
  click(target: BrowserTarget) {
    return this.result(["click", target]);
  }
  type(target: BrowserTarget, text: string, options?: { submit?: boolean; clear?: boolean }) {
    return this.result(["type", target, text, options]);
  }
  selectOption(target: BrowserTarget, values: string[]) {
    return this.result(["selectOption", target, values]);
  }
  press(key: string) {
    return this.result(["press", key]);
  }
  scroll(direction: "up" | "down", pixels?: number) {
    return this.result(["scroll", direction, pixels]);
  }
  back() {
    return this.result(["back"]);
  }
  async screenshot(options?: { fullPage?: boolean }) {
    this.calls.push(["screenshot", options]);
    return { data: "aGVsbG8=", mimeType: "image/jpeg" as const, width: 1280, height: 800 };
  }
  async extractText(options?: { maxChars?: number }) {
    this.calls.push(["extractText", options]);
    return "Readable text";
  }
  onFrame(listener: FrameListener) {
    return this.frames.subscribe(listener);
  }
  async close() {
    this.frames.clear();
  }
}

class FakeBrowser implements BrowserController {
  readonly sessions = new Map<string, FakeSession>();
  async session(key: string): Promise<BrowserSession> {
    let session = this.sessions.get(key);
    if (!session) {
      session = new FakeSession(key);
      this.sessions.set(key, session);
    }
    return session;
  }
  has(key: string) {
    return this.sessions.has(key);
  }
  async close(key: string) {
    await this.sessions.get(key)?.close();
    this.sessions.delete(key);
  }
  async dispose() {}
}

class FakeComputer implements ComputerController {
  readonly platform = "macos" as const;
  readonly calls: unknown[][] = [];
  readonly frames = new FrameHub();
  delayMs = 0;

  async check() {
    return { ok: true };
  }
  private async act(call: unknown[], label: string): Promise<void> {
    this.calls.push(call);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.frames.emit(frame(label));
  }
  async screenshot(): Promise<ComputerScreenshot> {
    this.calls.push(["screenshot"]);
    this.frames.emit(frame("screenshot"));
    return { data: "c2hvdA==", mimeType: "image/jpeg", width: 1280, height: 827, scale: 0.74 };
  }
  click(x: number, y: number, options?: { button?: "left" | "right"; double?: boolean }) {
    return this.act(["click", x, y, options], `click-${x}`);
  }
  move(x: number, y: number) {
    return this.act(["move", x, y], "move");
  }
  type(text: string) {
    return this.act(["type", text], "type");
  }
  key(combo: string) {
    return this.act(["key", combo], "key");
  }
  scroll(dx: number, dy: number) {
    return this.act(["scroll", dx, dy], "scroll");
  }
  onFrame(listener: FrameListener) {
    return this.frames.subscribe(listener);
  }
}

function fakeProvider(
  parts: {
    browser?: FakeBrowser;
    computer?: FakeComputer;
    capabilities?: Partial<ExecutionProvider["capabilities"]>;
  } = {},
): ExecutionProvider {
  return {
    id: "fake",
    capabilities: {
      shell: true,
      browser: parts.browser !== undefined,
      computer: parts.computer !== undefined,
      ...parts.capabilities,
    },
    shell: {
      exec: async () => ({
        exitCode: 0,
        output: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      }),
    },
    ...(parts.browser ? { browser: parts.browser } : {}),
    ...(parts.computer ? { computer: parts.computer } : {}),
    prepareWorkspace: async (key) => ({ key, dir: `/tmp/${key}` }),
    dispose: async () => {},
  };
}

type Forwarded = { surface: "browser" | "computer"; frame: Frame };

function context(capabilities: Capability[], threadId = "thr_1") {
  const forwarded: Forwarded[] = [];
  const ctx: ExecutionToolContext = {
    threadId,
    taskId: "task_1",
    workspace: { key: threadId, dir: `/tmp/${threadId}` },
    capabilities,
    onFrame: (surface, f) => forwarded.push({ surface, frame: f }),
  };
  return { ctx, forwarded };
}

function toolMap(tools: ToolSpec[]): Map<string, ToolSpec> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function run(
  tool: ToolSpec | undefined,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!tool) throw new Error("tool missing");
  return tool.execute(input, { toolCallId: "call_1", ...(signal ? { signal } : {}) });
}

const BROWSER_TOOLS = [
  TOOL.browserNavigate,
  TOOL.browserSnapshot,
  TOOL.browserClick,
  TOOL.browserType,
  TOOL.browserSelectOption,
  TOOL.browserPressKey,
  TOOL.browserScroll,
  TOOL.browserBack,
  TOOL.browserScreenshot,
  TOOL.browserExtractText,
];
const COMPUTER_TOOLS = [
  TOOL.computerScreenshot,
  TOOL.computerClick,
  TOOL.computerMove,
  TOOL.computerType,
  TOOL.computerKey,
  TOOL.computerScroll,
];

// ── Minimal JSON Schema subset validator (what our schemas use) ────────────────

function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return [`${path}: not an object`];
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        continue;
      }
      errors.push(...validate(childSchema, child, `${path}.${key}`));
    }
    return errors;
  }
  if (type === "string" && typeof value !== "string") return [`${path}: not a string`];
  if (type === "boolean" && typeof value !== "boolean") return [`${path}: not a boolean`];
  if ((type === "number" || type === "integer") && typeof value !== "number")
    return [`${path}: not a number`];
  if (type === "integer" && !Number.isInteger(value)) return [`${path}: not an integer`];
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: not in enum`);
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path}: too few items`);
    for (const [i, item] of value.entries()) {
      errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`));
    }
  }
  return errors;
}

const VALID_INPUTS: Record<string, unknown> = {
  [TOOL.browserNavigate]: { url: "https://example.com" },
  [TOOL.browserSnapshot]: {},
  [TOOL.browserClick]: { ref: "e1", element: "Go button" },
  [TOOL.browserType]: { ref: "e2", element: "Search box", text: "cats", submit: true },
  [TOOL.browserSelectOption]: { ref: "e3", element: "Color", values: ["Green"] },
  [TOOL.browserPressKey]: { key: "Enter" },
  [TOOL.browserScroll]: { direction: "down", pixels: 600 },
  [TOOL.browserBack]: {},
  [TOOL.browserScreenshot]: { fullPage: true },
  [TOOL.browserExtractText]: { maxChars: 5000 },
  [TOOL.computerScreenshot]: {},
  [TOOL.computerClick]: { x: 10, y: 20, element: "Send button", double: false, button: "left" },
  [TOOL.computerMove]: { x: 10, y: 20 },
  [TOOL.computerType]: { text: "hello" },
  [TOOL.computerKey]: { combo: "cmd+s" },
  [TOOL.computerScroll]: { dx: 0, dy: 3 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createExecutionTools: capability filtering", () => {
  const provider = fakeProvider({ browser: new FakeBrowser(), computer: new FakeComputer() });
  const names = (caps: Capability[], p = provider) =>
    createExecutionTools(p, context(caps).ctx).map((t) => t.name);

  it("only includes tools for granted capabilities", () => {
    expect(names([])).toEqual([]);
    expect(names(["shell", "files", "web", "connectors"])).toEqual([]);
    expect(names(["browser"])).toEqual(BROWSER_TOOLS);
    expect(names(["computer"])).toEqual(COMPUTER_TOOLS);
    expect(names(["browser", "computer"])).toEqual([...BROWSER_TOOLS, ...COMPUTER_TOOLS]);
  });

  it("omits tools the provider cannot back", () => {
    expect(names(["browser", "computer"], fakeProvider())).toEqual([]);
    const noChrome = fakeProvider({ browser: new FakeBrowser(), capabilities: { browser: false } });
    expect(names(["browser"], noChrome)).toEqual([]);
  });
});

describe("tool specs", () => {
  const tools = createExecutionTools(
    fakeProvider({ browser: new FakeBrowser(), computer: new FakeComputer() }),
    context(["browser", "computer"]).ctx,
  );

  it("have valid names, labels, descriptions and object schemas", () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(TOOL_NAME_RE);
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(tool.parameters);
      const properties = tool.parameters.properties as Record<string, JsonSchema>;
      for (const key of tool.parameters.required as string[])
        expect(properties).toHaveProperty(key);
      for (const [key, property] of Object.entries(properties)) {
        expect(property.type, `${tool.name}.${key}`).toBeTypeOf("string");
        expect(property.description, `${tool.name}.${key}`).toBeTypeOf("string");
      }
    }
  });

  it("accept valid inputs and reject missing required fields", () => {
    for (const tool of tools) {
      expect(validate(tool.parameters, VALID_INPUTS[tool.name]), tool.name).toEqual([]);
    }
    const byName = toolMap(tools);
    for (const name of [
      TOOL.browserClick,
      TOOL.browserType,
      TOOL.browserSelectOption,
      TOOL.computerClick,
    ]) {
      expect(byName.get(name)?.parameters.required).toContain("element");
    }
    expect(validate(byName.get(TOOL.browserClick)!.parameters, { ref: "e1" })).toEqual([
      "$.element: required",
    ]);
    expect(validate(byName.get(TOOL.browserScroll)!.parameters, { direction: "left" })).toEqual([
      "$.direction: not in enum",
    ]);
  });

  it("declare honest safety hints", () => {
    const byName = toolMap(tools);
    const hints = (name: string) => byName.get(name)?.safety;
    for (const name of [
      TOOL.browserSnapshot,
      TOOL.browserScroll,
      TOOL.browserScreenshot,
      TOOL.browserExtractText,
      TOOL.computerScreenshot,
    ]) {
      expect(hints(name), name).toMatchObject({ readOnly: true, category: "read" });
    }
    expect(hints(TOOL.browserNavigate)).toMatchObject({
      readOnly: true,
      openWorld: true,
      category: "network",
    });
    expect(hints(TOOL.browserBack)).toMatchObject({ readOnly: true, category: "network" });
    for (const name of [
      TOOL.browserClick,
      TOOL.browserType,
      TOOL.browserSelectOption,
      TOOL.browserPressKey,
    ]) {
      expect(hints(name), name).toMatchObject({
        readOnly: false,
        openWorld: true,
        category: "browser_input",
      });
    }
    for (const name of COMPUTER_TOOLS.filter((n) => n !== TOOL.computerScreenshot)) {
      expect(hints(name), name).toMatchObject({ readOnly: false, category: "computer_control" });
    }
    for (const name of [TOOL.computerClick, TOOL.computerType, TOOL.computerKey]) {
      expect(hints(name)?.openWorld, name).toBe(true);
    }
    for (const tool of tools) {
      expect(tool.safety.alwaysRequireApproval, tool.name).toBeUndefined();
      expect(tool.safety.describe, tool.name).toBeTypeOf("function");
    }
  });

  it("describe actions for approval cards", () => {
    const describe = (name: string, input: unknown) =>
      toolMap(tools).get(name)?.safety.describe?.(input);
    expect(describe(TOOL.browserNavigate, { url: "https://www.example.com/path/" })).toBe(
      "Navigate to www.example.com/path",
    );
    expect(describe(TOOL.browserNavigate, { url: "about:blank" })).toBe("Open a blank page");
    expect(describe(TOOL.browserClick, { ref: "e9", element: "Place order" })).toBe(
      "Click “Place order” in the browser",
    );
    expect(describe(TOOL.browserClick, { text: "Sign in" })).toBe("Click “Sign in” in the browser");
    expect(
      describe(TOOL.browserType, { ref: "e3", element: "Card number", text: "4242424242424242" }),
    ).toBe("Type into “Card number” (value hidden)");
    expect(
      describe(TOOL.browserType, {
        ref: "e2",
        element: "Search box",
        text: "red pandas",
        submit: true,
      }),
    ).toBe("Type “red pandas” into “Search box” and press Enter");
    expect(describe(TOOL.browserType, { selector: "#q", text: "cats" })).toBe(
      "Type “cats” into element “#q”",
    );
    expect(
      describe(TOOL.browserSelectOption, { ref: "e4", element: "Color", values: ["Green"] }),
    ).toBe("Select “Green” in “Color”");
    expect(describe(TOOL.browserPressKey, { key: "Enter" })).toBe("Press Enter in the browser");
    expect(describe(TOOL.browserScroll, { direction: "down", pixels: 600 })).toBe(
      "Scroll the page down 600px",
    );
    expect(describe(TOOL.computerClick, { x: 512, y: 300, element: "Send button" })).toBe(
      "Click at (512, 300) on “Send button” on the desktop",
    );
    expect(describe(TOOL.computerClick, { x: 5, y: 6, element: "File", double: true })).toBe(
      "Double-click at (5, 6) on “File” on the desktop",
    );
    expect(describe(TOOL.computerClick, { x: 5, y: 6, element: "Icon", button: "right" })).toBe(
      "Right-click at (5, 6) on “Icon” on the desktop",
    );
    expect(describe(TOOL.computerType, { text: "hello" })).toBe("Type “hello” on the desktop");
    expect(describe(TOOL.computerType, { text: "buy milk\n" })).toBe(
      "Type “buy milk” and press Return on the desktop",
    );
    expect(describe(TOOL.computerType, { text: "ok\r\n\n" })).toBe(
      "Type “ok” and press Return 2 times on the desktop",
    );
    expect(describe(TOOL.computerType, { text: "\n" })).toBe("Press Return on the desktop");
    expect(describe(TOOL.computerType, { text: "line one\rline two\n" })).toBe(
      "Type “line one⏎line two⏎” on the desktop, pressing Return 2 times",
    );
    expect(describe(TOOL.computerKey, { combo: "cmd+shift+4" })).toBe(
      "Press cmd+shift+4 on the desktop",
    );
    expect(describe(TOOL.computerScroll, { dx: -2, dy: 5 })).toBe(
      "Scroll down 5 and left 2 on the desktop",
    );
    expect(describe(TOOL.computerMove, { x: 1, y: 2 })).toBe(
      "Move the mouse to (1, 2) on the desktop",
    );
  });

  it("never throw from describe on malformed input", () => {
    for (const tool of tools) {
      for (const input of [
        undefined,
        null,
        "garbage",
        42,
        [],
        {},
        { url: 7, element: {}, x: "a" },
      ]) {
        const text = tool.safety.describe?.(input);
        expect(typeof text, tool.name).toBe("string");
        expect(text?.length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it("carry prompt guidelines on the first tool of each group", () => {
    const byName = toolMap(tools);
    expect(byName.get(TOOL.browserNavigate)?.promptGuidelines?.join("\n")).toMatch(/untrusted/i);
    expect(byName.get(TOOL.browserNavigate)?.promptGuidelines?.join("\n")).toMatch(/element/);
    expect(byName.get(TOOL.computerScreenshot)?.promptGuidelines?.join("\n")).toMatch(
      /prefer the browser/i,
    );
  });
});

describe("browser tools: execution", () => {
  function setup() {
    const browser = new FakeBrowser();
    const { ctx, forwarded } = context(["browser"]);
    const tools = toolMap(createExecutionTools(fakeProvider({ browser }), ctx));
    return { browser, ctx, forwarded, tools, session: () => browser.sessions.get("thr_1") };
  }

  it("returns snapshots with page info, notes and an untrusted-content marker", async () => {
    const { tools, session } = setup();
    const result = await run(tools.get(TOOL.browserNavigate), { url: "https://example.com" });
    expect(result.isError).toBeUndefined();
    const text = toolResultText(result);
    expect(text).toContain("Page URL: https://example.com/");
    expect(text).toContain("Page title: Example");
    expect(text).toContain('```yaml\n- button "Go" [ref=e1]\n```');
    expect(text).toMatch(/untrusted/);
    expect(result.details).toEqual({ url: "https://example.com/", title: "Example" });
    expect(session()?.calls).toEqual([["navigate", "https://example.com"]]);

    session()!.notes = ["The page showed a confirm dialog; it was dismissed (Cancel)."];
    const clicked = toolResultText(
      await run(tools.get(TOOL.browserClick), { ref: "e1", element: "Go button" }),
    );
    expect(clicked.startsWith("Clicked “Go button”.")).toBe(true);
    expect(clicked).toContain("Notes:\n- The page showed a confirm dialog");
  });

  it("maps inputs onto session calls", async () => {
    const { tools, session } = setup();
    await run(tools.get(TOOL.browserClick), { selector: "#go", element: "Go" });
    await run(tools.get(TOOL.browserType), {
      ref: "e2",
      element: "Search",
      text: " panda",
      clear: false,
      submit: true,
    });
    await run(tools.get(TOOL.browserSelectOption), {
      ref: "e3",
      element: "Color",
      values: ["Green", "Red"],
    });
    await run(tools.get(TOOL.browserPressKey), { key: "Control+A" });
    await run(tools.get(TOOL.browserScroll), { direction: "up" });
    await run(tools.get(TOOL.browserBack), {});
    await run(tools.get(TOOL.browserSnapshot), undefined);
    expect(session()?.calls).toEqual([
      ["click", { selector: "#go" }],
      ["type", { ref: "e2" }, " panda", { submit: true, clear: false }],
      ["selectOption", { ref: "e3" }, ["Green", "Red"]],
      ["press", "Control+A"],
      ["scroll", "up", undefined],
      ["back"],
      ["snapshot"],
    ]);
  });

  it("returns images and text for screenshot and extract_text", async () => {
    const { tools } = setup();
    const shot = await run(tools.get(TOOL.browserScreenshot), {});
    expect(shot.content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
    expect(toolResultText(shot)).toContain("1280×800");
    const text = toolResultText(await run(tools.get(TOOL.browserExtractText), { maxChars: 1000 }));
    expect(text).toContain("Readable text");
    expect(text).toMatch(/untrusted/);
  });

  it("reports bad input and failures to the model instead of throwing", async () => {
    const { tools, session } = setup();
    const noElement = await run(tools.get(TOOL.browserClick), { ref: "e1" });
    expect(noElement).toMatchObject({ isError: true });
    expect(toolResultText(noElement)).toContain("`element` is required");
    const noTarget = await run(tools.get(TOOL.browserType), { element: "Search", text: "cats" });
    expect(toolResultText(noTarget)).toMatch(/`ref`.*`selector`/);
    const badUrl = await run(tools.get(TOOL.browserNavigate), { url: 42 });
    expect(toolResultText(badUrl)).toContain("`url` must be a string");

    await run(tools.get(TOOL.browserSnapshot), {});
    session()!.failWith = new StaleRefError("Ref e7 is not in the current page snapshot.");
    const stale = await run(tools.get(TOOL.browserClick), { ref: "e7", element: "Old button" });
    expect(stale).toMatchObject({ isError: true });
    expect(toolResultText(stale)).toBe("Ref e7 is not in the current page snapshot.");
    session()!.failWith = new Error("Target crashed\nCall log: ...");
    expect(toolResultText(await run(tools.get(TOOL.browserSnapshot), {}))).toBe(
      "The action failed: Target crashed",
    );
  });

  it("propagates aborts", async () => {
    const { tools } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(run(tools.get(TOOL.browserSnapshot), {}, controller.signal)).rejects.toMatchObject(
      {
        name: "AbortError",
      },
    );
  });

  it("forwards session frames and resubscribes after the provider closes the session", async () => {
    const { browser, tools, forwarded, session } = setup();
    await run(tools.get(TOOL.browserSnapshot), {});
    const first = session()!;
    first.frames.emit(frame("one"));
    expect(forwarded.map((f) => [f.surface, f.frame.action?.kind])).toEqual([["browser", "one"]]);

    await browser.close("thr_1");
    first.frames.emit(frame("stale"));
    await run(tools.get(TOOL.browserSnapshot), {});
    const second = session()!;
    expect(second).not.toBe(first);
    second.frames.emit(frame("two"));
    expect(forwarded.map((f) => f.frame.action?.kind)).toEqual(["one", "two"]);
  });

  it("hands frame forwarding to the newest tool set for the thread", async () => {
    const browser = new FakeBrowser();
    const provider = fakeProvider({ browser });
    const a = context(["browser"]);
    const b = context(["browser"]);
    await run(toolMap(createExecutionTools(provider, a.ctx)).get(TOOL.browserSnapshot), {});
    await run(toolMap(createExecutionTools(provider, b.ctx)).get(TOOL.browserSnapshot), {});
    browser.sessions.get("thr_1")!.frames.emit(frame("x"));
    expect(a.forwarded).toHaveLength(0);
    expect(b.forwarded).toHaveLength(1);
    expect(browser.sessions.get("thr_1")!.frames.size).toBe(1);
  });
});

describe("computer tools: execution", () => {
  it("returns screenshots and post-action images, forwarding frames to the calling thread", async () => {
    const computer = new FakeComputer();
    const { ctx, forwarded } = context(["computer"]);
    const tools = toolMap(createExecutionTools(fakeProvider({ computer }), ctx));

    const shot = await run(tools.get(TOOL.computerScreenshot), {});
    expect(shot.content[1]).toEqual({ type: "image", data: "c2hvdA==", mimeType: "image/jpeg" });
    expect(toolResultText(shot)).toContain("1280×827");
    expect(shot.details).toEqual({ width: 1280, height: 827, scale: 0.74 });

    const clicked = await run(tools.get(TOOL.computerClick), {
      x: 5,
      y: 6,
      element: "OK",
      double: true,
    });
    expect(toolResultText(clicked)).toContain("Clicked “OK” at (5, 6).");
    expect(clicked.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    await run(tools.get(TOOL.computerType), { text: "hi there" });
    await run(tools.get(TOOL.computerKey), { combo: "cmd+s" });
    await run(tools.get(TOOL.computerScroll), { dx: 0, dy: -4 });
    await run(tools.get(TOOL.computerMove), { x: 1, y: 2 });
    expect(computer.calls).toEqual([
      ["screenshot"],
      ["click", 5, 6, { double: true }],
      ["type", "hi there"],
      ["key", "cmd+s"],
      ["scroll", 0, -4],
      ["move", 1, 2],
    ]);
    expect(forwarded.map((f) => [f.surface, f.frame.action?.kind])).toEqual([
      ["computer", "screenshot"],
      ["computer", "click-5"],
      ["computer", "type"],
      ["computer", "key"],
      ["computer", "scroll"],
      ["computer", "move"],
    ]);
    expect(computer.frames.size).toBe(0);
  });

  it("serializes desktop actions across threads so frames reach the right thread", async () => {
    const computer = new FakeComputer();
    computer.delayMs = 20;
    const provider = fakeProvider({ computer });
    const a = context(["computer"], "thr_a");
    const b = context(["computer"], "thr_b");
    const clickA = toolMap(createExecutionTools(provider, a.ctx)).get(TOOL.computerClick);
    const clickB = toolMap(createExecutionTools(provider, b.ctx)).get(TOOL.computerClick);
    await Promise.all([
      run(clickA, { x: 1, y: 1, element: "A" }),
      run(clickB, { x: 2, y: 2, element: "B" }),
    ]);
    expect(a.forwarded.map((f) => f.frame.action?.kind)).toEqual(["click-1"]);
    expect(b.forwarded.map((f) => f.frame.action?.kind)).toEqual(["click-2"]);
  });

  it("validates coordinates and required fields", async () => {
    const computer = new FakeComputer();
    const tools = toolMap(
      createExecutionTools(fakeProvider({ computer }), context(["computer"]).ctx),
    );
    expect(toolResultText(await run(tools.get(TOOL.computerClick), { x: 1, y: 1 }))).toContain(
      "`element` is required",
    );
    expect(
      toolResultText(await run(tools.get(TOOL.computerClick), { x: -1, y: 1, element: "x" })),
    ).toContain("at least 0");
    expect(toolResultText(await run(tools.get(TOOL.computerScroll), { dy: 1 }))).toContain(
      "`dx` is required",
    );
    expect(computer.calls).toEqual([]);
  });
});
