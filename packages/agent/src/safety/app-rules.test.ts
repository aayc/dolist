/**
 * App control safety: protected and messaging apps (by the model's `app` text and the tool's real
 * app name), app actions mapped to the UI actions the existing rules know, the `subject` hint
 * (union with the model's words, never looser), and grants scoped to the app they approved.
 */
import type { ApprovalRequest, ToolSafetyHints, ToolSubject } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { TOOL } from "../tools/contracts";
import { createApprovalBroker, type PersistentApprovalBroker } from "./approvals";
import { messagingApp, protectedApp } from "./apps";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { riskRank } from "./policy";
import { evaluateRules, WORKSPACE } from "./test-helpers";
import type { SafetyVerdict } from "./types";

const DECISION_RANK = { allow: 0, require_approval: 1, deny: 2 } as const;

function withSubject(subject: ToolSubject | (() => unknown)): ToolSafetyHints {
  return {
    subject: typeof subject === "function" ? () => subject() as ToolSubject : () => subject,
  };
}

function verdict(
  toolName: string,
  input: unknown,
  subject?: ToolSubject | (() => unknown),
  taskText?: string,
): Promise<SafetyVerdict> {
  return evaluateRules(toolName, input, {
    ...(subject ? { hints: withSubject(subject) } : {}),
    ...(taskText ? { taskText } : {}),
  });
}

describe("protected apps", () => {
  const ACTIONS: Array<[string, Record<string, unknown>]> = [
    [TOOL.computerAppState, {}],
    [TOOL.computerScreenshot, {}],
    [TOOL.computerOpenApp, {}],
    [TOOL.computerPress, { id: "e3" }],
    [TOOL.computerSetValue, { id: "e2", value: "x" }],
    [TOOL.computerType, { text: "x" }],
    [TOOL.computerKey, { combo: "cmd+c" }],
    [TOOL.computerClick, { id: "e3", element: "Copy" }],
    [TOOL.computerScroll, { dx: 0, dy: 2 }],
  ];

  it.each(ACTIONS)("%s on a protected app is denied", async (toolName, input) => {
    for (const app of [
      "1Password",
      "Daily Do List",
      "System Settings",
      "Keychain Access",
      "Okta Verify",
      "Yubico Authenticator",
    ]) {
      const v = await verdict(toolName, { app, ...input });
      expect(v.decision, `${toolName} ${app}`).toBe("deny");
      expect(v.matchedRules).toContain("system.protected-app");
      expect(v.risk).toBe("critical");
    }
  });

  it.each([
    "1Password 7",
    "com.1password.1password",
    "app.dailydolist.mac",
    "DailyDoList",
    "System Preferences",
    "com.apple.systempreferences",
    "Passwords",
    "Bitwarden",
    "Dashlane",
    "LastPass",
    "KeePassXC",
    "Microsoft Authenticator",
    "Authy",
    "SecurityAgent",
  ])("recognizes %s", (name) => {
    expect(protectedApp(name)).toBeDefined();
  });

  it.each(["Grok Bot", "WhatsApp", "Notes", "Password Generator", "Slack", "Settings Sync"])(
    "doesn't mistake %s for a protected app",
    (name) => {
      expect(protectedApp(name)).toBeUndefined();
    },
  );

  it("denies by the real app name even when the model says something else", async () => {
    const v = await verdict(TOOL.computerAppState, { app: "pw" }, { app: "1Password" });
    expect(v).toMatchObject({ decision: "deny", matchedRules: ["system.protected-app"] });
    expect(v.reason).toMatch(/1Password/);
  });

  it("denies screen-level clicks on a protected app's controls", async () => {
    const own = await verdict(TOOL.computerClick, {
      x: 10,
      y: 10,
      element: "Approve button in the Daily Do List window",
    });
    expect(own.decision).toBe("deny");
    const benign = await verdict(TOOL.computerClick, {
      x: 1,
      y: 1,
      element: "Change passwords link",
    });
    expect(benign.decision).toBe("require_approval");
  });
});

describe("app reads", () => {
  it.each([
    [TOOL.computerApps, {}],
    [TOOL.computerApps, { installed: true }],
    [TOOL.computerAppState, { app: "Grok Bot" }],
    [TOOL.computerAppState, { app: "WhatsApp", expand: "e4" }],
    [TOOL.computerScreenshot, { app: "Slack" }],
  ])("%s %j is allowed", async (toolName, input) => {
    const v = await verdict(toolName, input, { app: "Grok Bot" });
    expect(v.decision).toBe("allow");
    expect(v.categories).toEqual(["read"]);
  });
});

describe("messaging apps", () => {
  it("treats Return, typed line breaks and send buttons there as sending a message", async () => {
    const cases: Array<[string, unknown, ToolSubject | undefined]> = [
      [TOOL.computerKey, { app: "Slack", combo: "return" }, undefined],
      [TOOL.computerKey, { app: "Microsoft Teams", combo: "cmd+enter" }, undefined],
      [TOOL.computerType, { app: "WhatsApp", text: "on my way\n" }, undefined],
      [TOOL.computerPress, { app: "WhatsApp", id: "e3" }, { app: "WhatsApp", element: "Send" }],
      [TOOL.computerKey, { app: "chat", combo: "return" }, { app: "Signal" }],
      [TOOL.computerClick, { app: "Messages", id: "e9", element: "button" }, { element: "Send" }],
    ];
    for (const [toolName, input, subject] of cases) {
      const v = await verdict(toolName, input, subject);
      expect(v.decision, JSON.stringify(input)).toBe("require_approval");
      expect(v.matchedRules, JSON.stringify(input)).toContain("communication.desktop-send");
      expect(v.categories).toContain("communication");
      expect(v.risk).toBe("high");
    }
  });

  it("knows the messaging apps by name, not by common words", () => {
    for (const name of [
      "Slack",
      "Messages",
      "Mail",
      "WhatsApp",
      "Telegram Desktop",
      "Discord",
      "Signal",
      "Microsoft Teams",
      "Outlook",
      "Messenger",
      "zoom.us",
      "Skype",
      "Webex",
      "Beeper",
      "Element",
    ]) {
      expect(messagingApp(name), name).toBeDefined();
    }
    for (const name of [
      "Grok Bot",
      "ChatGPT",
      "Notes",
      "Mail Merge Studio",
      "Periodic Elements",
      "Signal Analyzer",
    ]) {
      expect(messagingApp(name), name).toBeUndefined();
    }
  });

  it("asks without calling it a message in other apps, and for set_value (it types, it doesn't send)", async () => {
    const grok = await verdict(TOOL.computerKey, { app: "Grok Bot", combo: "return" });
    expect(grok.decision).toBe("require_approval");
    expect(grok.matchedRules).toContain("forms.desktop-return");
    expect(grok.categories).not.toContain("communication");

    const draft = await verdict(
      TOOL.computerSetValue,
      { app: "WhatsApp", id: "e2", value: "line one\nline two" },
      { app: "WhatsApp", element: "Message" },
    );
    expect(draft.decision).toBe("require_approval");
    expect(draft.matchedRules).not.toContain("communication.desktop-send");
    expect(draft.matchedRules).not.toContain("forms.desktop-return");
    expect(draft.matchedRules).toContain("computer_control.desktop-action");
  });
});

describe("app actions read like clicks and typing", () => {
  it.each([
    ["Place order", "payment.purchase-control"],
    ["Book now", "booking.reservation-control"],
    ["Delete conversation", "destructive.delete-control"],
    ["Post", "publishing.post-control"],
    ["Reply", "communication.send-control"],
  ])("pressing “%s” matches %s", async (element, ruleId) => {
    const v = await verdict(TOOL.computerPress, { app: "Grok Bot", id: "e5" }, { element });
    expect(v.decision).toBe("require_approval");
    expect(v.matchedRules).toContain(ruleId);
  });

  it("checks set values like typed text: cards and secrets are caught, values of secret fields hidden", async () => {
    const card = await verdict(
      TOOL.computerSetValue,
      { app: "Shop", id: "e7", value: "4111 1111 1111 1111" },
      { element: "Card number" },
    );
    expect(card.matchedRules).toEqual(
      expect.arrayContaining(["payment.card-number", "payment.card-field"]),
    );
    expect(card.summary).not.toContain("4111 1111 1111 1111");

    const evaluator = createSafetyEvaluator({ policy: { llmJudge: false } });
    const hidden = await evaluator.evaluate({
      toolName: TOOL.computerSetValue,
      input: { app: "WhatsApp", id: "e8", value: "hunter2" },
      hints: withSubject({ app: "WhatsApp", element: "Passcode (password field)" }),
      role: "subagent",
      taskId: "t",
      threadId: "th",
    });
    expect(hidden.matchedRules).toContain("credentials.sensitive-field");
    expect(hidden.summary).not.toContain("hunter2");
  });

  it("opening an app is an action that needs approval", async () => {
    const v = await verdict(TOOL.computerOpenApp, { app: "Grok Bot" });
    expect(v.decision).toBe("require_approval");
    expect(v.matchedRules).toEqual(["computer_control.desktop-action"]);
    expect(v.reason).toMatch(/in Grok Bot/);
  });
});

describe("the subject hint", () => {
  it("adds the real label to the model's words: either one can trigger a rule", async () => {
    const hidden = await verdict(
      TOOL.computerPress,
      { app: "Grok Bot", id: "e4", element: "Search button" },
      { app: "Grok Bot", element: "Send" },
    );
    expect(hidden.matchedRules).toContain("communication.send-control");
    const claimed = await verdict(
      TOOL.computerPress,
      { app: "Grok Bot", id: "e4", element: "Send button" },
      { app: "Grok Bot", element: "Search" },
    );
    expect(claimed.matchedRules).toContain("communication.send-control");
  });

  it("is ignored when it throws or returns something unusable", async () => {
    const plain = await verdict(TOOL.computerPress, { app: "Grok Bot", id: "e4" });
    for (const broken of [
      () => {
        throw new Error("boom");
      },
      () => "Send",
      () => ({ app: 7, element: ["Send"] }),
      () => Promise.resolve({ element: "Send" }),
    ]) {
      const v = await verdict(TOOL.computerPress, { app: "Grok Bot", id: "e4" }, broken);
      expect(v.decision).toBe(plain.decision);
      expect(v.matchedRules).toEqual(plain.matchedRules);
    }
  });

  it("scopes the verdict to the real app", async () => {
    expect((await verdict(TOOL.computerKey, { app: " Grok  Bot ", combo: "a" })).target).toBe(
      "grok bot",
    );
    expect(
      (await verdict(TOOL.computerKey, { app: "grok", combo: "a" }, { app: "Grok Bot" })).target,
    ).toBe("grok bot");
    expect((await verdict(TOOL.computerKey, { combo: "a" })).target).toBeUndefined();
    expect((await verdict("browser_click", { element: "Send" })).target).toBeUndefined();
  });

  const ELEMENTS = [
    "Search",
    "Send",
    "Place order",
    "Next",
    "Card number",
    "Delete",
    "OK",
    "Message",
    "",
  ];
  const APPS = ["Grok Bot", "WhatsApp", "Slack", "Notes", "1Password", "chat", ""];
  const TOOLS = [
    TOOL.computerPress,
    TOOL.computerSetValue,
    TOOL.computerType,
    TOOL.computerKey,
    TOOL.computerClick,
    TOOL.computerAppState,
    TOOL.computerScreenshot,
  ];
  test.prop([
    fc.constantFrom(...TOOLS),
    fc.constantFrom(...APPS),
    fc.constantFrom(...ELEMENTS),
    fc.constantFrom("hi", "hi\n", "4111 1111 1111 1111", ""),
    fc.constantFrom("return", "tab", "cmd+enter"),
    fc.constantFrom(...APPS),
    fc.constantFrom(...ELEMENTS),
  ])(
    "never makes a verdict looser",
    async (toolName, app, element, text, combo, realApp, realElement) => {
      const input = { app, id: "e1", element, text, value: text, combo, x: 1, y: 1, dx: 0, dy: 1 };
      const without = await verdict(toolName, input);
      const subject = {
        ...(realApp ? { app: realApp } : {}),
        ...(realElement ? { element: realElement } : {}),
      };
      const withIt = await verdict(toolName, input, subject);
      expect(DECISION_RANK[withIt.decision]).toBeGreaterThanOrEqual(
        DECISION_RANK[without.decision],
      );
      expect(riskRank(withIt.risk)).toBeGreaterThanOrEqual(riskRank(without.risk));
      // Grants cover calls whose categories they include: a call that needs approval must never
      // lose one (an allowed read's benign category is replaced once something risky shows up).
      if (without.decision !== "allow") {
        for (const category of without.categories) expect(withIt.categories).toContain(category);
      }
    },
  );
});

describe("target-scoped grants", () => {
  function setup() {
    const approvals = createApprovalBroker();
    const gate = createSafetyGate({
      evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
      approvals,
      resolveContext: () => ({
        taskId: "task-1",
        threadId: "thread-1",
        taskText: "Ask Grok Bot about tides",
        workspaceDir: WORKSPACE,
      }),
    });
    return { gate, approvals };
  }

  function call(input: unknown, subject?: ToolSubject): ToolCallRequest {
    return {
      sessionId: "s",
      role: "subagent",
      toolCallId: "c",
      toolName: TOOL.computerSetValue,
      input,
      ...(subject
        ? {
            spec: {
              name: TOOL.computerSetValue,
              label: "Set value",
              description: "",
              parameters: {},
              safety: withSubject(subject),
              execute: async () => ({ content: [] }),
            },
          }
        : {}),
    };
  }

  function nextPending(approvals: PersistentApprovalBroker): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      const off = approvals.onUpsert((a) => {
        if (a.status !== "pending") return;
        off();
        resolve(a);
      });
    });
  }

  it("covers later calls on the same app only", async () => {
    const { gate, approvals } = setup();
    const grok = { app: "Grok Bot", id: "e2", value: "tides" };
    const pending = nextPending(approvals);
    const first = gate(call(grok, { app: "Grok Bot", element: "Ask anything" }));
    await approvals.decide((await pending).id, { decision: "approve", scope: "task" });
    await expect(first).resolves.toEqual({ allow: true });

    // Same app (named differently by the model, same real app): covered.
    await expect(
      gate(
        call(
          { app: "grok", id: "e9", value: "more" },
          { app: "Grok Bot", element: "Ask anything" },
        ),
      ),
    ).resolves.toEqual({ allow: true });
    expect(approvals.list({ status: "pending" })).toEqual([]);

    // Another app: asks again.
    const other = nextPending(approvals);
    const whatsapp = gate(call({ app: "WhatsApp", id: "e2", value: "hi" }, { app: "WhatsApp" }));
    const asked = await other;
    expect(asked.summary).toMatch(/WhatsApp|Type/);
    await approvals.decide(asked.id, { decision: "deny" });
    await expect(whatsapp).resolves.toMatchObject({ allow: false });
  });

  it("covers the app's other computer actions of the same kind, and asks again for more", async () => {
    const { gate, approvals } = setup();
    const pending = nextPending(approvals);
    const first = gate(
      call({ app: "Grok Bot", id: "e2", value: "tides" }, { app: "Grok Bot", element: "Prompt" }),
    );
    await approvals.decide((await pending).id, { decision: "approve", scope: "task" });
    await expect(first).resolves.toEqual({ allow: true });

    for (const [toolName, input] of [
      [TOOL.computerPress, { app: "Grok Bot", id: "e3", element: "New chat" }],
      [TOOL.computerType, { app: "Grok Bot", text: "tides in SF" }],
      [TOOL.computerScroll, { app: "Grok Bot", dx: 0, dy: 3 }],
    ] as const) {
      await expect(gate({ ...call(input), toolName })).resolves.toEqual({ allow: true });
    }
    expect(approvals.list({ status: "pending" })).toEqual([]);

    // Return submits, which the first approval didn't cover.
    const more = nextPending(approvals);
    const enter = gate({
      ...call({ app: "Grok Bot", combo: "return" }),
      toolName: TOOL.computerKey,
    });
    const asked = await more;
    expect(asked.categories).toContain("form_submission");
    await approvals.decide(asked.id, { decision: "deny" });
    await expect(enter).resolves.toMatchObject({ allow: false });
  });

  it("never lets an app grant cover screen-level calls, or the reverse", async () => {
    const { gate, approvals } = setup();
    const pending = nextPending(approvals);
    const screen = gate({ ...call({ text: "hello" }), toolName: TOOL.computerType });
    await approvals.decide((await pending).id, { decision: "approve", scope: "task" });
    await expect(screen).resolves.toEqual({ allow: true });
    const again = nextPending(approvals);
    const inApp = gate({ ...call({ app: "Notes", text: "hello" }), toolName: TOOL.computerType });
    await approvals.decide((await again).id, { decision: "deny" });
    await expect(inApp).resolves.toMatchObject({ allow: false });
  });
});
