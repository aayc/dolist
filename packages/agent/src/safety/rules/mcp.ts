/**
 * Heuristics for MCP connector tools (`mcp__<server>__<tool>`), whose behavior we only know from
 * their names, arguments and (untrusted) annotations: verbs in the tool name map to categories
 * (send → communication, create_event → booking, pay → payment, delete → destructive, …),
 * recipients and amounts in the arguments add categories, and read verbs are allowed.
 */
import type { ActionCategory } from "@ddl/core";
import { type ActionFacts, toolWords } from "../facts";
import { info, quote, type RuleHit, type SafetyRuleInfo } from "./types";

const MCP_CATEGORY_RULES = {
  payment: info(
    "mcp.payment-action",
    "payment",
    "require_approval",
    "high",
    "Connector tool that moves money (pay, charge, buy, refund, transfer)",
  ),
  booking: info(
    "mcp.booking-action",
    "booking",
    "require_approval",
    "high",
    "Connector tool that books, schedules or changes calendar events",
  ),
  communication: info(
    "mcp.communication-action",
    "communication",
    "require_approval",
    "high",
    "Connector tool that sends messages, emails, invites or comments",
  ),
  publishing: info(
    "mcp.publishing-action",
    "publishing",
    "require_approval",
    "high",
    "Connector tool that posts, publishes or changes shared content",
  ),
  account: info(
    "mcp.account-action",
    "account",
    "require_approval",
    "high",
    "Connector tool that changes accounts, members or permissions",
  ),
  destructive: info(
    "mcp.destructive-action",
    "destructive",
    "require_approval",
    "high",
    "Connector tool that deletes, cancels or resets data",
  ),
  system: info(
    "mcp.system-action",
    "system",
    "require_approval",
    "high",
    "Connector tool that runs commands or installs software",
  ),
} as const satisfies Partial<Record<ActionCategory, SafetyRuleInfo>>;

type McpCategory = keyof typeof MCP_CATEGORY_RULES;

export const MCP_DRAFT = info(
  "mcp.draft",
  "file_write",
  "allow",
  "low",
  "Connector tool that only saves a draft",
);
export const MCP_READ = info(
  "mcp.read-action",
  "read",
  "allow",
  "low",
  "Connector tool that only reads (get, list, search, …)",
);
export const MCP_RULES: readonly SafetyRuleInfo[] = [
  ...Object.values(MCP_CATEGORY_RULES),
  MCP_DRAFT,
  MCP_READ,
];

const VERBS: Readonly<Record<McpCategory, ReadonlySet<string>>> = {
  communication: new Set([
    "send",
    "reply",
    "forward",
    "notify",
    "sms",
    "dm",
    "call",
    "comment",
    "mention",
    "invite",
    "broadcast",
    "email",
    "message",
    "text",
    "ping",
  ]),
  publishing: new Set([
    "post",
    "publish",
    "tweet",
    "retweet",
    "repost",
    "share",
    "upload",
    "release",
    "deploy",
    "merge",
    "push",
    "commit",
    "fork",
    "star",
    "like",
    "follow",
    "react",
    "vote",
    "upvote",
  ]),
  booking: new Set(["book", "reserve", "schedule", "rsvp", "reschedule", "checkin"]),
  payment: new Set([
    "pay",
    "charge",
    "purchase",
    "buy",
    "checkout",
    "refund",
    "transfer",
    "payout",
    "withdraw",
    "deposit",
    "donate",
    "tip",
    "subscribe",
    "trade",
    "sell",
    "order",
    "invoice",
    "bid",
  ]),
  destructive: new Set([
    "delete",
    "remove",
    "destroy",
    "drop",
    "purge",
    "erase",
    "wipe",
    "trash",
    "truncate",
    "clear",
    "reset",
    "revoke",
    "kill",
    "terminate",
    "uninstall",
    "cancel",
    "unsubscribe",
    "unpublish",
  ]),
  system: new Set([
    "execute",
    "exec",
    "run",
    "eval",
    "evaluate",
    "shell",
    "spawn",
    "install",
    "restart",
    "reboot",
    "shutdown",
    "sudo",
    "command",
    "script",
    "apply",
    "provision",
  ]),
  account: new Set([
    "register",
    "signup",
    "grant",
    "authorize",
    "approve",
    "enable",
    "disable",
    "login",
    "logout",
    "verify",
    "impersonate",
    "promote",
    "demote",
  ]),
};

const READ_VERBS: ReadonlySet<string> = new Set([
  "get",
  "list",
  "search",
  "read",
  "find",
  "fetch",
  "query",
  "lookup",
  "describe",
  "show",
  "view",
  "retrieve",
  "count",
  "check",
  "download",
  "export",
  "summarize",
  "browse",
  "inspect",
  "status",
  "info",
  "stats",
  "history",
  "preview",
  "resolve",
  "validate",
  "analyze",
  "extract",
  "parse",
  "scan",
  "poll",
  "wait",
  "whoami",
  "me",
  "current",
  "recent",
  "suggest",
  "recommend",
  "translate",
  "convert",
  "calculate",
  "compute",
  "format",
  "render",
  "health",
  "diff",
  "compare",
  "estimate",
  "quote",
]);
const DRAFT_WORDS: ReadonlySet<string> = new Set(["draft", "drafts", "compose"]);
/** Verbs that change something; the object noun decides the category (`create_event` → booking). */
const CREATE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "add",
  "new",
  "insert",
  "update",
  "edit",
  "modify",
  "patch",
  "set",
  "put",
  "write",
  "save",
  "upsert",
  "append",
  "replace",
  "import",
  "copy",
  "rename",
  "assign",
  "close",
  "reopen",
  "respond",
  "accept",
  "decline",
  "change",
  "configure",
  "store",
  "attach",
  "place",
  "submit",
]);
/** Verbs that reorganize without an obvious category (archive, label, …): effectful but uncertain. */
const ORGANIZE_VERBS: ReadonlySet<string> = new Set([
  "move",
  "mark",
  "label",
  "tag",
  "archive",
  "pin",
  "unpin",
  "snooze",
  "mute",
  "unmute",
  "flag",
]);
/** Words that are nouns after a read verb (`get_order`, `list_post_comments`), verbs otherwise. */
const NOUNABLE: ReadonlySet<string> = new Set([
  "order",
  "invoice",
  "charge",
  "transfer",
  "post",
  "comment",
  "share",
  "release",
  "commit",
  "push",
  "tweet",
  "star",
  "like",
  "message",
  "email",
  "text",
  "book",
  "schedule",
  "invite",
  "call",
  "bid",
  "tip",
  "trade",
  "refund",
  "checkout",
  "script",
  "command",
  "run",
  "apply",
  "deposit",
  "reply",
  "merge",
  "fork",
  "follow",
  "vote",
  "upload",
  "deploy",
  "react",
  "sms",
  "dm",
  "mention",
  "ping",
  "subscribe",
  "sell",
  "payout",
  "verify",
  "login",
  "enable",
  "disable",
  "install",
  "status",
]);

const OBJECTS: ReadonlyArray<readonly [McpCategory, RegExp]> = [
  [
    "booking",
    /^(?:events?|meetings?|appointments?|reservations?|bookings?|calendars?|invitations?|invites?|rsvps?|slots?)$/,
  ],
  [
    "communication",
    /^(?:emails?|mails?|messages?|sms|texts?|chats?|dms?|replies|reply|comments?|notifications?|conversations?|threads?)$/,
  ],
  [
    "payment",
    /^(?:payments?|charges?|invoices?|orders?|subscriptions?|refunds?|transfers?|payouts?|prices?|coupons?|checkouts?)$/,
  ],
  [
    "publishing",
    /^(?:issues?|pr|prs|pull|pages?|docs?|documents?|posts?|articles?|repos?|repositor(?:y|ies)|gists?|releases?|wikis?|reviews?|tweets?|stories|story|videos?|listings?)$/,
  ],
  [
    "account",
    /^(?:users?|members?|collaborators?|permissions?|roles?|access|accounts?|passwords?|tokens?|keys?|webhooks?|secrets?|oauth|apikeys?|teams?|groups?|admins?)$/,
  ],
];

const SERVER_CATEGORIES: ReadonlyArray<readonly [McpCategory, RegExp]> = [
  [
    "payment",
    /stripe|paypal|square|venmo|wise|coinbase|plaid|braintree|adyen|revolut|cash-?app|robinhood|alpaca|kraken|binance|bank/,
  ],
  [
    "communication",
    /gmail|outlook|e-?mail|mail|slack|discord|telegram|whatsapp|signal|sms|twilio|teams|imessage|messages|intercom|zendesk|sendgrid|mailgun|postmark|resend/,
  ],
  ["booking", /calendar|gcal|calendly|opentable|resy|booking|airbnb|expedia|uber|lyft|zocdoc/],
  [
    "publishing",
    /twitter|^x$|bluesky|mastodon|linkedin|reddit|facebook|instagram|threads|youtube|tiktok|medium|wordpress|ghost|substack|buffer/,
  ],
];

const RECIPIENT_KEYS_RE =
  /^(?:to|cc|bcc|recipients?|attendees?|participants?|invitees?|emails?|phone(?:_?number)?|channel(?:_?id)?|chat_?id|user_?ids?|guests?)$/i;
const AMOUNT_KEYS_RE = /^(?:amount|price|total|amount_?cents|unit_?amount|value_?cents)$/i;

function recipients(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, value] of Object.entries(input)) {
    if (!RECIPIENT_KEYS_RE.test(key)) continue;
    const list = (Array.isArray(value) ? value : [value])
      .map((v) =>
        typeof v === "string"
          ? v
          : v && typeof v === "object"
            ? ((v as Record<string, unknown>).email ?? (v as Record<string, unknown>).name)
            : undefined,
      )
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (list.length > 0) return list.slice(0, 3).join(", ");
  }
  return undefined;
}

function amount(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, value] of Object.entries(input)) {
    if (
      AMOUNT_KEYS_RE.test(key) &&
      (typeof value === "number" || (typeof value === "string" && /\d/.test(value)))
    ) {
      return `${key} ${value}${typeof input.currency === "string" ? ` ${input.currency}` : ""}`;
    }
  }
  return undefined;
}

const CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "then", "or", "plus", "also"]);

/** `read_and_reply` → [[read], [reply]]: each clause starts with its own verb. */
function clauses(words: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const w of words) {
    if (CONJUNCTIONS.has(w)) out.push([]);
    else out.at(-1)!.push(w);
  }
  return out.filter((clause) => clause.length > 0);
}

export interface McpAnalysis {
  hits: RuleHit[];
  benign?: RuleHit;
  /** The tool changes something but its category could not be determined. */
  effectful: boolean;
  /** Only reads (or only drafts). */
  readOnly: boolean;
}

export function mcpAnalysis(facts: ActionFacts): McpAnalysis {
  const mcp = facts.mcp;
  if (!mcp) return { hits: [], effectful: false, readOnly: false };
  // Tool names often repeat the server (`github_push_files` on server `github`).
  const serverWords = toolWords(mcp.server);
  let words = mcp.words;
  while (words.length > 1 && serverWords.includes(words[0]!)) words = words.slice(1);
  const tool = quote(`${mcp.server}.${mcp.tool}`);
  const categories = new Map<McpCategory, string>();
  const add = (category: McpCategory, evidence: string) => {
    if (!categories.has(category)) categories.set(category, evidence);
  };

  // A noun-able word is a verb when it leads its clause (`message_user`, `read_and_reply`) or no
  // read verb leads the clause.
  const verbs = clauses(words).flatMap((clause) => {
    const readFirst = READ_VERBS.has(clause[0] ?? "");
    return clause.filter((w, i) => !(NOUNABLE.has(w) && (readFirst || (i > 0 && w !== "post"))));
  });
  const sends = verbs.some((w) => VERBS.communication.has(w));
  const drafting =
    words.some((w) => DRAFT_WORDS.has(w)) &&
    !words.some((w) => /^(?:send|post|publish|share|reply|forward)$/.test(w));

  for (const [category, set] of Object.entries(VERBS) as Array<
    [McpCategory, ReadonlySet<string>]
  >) {
    if (verbs.some((w) => set.has(w))) add(category, tool);
  }
  if (drafting) {
    categories.delete("communication");
    categories.delete("publishing");
  }
  // "post" into a chat/channel sends a message rather than publishing.
  if (words.includes("post") && words.some((w) => /^(?:messages?|chat|channel|dm)$/.test(w))) {
    categories.delete("publishing");
    add("communication", tool);
  }

  const creates = words.some((w) => CREATE_VERBS.has(w));
  if (creates && !drafting) {
    for (const [category, re] of OBJECTS) if (words.some((w) => re.test(w))) add(category, tool);
    if (words.includes("file") && /github|gitlab|bitbucket/.test(mcp.server))
      add("publishing", tool);
  }
  const organizes = words.some((w) => ORGANIZE_VERBS.has(w));
  const readVerb = words.some((w) => READ_VERBS.has(w));
  const effectful =
    categories.size > 0 || creates || organizes || sends || (!readVerb && !drafting);

  if (effectful && !drafting) {
    const who = recipients(facts.input);
    if (who) add("communication", `${tool} to ${who}`);
    const money = amount(facts.input);
    if (money) add("payment", `${tool} (${money})`);
    const server = mcp.server.toLowerCase();
    for (const [category, re] of SERVER_CATEGORIES)
      if (re.test(server) && (categories.size === 0 || category === "payment")) add(category, tool);
  }

  const hits: RuleHit[] = [...categories].map(([category, evidence]) => ({
    rule: MCP_CATEGORY_RULES[category],
    evidence,
  }));
  if (hits.length > 0) return { hits, effectful: true, readOnly: false };
  if (drafting)
    return { hits, benign: { rule: MCP_DRAFT, evidence: tool }, effectful: false, readOnly: true };
  if (readVerb && !creates && !organizes)
    return { hits, benign: { rule: MCP_READ, evidence: tool }, effectful: false, readOnly: true };
  return { hits, effectful, readOnly: false };
}
