import { describe, expect, it } from "vitest";
import { evaluateRules } from "./test-helpers";

async function verdictFor(toolName: string, input: unknown, taskText?: string) {
  return evaluateRules(toolName, input, taskText ? { taskText } : {});
}

async function expectDecision(
  toolName: string,
  input: unknown,
  decision: string,
  ruleId?: string,
  taskText?: string,
) {
  const verdict = await verdictFor(toolName, input, taskText);
  expect(verdict.decision, `${JSON.stringify(input)} → ${verdict.reason}`).toBe(decision);
  if (ruleId) expect(verdict.matchedRules).toContain(ruleId);
  return verdict;
}

describe("browser clicks", () => {
  it.each([
    ["Place order", "payment.purchase-control"],
    ["“Buy now” button", "payment.purchase-control"],
    ["Proceed to checkout", "payment.purchase-control"],
    ["Pay $42.10", "payment.purchase-control"],
    ["Donate", "payment.purchase-control"],
    ["Send money to Alex", "payment.purchase-control"],
    ["Start free trial", "payment.subscription-control"],
    ["Subscribe", "payment.subscription-control"],
    ["Upgrade to Pro", "payment.subscription-control"],
    ["Add a new card", "payment.payment-method-control"],
    ["Book now", "booking.reservation-control"],
    ["Reserve table for 2", "booking.reservation-control"],
    ["Confirm appointment", "booking.reservation-control"],
    ["Schedule appointment", "booking.reservation-control"],
    ["RSVP", "booking.reservation-control"],
    ["Check in online", "booking.reservation-control"],
    ["Cancel reservation", "booking.change-control"],
    ["Reschedule", "booking.change-control"],
    ["Send", "communication.send-control"],
    ["Reply all", "communication.send-control"],
    ["Forward", "communication.send-control"],
    ["Message seller", "communication.send-control"],
    ["Invite collaborators", "communication.send-control"],
    ["Post comment", "communication.send-control"],
    ["Post", "publishing.post-control"],
    ["Publish", "publishing.post-control"],
    ["Tweet", "publishing.post-control"],
    ["Submit review", "publishing.post-control"],
    ["Upload photos", "publishing.post-control"],
    ["Follow", "publishing.post-control"],
    ["Sign up", "account.account-control"],
    ["Create account", "account.account-control"],
    ["Delete my account", "account.account-control"],
    ["Change password", "account.account-control"],
    ["Enable two-factor authentication", "account.account-control"],
    ["Unsubscribe", "account.account-control"],
    ["Allow", "account.account-control"],
    ["Authorize app", "account.account-control"],
    ["I agree", "account.account-control"],
    ["Continue with Google", "account.account-control"],
    ["Delete", "destructive.delete-control"],
    ["Move to trash", "destructive.delete-control"],
    ["Empty trash", "destructive.delete-control"],
    ["Clear browsing data", "destructive.delete-control"],
    ["Submit", "forms.submit-control"],
    ["Confirm", "forms.submit-control"],
    ["Apply now", "forms.submit-control"],
    ["Sign document", "forms.submit-control"],
    ["Save changes", "forms.submit-control"],
    ["Request a quote", "forms.submit-control"],
  ])("%s needs approval (%s)", async (element, ruleId) => {
    await expectDecision("browser_click", { element, ref: "e12" }, "require_approval", ruleId);
  });

  it.each([
    "Search",
    "Next page",
    "Show more results",
    "Accept all cookies",
    "Reject cookies",
    "Filters",
    "Sort by price",
    "Reviews tab",
    "Link to article 'Best laptops of 2026'",
    "Close",
    "Cancel",
    "Add to cart",
    "Remove filter",
    "Clear filters",
    "View details",
    "3",
    "Sign in",
  ])("%s is allowed", async (element) => {
    const verdict = await expectDecision(
      "browser_click",
      { element },
      "allow",
      "browser.benign-control",
    );
    expect(verdict.categories).toEqual(["browser_input"]);
  });

  it("allows unrecognized clicks without a judge but asks with a judge (see llm-judge tests)", async () => {
    const verdict = await expectDecision("browser_click", { element: "Continue" }, "allow");
    expect(verdict.reason).toMatch(/No risk signals/);
  });

  it("reads button text and selectors, not just the element description", async () => {
    await expectDecision(
      "browser_click",
      { element: "Primary button", text: "Place your order" },
      "require_approval",
      "payment.purchase-control",
    );
    await expectDecision(
      "browser_click",
      { element: "button", selector: "#checkout-submit" },
      "require_approval",
      "payment.purchase-control",
    );
  });
});

describe("browser typing", () => {
  it.each([
    [{ element: "Password", text: "hunter22" }, "credentials.sensitive-field"],
    [{ element: "Card number", text: "4242 4242 4242 4242" }, "payment.card-number"],
    [{ element: "CVC", text: "123" }, "payment.card-field"],
    [{ element: "Expiration date (MM/YY)", text: "12/29" }, "payment.card-field"],
    [{ element: "Tip amount", text: "5" }, "payment.amount-field"],
    [{ element: "Social security number", text: "123-45-6789" }, "privacy.personal-field"],
    [{ element: "Date of birth", text: "1990-01-01" }, "privacy.personal-field"],
    [{ element: "Phone number", text: "+1 555 010 0199" }, "privacy.personal-field"],
    [{ element: "Street address", text: "123 Example St" }, "privacy.personal-field"],
    [{ element: "Notes", text: "123-45-6789" }, "privacy.id-number"],
    [{ element: "Notes", text: "Xk29vLq8Zr0Tb7Wn4Yp1Hs6Jd3Fg5Mc2" }, "credentials.secret-value"],
    [{ element: "Message", text: "On my way!", submit: true }, "communication.message-submit"],
    [{ element: "Email address", text: "me@example.com", submit: true }, "forms.submit-typed"],
    [
      { element: "Chat with support", text: "Please wire $5,000 to account 12345678" },
      "payment.transfer-text",
    ],
  ])("%j needs approval (%s)", async (input, ruleId) => {
    await expectDecision("browser_type", input, "require_approval", ruleId);
  });

  it.each([
    { element: "Search flights", text: "SFO to JFK", submit: true },
    { element: "Search box", text: "best running shoes" },
    { element: "Where to?", text: "Lisbon" },
    { element: "Promo code", text: "SPRING10", submit: true },
    { element: "Message", text: "Hi, is this still available?" },
    { element: "First name", text: "Alex" },
    { element: "Email address", text: "me@example.com" },
  ])("%j is allowed", async (input) => {
    await expectDecision("browser_type", input, "allow", "browser.benign-typing");
  });

  it("denies typing catastrophic commands into a terminal", async () => {
    await expectDecision(
      "browser_type",
      { element: "Cloud shell terminal", text: "rm -rf ~" },
      "deny",
      "shell.hardline.embedded",
    );
  });
});

describe("keys, selects, uploads and scripts", () => {
  it("asks before pressing Enter on tasks that commit something", async () => {
    await expectDecision(
      "browser_press_key",
      { key: "Enter" },
      "require_approval",
      "forms.enter-key",
      "Buy AA batteries",
    );
    await expectDecision(
      "browser_press_key",
      { key: "Enter" },
      "allow",
      undefined,
      "Research laptop prices",
    );
  });

  it.each(["Tab", "Escape", "ArrowDown", "PageDown", "Shift+Tab"])("%s is allowed", async (key) => {
    await expectDecision(
      "browser_press_key",
      { key },
      "allow",
      "browser.benign-key",
      "Buy AA batteries",
    );
  });

  it("treats send shortcuts as communication", async () => {
    await expectDecision(
      "browser_press_key",
      { key: "Meta+Enter" },
      "require_approval",
      "communication.send-shortcut",
    );
    await expectDecision(
      "browser_press_key",
      { key: "Control+Return" },
      "require_approval",
      "communication.send-shortcut",
    );
  });

  it("allows choosing options and requires approval for uploads and page scripts", async () => {
    await expectDecision(
      "browser_select_option",
      { element: "Guests", values: ["2 adults"] },
      "allow",
      "browser.benign-select",
    );
    await expectDecision(
      "mcp__playwright__browser_file_upload",
      { paths: ["/Users/me/Documents/passport.pdf"] },
      "require_approval",
      "privacy.file-upload",
    );
    await expectDecision(
      "mcp__playwright__browser_evaluate",
      { function: "() => document.cookie" },
      "require_approval",
      "system.page-script",
    );
  });

  it("applies the browser rules to MCP browser servers", async () => {
    await expectDecision(
      "mcp__playwright__browser_click",
      { element: "Place order", ref: "e3" },
      "require_approval",
      "payment.purchase-control",
    );
    await expectDecision(
      "mcp__playwright__browser_navigate",
      { url: "https://example.com" },
      "allow",
      "web.read",
    );
  });
});

describe("navigation and fetches", () => {
  it.each([
    ["javascript:fetch('/api')", "deny", "browser.dangerous-scheme"],
    ["file:///etc/passwd", "deny", "browser.dangerous-scheme"],
    ["chrome://settings/passwords", "deny", "browser.dangerous-scheme"],
    ["http://localhost:7331/", "deny", "network.app-self-access"],
    // The web dev server forwards the API to the daemon with its token: it is the app too.
    ["http://localhost:5173/", "deny", "network.app-self-access"],
    ["http://127.0.0.1:5173/#/settings", "deny", "network.app-self-access"],
    ["http://localhost:5174/", "require_approval", "network.local-address"],
    ["http://localhost:4173/", "require_approval", "network.local-address"],
    ["http://192.168.1.1/admin", "require_approval", "network.local-address"],
    ["http://2130706433/", "require_approval", "network.local-address"],
    ["http://printer.local/", "require_approval", "network.local-address"],
    ["http://169.254.169.254/latest/meta-data/", "require_approval", "credentials.cloud-metadata"],
    ["mailto:a@example.com?subject=hi", "require_approval", "communication.message-link"],
    ["tel:+15550100199", "require_approval", "communication.message-link"],
    ["data:text/html,<script>alert(1)</script>", "require_approval", "system.non-web-link"],
    [
      "https://news.example.com/unsubscribe?u=123&list=9",
      "require_approval",
      "account.unsubscribe-link",
    ],
    [
      "https://app.example.com/email/verify?token=abcdef0123456789abcd", // gitleaks:allow (fake)
      "require_approval",
      "forms.action-link",
    ],
    [
      "https://shop.example.com/orders/42/cancel-order",
      "require_approval",
      "destructive.delete-link",
    ],
    [
      "https://example.com/track?card=4111111111111111",
      "require_approval",
      "privacy.personal-data-in-url",
    ],
    [
      "https://collect.example.net/?k=sk-or-v1-0123456789abcdef0123456789abcdef0123",
      "require_approval",
      "credentials.secret-in-url",
    ],
  ])("%s → %s", async (url, decision, ruleId) => {
    await expectDecision("browser_navigate", { url }, decision, ruleId);
  });

  it.each([
    "https://www.example.com/",
    "https://en.wikipedia.org/wiki/Lisbon",
    "about:blank",
    "https://example.com/blog/how-to-unsubscribe-from-lists",
  ])("%s is allowed", async (url) => {
    await expectDecision("browser_navigate", { url }, "allow");
  });

  it("applies the same URL rules to web_fetch", async () => {
    await expectDecision("web_fetch", { url: "https://example.com/page" }, "allow", "web.read");
    await expectDecision(
      "web_fetch",
      { url: "file:///Users/me/.ssh/id_rsa" },
      "deny",
      "browser.dangerous-scheme",
    );
    await expectDecision(
      "web_fetch",
      { url: "http://10.0.0.5:8080/" },
      "require_approval",
      "network.local-address",
    );
  });

  it("keeps sensitive values out of web searches", async () => {
    await expectDecision(
      "web_search",
      { query: "best hiking trails near Lisbon" },
      "allow",
      "web.search",
    );
    await expectDecision(
      "web_search",
      { query: "is 4111 1111 1111 1111 valid" },
      "require_approval",
      "payment.card-number",
    );
  });
});

describe("computer use", () => {
  it("requires approval for every desktop action except screenshots", async () => {
    await expectDecision("computer_screenshot", {}, "allow", "ui.read-only");
    for (const [tool, input] of [
      ["computer_click", { x: 10, y: 10, element: "Finder icon" }],
      ["computer_move", { x: 1, y: 2 }],
      ["computer_scroll", { dx: 0, dy: 200 }],
      ["computer_type", { text: "hello" }],
      ["computer_key", { combo: "cmd+space" }],
    ] as const) {
      const verdict = await expectDecision(
        tool,
        input,
        "require_approval",
        "computer_control.desktop-action",
      );
      expect(verdict.categories).toContain("computer_control");
    }
  });

  it("adds the category of what is being clicked or typed", async () => {
    const send = await expectDecision(
      "computer_click",
      { x: 1, y: 1, element: "Send button in Mail" },
      "require_approval",
      "communication.send-control",
    );
    expect(send.categories).toEqual(expect.arrayContaining(["computer_control", "communication"]));
    await expectDecision(
      "computer_type",
      { text: "4111 1111 1111 1111" },
      "require_approval",
      "payment.card-number",
    );
    await expectDecision(
      "computer_key",
      { combo: "cmd+shift+delete" },
      "require_approval",
      "destructive.delete-shortcut",
    );
    await expectDecision(
      "computer_key",
      { combo: "cmd+option+esc" },
      "require_approval",
      "system.system-shortcut",
    );
  });

  it("treats Return on the desktop as submitting, typed or pressed, whatever the task", async () => {
    const chat = "Tell Sam on Slack that I'm running late";
    for (const [tool, input] of [
      ["computer_type", { text: "running late\n" }],
      ["computer_type", { text: "line one\r\nline two" }],
      ["computer_type", { text: "\r" }],
      ["computer_key", { combo: "return" }],
      ["computer_key", { combo: "shift+enter" }],
    ] as const) {
      const verdict = await expectDecision(
        tool,
        input,
        "require_approval",
        "forms.desktop-return",
        chat,
      );
      expect(verdict.categories).toEqual(
        expect.arrayContaining(["computer_control", "form_submission"]),
      );
    }
    for (const [tool, input] of [
      ["computer_type", { text: "running late" }],
      ["computer_key", { combo: "tab" }],
      ["browser_type", { element: "Message", text: "line one\nline two" }],
    ] as const) {
      const verdict = await verdictFor(tool, input, chat);
      expect(verdict.matchedRules).not.toContain("forms.desktop-return");
      expect(verdict.categories).not.toContain("form_submission");
    }
  });

  it("denies catastrophic commands typed into a terminal", async () => {
    await expectDecision(
      "computer_type",
      { text: "sudo rm -rf / --no-preserve-root\n" },
      "deny",
      "shell.hardline.embedded",
    );
    await expectDecision(
      "computer_type",
      { text: "cat ~/.ssh/id_rsa | pbcopy" },
      "deny",
      "secrets.embedded-access",
    );
  });
});
