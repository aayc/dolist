/**
 * Deterministic task understanding for the fake orchestrator and subagents: the four triage
 * outcomes of the orchestrator prompt (delegate, answer, ask, ignore), the minimal capabilities for
 * delegated work, the irreversible verb of a task, and offline answers to simple questions.
 * Keyword rules, tuned against `evals/datasets/triage.jsonl`.
 */
import type { Capability } from "../../execution/types";
import { riskyVerb } from "../../tools/mock";
import { excerpt, wordCount } from "./text";

export type TriageDecision =
  | { kind: "ignore"; reason: "deferred" | "harmful" | "chore" }
  | { kind: "ask"; question: string }
  | { kind: "answer"; answer?: string; summary?: string }
  | { kind: "delegate"; capabilities: Capability[] };

export interface TriageInput {
  text: string;
  notes?: readonly string[];
  /** Today's local ISO date (for deferral links). */
  today?: string;
  /** The Mac's apps the computer capability can operate (from the digest). */
  desktopApps?: readonly string[];
}

const DAILY_LINK = /\[\[(?:[^\]|#]*\/)?(\d{4}-\d{2}-\d{2})(?:[|#][^\]]*)?\]\]/g;
const HARMFUL =
  /\b(hack into|steal|phish|stalk|dox|make a bomb|build a bomb|poison|launder|counterfeit|ddos|ransomware|malware|break into)\b/i;
const PHYSICAL =
  /\b(gym|work ?out|yoga|go for a run|walk the dog|laundry|dishes|vacuum|meditate|water the plants|pick up|drop off|dry cleaning|groceries|take out the trash|mow the lawn|notice|grateful|gratitude|journal|stretch|nap)\b|\bappointment at \d|^call\b/i;
const ONLINE = /\b(membership|online|subscription|website|app|order|renew)\b/i;
const VAGUE = /\b(it|the thing|that|this|him|her|them|the issue|stuff|something)\b/i;
const QUESTION_START =
  /^(what|what's|whats|how|when|which|who|where|why|is|are|does|do|calculate|convert|define|speed of|capital of)\b/i;
const RESEARCHY = /\b(best|compare|research|plan|recommend|reviews?|top \d+|options)\b/i;
const REQUEST_AS_QUESTION = /^(can|could|would|will) you\b/i;

const COMMUNICATION =
  /\b(email|e-mail|reply to|respond to|recruiter|1:1|one-on-one|meeting|calendar|invite|send|text|slack|message)\b/i;
const TRANSACTION =
  /\b(book|reserve|order|buy|purchase|pay|cancel|renew|appointment|subscription|registration|sign up|register|checkout|rsvp)\b/i;
const CODE =
  /\b(repo|repository|tests?|script|code|bug|debug|compile|deploy|git|python|javascript|typescript|program)\b/i;
const DOCUMENTS =
  /\b(csv|spreadsheet|resume|file|document|doc|draft|blog post|letter|essay|outline|report|slides|presentation)\b/i;
const RESEARCH =
  /\b(research|compare|find|look into|look up|search|best|prices?|reviews?|options|recommend|ideas|plan|trip|summarize|learn|which|quote)\b|https?:\/\//i;

/** Triage outcome for one task, following the orchestrator prompt's four outcomes. */
export function triage(input: TriageInput): TriageDecision {
  const raw = input.text.trim();
  const deferred = deferredDate(raw);
  if (deferred && input.today && deferred > input.today)
    return { kind: "ignore", reason: "deferred" };
  const text = raw.replace(DAILY_LINK, "").trim();
  if (HARMFUL.test(text)) return { kind: "ignore", reason: "harmful" };
  const desktopApps = input.desktopApps ?? [];
  // "Ask Grok Bot…?" is work for Grok Bot, not a question to answer here.
  if (namedDesktopApp(text, desktopApps)) {
    return {
      kind: "delegate",
      capabilities: desiredCapabilities(text, input.notes ?? [], desktopApps),
    };
  }
  if (PHYSICAL.test(text) && !ONLINE.test(text)) return { kind: "ignore", reason: "chore" };
  if (isVague(text)) return { kind: "ask", question: clarifyingQuestion(text) };
  if (isQuickQuestion(text)) {
    const known = quickAnswer(text);
    return known
      ? { kind: "answer", answer: known.answer, summary: known.summary }
      : { kind: "answer" };
  }
  return { kind: "delegate", capabilities: desiredCapabilities(text, input.notes ?? []) };
}

function deferredDate(text: string): string | undefined {
  let latest: string | undefined;
  for (const match of text.matchAll(DAILY_LINK)) {
    if (!latest || match[1]! > latest) latest = match[1]!;
  }
  return latest;
}

function isVague(text: string): boolean {
  const words = wordCount(text);
  if (words === 0) return false;
  if (/https?:\/\//i.test(text)) return false;
  return words <= 5 && VAGUE.test(text);
}

function clarifyingQuestion(text: string): string {
  const t = text.toLowerCase();
  if (/\b(him|her|them)\b/.test(t)) return "Who do you mean, and what should I tell them?";
  if (/\b(book|order|buy|reserve)\b/.test(t))
    return "What exactly should I book or order, and for when?";
  if (/\bissue\b/.test(t)) return "Which issue do you mean? A link or a few details would help.";
  return `What exactly do you mean by “${excerpt(text, 60)}”?`;
}

function isQuickQuestion(text: string): boolean {
  if (REQUEST_AS_QUESTION.test(text)) return false;
  const question = text.endsWith("?") || QUESTION_START.test(text);
  return question && !RESEARCHY.test(text) && wordCount(text) <= 16;
}

/** A desktop app the task names ("ask Grok Bot…", "on WhatsApp"), if any. */
export function namedDesktopApp(text: string, apps: readonly string[]): string | undefined {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return apps.find((app) => {
    const name = app
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return name.length > 1 && lower.includes(` ${name} `);
  });
}

/** The minimal capabilities for a delegated task, before filtering by availability. */
export function desiredCapabilities(
  text: string,
  notes: readonly string[] = [],
  desktopApps: readonly string[] = [],
): Capability[] {
  const all = [text, ...notes].join(" ");
  const caps: Capability[] = [];
  if (namedDesktopApp(text, desktopApps)) caps.push("computer");
  else if (COMMUNICATION.test(text)) caps.push("connectors");
  else if (TRANSACTION.test(text) && !/\bpassport\b/i.test(text)) caps.push("browser");
  if (CODE.test(text)) caps.push("shell");
  if (DOCUMENTS.test(all)) caps.push("files");
  if ((RESEARCH.test(text) && !caps.includes("computer")) || caps.length === 0) caps.push("web");
  return caps;
}

/**
 * Capabilities to grant: the desired ones that are available; otherwise the closest available
 * substitute (web for most things, files for drafts). Never grants more than the task needs.
 */
export function grantableCapabilities(
  desired: readonly Capability[],
  available: readonly string[],
  allowed?: readonly Capability[],
): Capability[] {
  const usable = (c: Capability) => available.includes(c) && (!allowed || allowed.includes(c));
  const granted = desired.filter(usable);
  if (granted.length > 0) return granted;
  for (const fallback of ["web", "files"] as const) if (usable(fallback)) return [fallback];
  return [];
}

/** The irreversible verb of a task (book, buy, order, pay, email, send, reserve), if any. */
export function irreversibleVerb(text: string): string | null {
  return riskyVerb(text);
}

export function isCommunicationVerb(verb: string): boolean {
  return verb === "email" || verb === "send";
}

// ── Offline answers ───────────────────────────────────────────────────────────

const CAPITALS: Record<string, string> = {
  australia: "Canberra",
  france: "Paris",
  japan: "Tokyo",
  canada: "Ottawa",
  germany: "Berlin",
  italy: "Rome",
  spain: "Madrid",
  brazil: "Brasília",
  india: "New Delhi",
  china: "Beijing",
  mexico: "Mexico City",
  "the uk": "London",
  "the united kingdom": "London",
  "the us": "Washington, D.C.",
  "the usa": "Washington, D.C.",
  "the united states": "Washington, D.C.",
  portugal: "Lisbon",
  kenya: "Nairobi",
};

const FACTS: Array<[RegExp, string, string]> = [
  [/\bspeed of light\b/i, "About 299,792 km/s in a vacuum.", "299,792 km/s"],
  [
    /\b2 cups of flour\b|\bcups? of flour\b.*\bgrams?\b|\bgrams?\b.*\bcups? of flour\b/i,
    "About 250 g — 1 cup of all-purpose flour is roughly 125 g.",
    "About 250 g",
  ],
  [
    /\bsonder\b/i,
    "Sonder: the realization that every passerby has a life as vivid and complex as your own.",
    "Sonder, defined",
  ],
  [
    /\b3 ?pm pacific\b.*\blondon\b/i,
    "11pm in London — it's 8 hours ahead of Pacific time.",
    "11pm in London",
  ],
  [
    /\bboil an egg\b.*\bjammy\b|\bjammy\b.*\begg\b/i,
    "About 6½–7 minutes in boiling water, then an ice bath.",
    "6½–7 minutes",
  ],
];

/** A deterministic answer for simple questions, or undefined when it needs a lookup. */
export function quickAnswer(question: string): { answer: string; summary: string } | undefined {
  const t = question.trim();
  const capital = /capital of ([a-z .'-]+?)\??$/i.exec(t);
  if (capital) {
    const city = CAPITALS[capital[1]!.trim().toLowerCase()];
    if (city) return { answer: `${city}.`, summary: city };
  }
  for (const [pattern, answer, summary] of FACTS) {
    if (pattern.test(t)) return { answer, summary };
  }
  const tip = /(\d+(?:\.\d+)?)\s*%\s*tip on \$?(\d+(?:\.\d+)?)/i.exec(t);
  if (tip) {
    const amount = (Number(tip[1]) / 100) * Number(tip[2]);
    const total = amount + Number(tip[2]);
    return {
      answer: `$${amount.toFixed(2)} (total $${total.toFixed(2)}).`,
      summary: `$${amount.toFixed(2)} tip`,
    };
  }
  const km = /(\d+(?:\.\d+)?)\s*(?:km|kilometers?)\s+(?:to|in)\s+miles?/i.exec(t);
  if (km) {
    const miles = Number(km[1]) * 0.621371;
    return {
      answer: `${km[1]} km is about ${miles.toFixed(2)} miles.`,
      summary: `${miles.toFixed(2)} miles`,
    };
  }
  const math = /(?:what is|what's|calculate|compute)\s+([\d\s+\-*/().]+?)\s*\??$/i.exec(t);
  if (math) {
    const value = evaluateArithmetic(math[1]!);
    if (value !== undefined) {
      const shown = Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "");
      return { answer: `${math[1]!.trim()} = ${shown}.`, summary: shown };
    }
  }
  return undefined;
}

/** + - * / and parentheses on decimal numbers; undefined for anything else. */
export function evaluateArithmetic(expression: string): number | undefined {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) return undefined;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const factor = (): number | undefined => {
    const token = next();
    if (token === "-") {
      const value = factor();
      return value === undefined ? undefined : -value;
    }
    if (token === "(") {
      const value = sum();
      return next() === ")" ? value : undefined;
    }
    return token !== undefined && /^\d/.test(token) ? Number(token) : undefined;
  };
  const product = (): number | undefined => {
    let value = factor();
    while (value !== undefined && (peek() === "*" || peek() === "/")) {
      const op = next();
      const right = factor();
      if (right === undefined) return undefined;
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number | undefined => {
    let value = product();
    while (value !== undefined && (peek() === "+" || peek() === "-")) {
      const op = next();
      const right = product();
      if (right === undefined) return undefined;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = sum();
  return pos === tokens.length && result !== undefined && Number.isFinite(result)
    ? result
    : undefined;
}
