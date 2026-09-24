import type { ActionCategory } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { runs } from "./test-arbitraries";
import { evaluateRules } from "./test-helpers";

const mcp = (tool: string, input: unknown = {}, readOnly?: boolean) =>
  evaluateRules(`mcp__${tool}`, input, readOnly === undefined ? {} : { hints: { readOnly } });

/** Connector tools that act on the world: approval, with the category the name implies. */
const EFFECTFUL: Array<[string, ActionCategory]> = [
  ["gmail__send_email", "communication"],
  ["gmail__SendEmail", "communication"],
  ["gmail__send-email", "communication"],
  ["gmail__SEND_EMAIL", "communication"],
  ["gmail__sendEmail", "communication"],
  ["gmail__send.email", "communication"],
  ["gmail__messages.send", "communication"],
  ["gmail__email_send", "communication"],
  ["gmail__reply_to_thread", "communication"],
  ["gmail__forward_message", "communication"],
  ["gmail__send_draft", "communication"],
  ["slack__post_message", "communication"],
  ["slack__chat_postMessage", "communication"],
  ["team__invite_member", "communication"],
  ["gcal__create_event", "booking"],
  ["gcal__CreateEvent", "booking"],
  ["gcal__events_insert", "booking"],
  ["gcal__update_event", "booking"],
  ["gcal__rsvp", "booking"],
  ["trips__book_flight", "booking"],
  ["resy__reserve_table", "booking"],
  ["stripe__create_payment_intent", "payment"],
  ["stripe__frobnicate", "payment"],
  ["shop__pay", "payment"],
  ["shop__place_order", "payment"],
  ["shop__buy", "payment"],
  ["shop__refund_charge", "payment"],
  ["bank__transfer_funds", "payment"],
  ["github__create_issue", "publishing"],
  ["github__merge_pull_request", "publishing"],
  ["github__push_files", "publishing"],
  ["drive__share_file", "publishing"],
  ["social__publish_post", "publishing"],
  ["drive__add_permission", "account"],
  ["admin__grant_access", "account"],
  ["fs__delete_file", "destructive"],
  ["gcal__delete_event", "destructive"],
  ["shop__cancel_order", "destructive"],
  ["db__drop_table", "destructive"],
  ["shell__run_command", "system"],
  ["sandbox__execute", "system"],
  // A read verb followed by a conjunction starts a new clause with its own verb.
  ["gmail__read_and_reply", "communication"],
  ["trips__search_and_book", "booking"],
  ["fs__get_and_delete", "destructive"],
  ["mail__list_then_send", "communication"],
];

describe("effectful connector tools need approval", () => {
  test.each(EFFECTFUL)("%s → %s", async (tool, category) => {
    const verdict = await mcp(tool);
    expect(verdict.decision, `${tool} → ${verdict.reason}`).toBe("require_approval");
    expect(verdict.categories, tool).toContain(category);
  });

  test.each(EFFECTFUL)("a readOnly annotation does not hide the verb: %s", async (tool) => {
    expect((await mcp(tool, {}, true)).decision).toBe("require_approval");
  });
});

const READS = [
  "gcal__list_events",
  "gcal__get_event",
  "gcal__search_events",
  "gmail__list_messages",
  "gmail__get_thread",
  "gmail__search_email",
  "github__get_file_contents",
  "github__search_code",
  "github__list_pull_requests",
  "slack__conversations_history",
  "fs__read_file",
  "fs__list_directory",
  "shop__get_order",
  "shop__list_orders",
  "notes__find_notes",
  "weather__lookup_forecast",
  "maps__estimate_travel_time",
  "team__list_invites",
];

describe("read-only connector tools are allowed", () => {
  test.each(READS)("%s", async (tool) => {
    const verdict = await mcp(tool);
    expect(verdict.decision, `${tool} → ${verdict.reason}`).toBe("allow");
  });

  test.each([
    ["gmail__create_draft", { to: "sam@example.com", subject: "Hi" }],
    ["gmail__drafts_create", { body: "hi" }],
  ])("saving a draft is allowed: %s", async (tool, input) => {
    expect((await mcp(tool, input)).decision).toBe("allow");
  });
});

describe("arguments add categories", () => {
  test.each([
    [{ to: "sam@example.com" }, "communication"],
    [{ recipients: ["a@example.com", "b@example.com"] }, "communication"],
    [{ attendees: [{ email: "a@example.com" }] }, "communication"],
    [{ amount: 100 }, "payment"],
    [{ price: "19.99", currency: "USD" }, "payment"],
    [{ note: "4111 1111 1111 1111" }, "payment"],
    [{ sql: "DROP TABLE users" }, "destructive"],
    [{ url: "http://127.0.0.1:7331/api/approvals" }, "system"],
  ] as Array<[Record<string, unknown>, ActionCategory]>)("%o → %s", async (input, category) => {
    const verdict = await mcp("widgets__do_thing", input);
    expect(verdict.decision).not.toBe("allow");
    expect(verdict.categories).toContain(category);
  });

  test("a card number in a read tool's arguments still needs approval", async () => {
    const verdict = await mcp("fs__read_file", { path: "notes.md", note: "4111-1111-1111-1111" });
    expect(verdict.decision).toBe("require_approval");
  });
});

describe("connector browser tools are judged like the built-in browser", () => {
  test.each([
    ["playwright__browser_click", { element: "Place order" }, "require_approval"],
    ["playwright__browser_click", { element: "Jetzt kaufen" }, "require_approval"],
    ["playwright__browser_type", { element: "Password", text: "hunter22" }, "require_approval"],
    ["playwright__browser_navigate", { url: "java\tscript:alert(1)" }, "deny"],
    ["playwright__browser_navigate", { url: "127.0.0.1:7331" }, "deny"],
    ["playwright__browser_click", { element: "Next page" }, "allow"],
  ])("%s %o → %s", async (tool, input, decision) => {
    expect((await mcp(tool, input)).decision).toBe(decision);
  });
});

// ── Properties ────────────────────────────────────────────────────────────────

const RISKY_VERBS = [
  "send",
  "reply",
  "forward",
  "post",
  "publish",
  "share",
  "invite",
  "book",
  "reserve",
  "schedule",
  "pay",
  "charge",
  "purchase",
  "buy",
  "refund",
  "transfer",
  "delete",
  "remove",
  "cancel",
  "drop",
  "wipe",
  "purge",
  "execute",
];
const NOUNS = [
  "email",
  "message",
  "event",
  "invoice",
  "order",
  "file",
  "user",
  "document",
  "comment",
  "issue",
  "item",
  "record",
  "thing",
];
const READ_VERBS = ["get", "list", "search", "read", "find", "fetch", "query", "lookup", "view"];
const READ_NOUNS = [
  "messages",
  "events",
  "orders",
  "email",
  "message",
  "post",
  "comment",
  "status",
  "history",
  "files",
  "calendar",
  "invite",
];

function styled(words: string[], style: number): string {
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  switch (style % 6) {
    case 0:
      return words.join("_");
    case 1:
      return words.join("-");
    case 2:
      return words.map((w, i) => (i === 0 ? w : cap(w))).join("");
    case 3:
      return words.map(cap).join("");
    case 4:
      return words.join("_").toUpperCase();
    default:
      return words.join(".");
  }
}

const server = fc.constantFrom("widgets", "acme", "tools", "my-server", "srv2");

describe("MCP name heuristics hold across spellings", () => {
  test.prop([server, fc.constantFrom(...RISKY_VERBS), fc.constantFrom(...NOUNS), fc.nat()], {
    numRuns: runs(3),
  })("a leading risky verb is never allowed", async (srv, verb, noun, style) => {
    const tool = `${srv}__${styled([verb, noun], style)}`;
    const verdict = await mcp(tool, {}, true);
    expect(verdict.decision, tool).not.toBe("allow");
  });

  test.prop([
    server,
    fc.constantFrom(...READ_VERBS),
    fc.constantFrom(...READ_NOUNS),
    fc.constantFrom(...RISKY_VERBS),
    fc.constantFrom("and", "then"),
    fc.nat(),
  ])(
    "a risky verb after `and`/`then` is never hidden by a leading read verb",
    async (srv, read, noun, verb, conj, style) => {
      const tool = `${srv}__${styled([read, noun, conj, verb], style)}`;
      const verdict = await mcp(tool);
      expect(verdict.decision, tool).not.toBe("allow");
    },
  );

  test.prop([server, fc.constantFrom(...READ_VERBS), fc.constantFrom(...READ_NOUNS), fc.nat()])(
    "a read verb with a noun is allowed",
    async (srv, verb, noun, style) => {
      const tool = `${srv}__${styled([verb, noun], style)}`;
      const verdict = await mcp(tool);
      expect(verdict.decision, `${tool} → ${verdict.reason}`).toBe("allow");
    },
  );

  test.prop([fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 })])(
    "an unrecognized connector tool without hints is never allowed silently",
    async (srv, tool) => {
      const name = `${srv}__${tool}`;
      const verdict = await mcp(name, { x: 1 });
      if (verdict.decision === "allow")
        expect(
          verdict.matchedRules?.some((r) => r === "mcp.read-action" || r === "mcp.draft"),
        ).toBe(true);
    },
  );
});
