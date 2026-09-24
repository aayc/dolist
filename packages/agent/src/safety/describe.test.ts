import { describe, expect, it } from "vitest";
import { describeAction, redactActionInput } from "./describe";
import { HIDDEN_VALUE } from "./sensitive";
import { actionContext } from "./test-helpers";

const summary = (toolName: string, input: unknown, extra = {}) =>
  describeAction(actionContext(toolName, input, extra));

describe("describeAction", () => {
  it.each([
    ["browser_click", { element: "Place order" }, "Click “Place order” in the browser"],
    [
      "browser_type",
      { element: "Search", text: "flights to Lisbon", submit: true },
      "Type “flights to Lisbon” into “Search” and submit in the browser",
    ],
    [
      "browser_type",
      { element: "Card number", text: "4111 1111 1111 1111" },
      "Type into “Card number” (value hidden) in the browser",
    ],
    [
      "browser_type",
      { element: "Password", text: "hunter22" },
      "Type into “Password” (value hidden) in the browser",
    ],
    [
      "browser_select_option",
      { element: "Guests", values: ["2 adults"] },
      "Select “2 adults” in “Guests” in the browser",
    ],
    ["browser_press_key", { key: "Enter" }, "Press Enter in the browser"],
    [
      "browser_navigate",
      { url: "https://example.com/a" },
      "Open https://example.com/a in the browser",
    ],
    ["browser_scroll", { direction: "down" }, "Scroll down in the browser"],
    ["browser_back", {}, "Go back in the browser"],
    ["browser_snapshot", {}, "Read the current page"],
    [
      "computer_click",
      { x: 10, y: 20, element: "Send button" },
      "Click “Send button” on the screen at (10, 20)",
    ],
    ["computer_type", { text: "hello" }, "Type “hello” on the computer"],
    ["computer_key", { combo: "cmd+shift+4" }, "Press Cmd+Shift+4 on the computer"],
    ["computer_move", { x: 3, y: 4 }, "Move the mouse to (3, 4)"],
    ["computer_screenshot", {}, "Take a screenshot of the screen"],
    ["bash", { command: "rm -rf build" }, "Run shell command: rm -rf build"],
    ["read", { path: "notes/plan.md" }, "Read file notes/plan.md"],
    ["grep", { pattern: "TODO", path: "src" }, "Search files for “TODO” in src"],
    ["write", { path: "out.md", content: "# Hi" }, "Write file out.md (4 B)"],
    ["edit", { path: "src/a.ts", edits: [] }, "Edit file src/a.ts"],
    ["web_fetch", { url: "https://example.com" }, "Fetch https://example.com"],
    ["web_search", { query: "best trails" }, "Search the web for “best trails”"],
    [
      "mcp__gmail__send_email",
      { to: "a@example.com", subject: "Lunch Friday", body: "…" },
      "Send email via gmail to a@example.com — “Lunch Friday”",
    ],
    [
      "mcp__slack__slack_post_message",
      { channel: "C123", text: "hi" },
      "Post message via slack to C123",
    ],
    ["mcp__gmail__search_threads", { query: "from:bank" }, "Search threads via gmail: from:bank"],
    [
      "mcp__stripe__create_payment_intent",
      { amount: 4200, currency: "usd" },
      "Create payment intent via stripe for 4200 usd",
    ],
    ["ask_user", { question: "Which date works?" }, "Ask you: “Which date works?”"],
  ])("%s %j", (tool, input, expected) => {
    expect(summary(tool, input)).toBe(expected);
  });

  it("prefers a tool's own describe() and still masks secrets in it", () => {
    const text = summary(
      "custom_tool",
      {},
      { hints: { describe: () => "Charge card 4111 1111 1111 1111" } },
    );
    expect(text).toBe("Charge card •••• 1111");
  });

  it("masks secret-looking values typed anywhere and secrets inside commands", () => {
    expect(
      summary("browser_type", { element: "Notes", text: "Xk29vLq8Zr0Tb7Wn4Yp1Hs6Jd3Fg5Mc2" }),
    ).toBe("Type into “Notes” (value hidden) in the browser");
    const token = `ghp_${"a1B2".repeat(9)}`;
    expect(
      summary("bash", {
        command: `curl -H "Authorization: token ${token}" https://api.example.com`,
      }),
    ).not.toContain(token);
  });

  it("clips long summaries", () => {
    expect(summary("bash", { command: `echo ${"x".repeat(500)}` }).length).toBeLessThanOrEqual(200);
  });
});

describe("redactActionInput", () => {
  it("hides values typed into sensitive fields", () => {
    const ctx = actionContext("browser_type", { element: "Password", text: "hunter22", ref: "e1" });
    expect(redactActionInput(ctx)).toEqual({ element: "Password", text: HIDDEN_VALUE, ref: "e1" });
  });

  it("masks card numbers in other fields but keeps readable content", () => {
    const ctx = actionContext("mcp__gmail__send_email", {
      to: "a@example.com",
      body: "My card is 4111 1111 1111 1111",
    });
    expect(redactActionInput(ctx)).toEqual({ to: "a@example.com", body: "My card is •••• 1111" });
  });

  it("hides form-fill values when a sensitive field is present", () => {
    const ctx = actionContext("mcp__playwright__browser_fill_form", {
      fields: [
        { name: "Card number", value: "4111111111111111" },
        { name: "Name on card", value: "A. Example" },
      ],
    });
    const redacted = redactActionInput(ctx) as { fields: Array<{ value: string }> };
    expect(redacted.fields.map((f) => f.value)).toEqual([HIDDEN_VALUE, HIDDEN_VALUE]);
  });
});
