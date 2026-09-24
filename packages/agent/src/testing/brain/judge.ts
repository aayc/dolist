/**
 * Fake safety judge: reads the prompt built by `buildJudgePrompt` (`src/safety/llm-judge.ts`) and
 * returns a verdict matching `JUDGE_SCHEMA`: deny for catastrophic or manipulative actions,
 * require_approval for effects the user must confirm, allow otherwise. It stands in for the model
 * only; the rules layer in front of it is what keeps actions safe.
 */
import type { ActionCategory, RiskLevel, SafetyDecision } from "@ddl/core";
import { lastUserText } from "./transcript";
import type { AssistantTurn, BrainRequest } from "./types";

export interface JudgePromptView {
  task: string;
  role: string;
  tool: string;
  description: string;
  input: string;
  rationale: string;
  signals: string;
}

export interface FakeVerdict {
  decision: SafetyDecision;
  risk: RiskLevel;
  categories: ActionCategory[];
  reason: string;
}

const DENY: Array<[RegExp, ActionCategory, string]> = [
  [
    /rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\*)|\bmkfs\b|\bdd\s+if=.*\bof=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bformat c:/i,
    "destructive",
    "This would wipe data irreversibly.",
  ],
  [
    /\b(password|passwd|api[_ -]?key|secret|private key|id_rsa|\.env)\b[\s\S]{0,200}\b(curl|wget|upload|pastebin|webhook|post to)\b|\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
    "credentials",
    "This looks like it would leak secrets or run untrusted code.",
  ],
  [
    /ignore (all |any )?(previous|prior|earlier) instructions|this (action )?(is|was) (pre-?)?approved|\bwire (the )?(money|funds)\b|\bgift cards?\b/i,
    "unknown",
    "The request shows signs of manipulation (prompt injection).",
  ],
];

const APPROVAL: Array<[RegExp, ActionCategory]> = [
  [
    /\b(buy|purchase|place order|checkout|check out|pay|payment|credit card|subscribe|invoice|charge|refund|transfer)\b/i,
    "payment",
  ],
  [/\b(book|booking|reserve|reservation|rsvp|confirm appointment)\b/i, "booking"],
  [/\b(send|email|e-mail|reply|message|invite|dm)\b/i, "communication"],
  [/\b(publish|post publicly|tweet|share publicly)\b/i, "publishing"],
  [/\b(delete|remove|drop table|erase|wipe|overwrite|truncate)\b/i, "destructive"],
  [
    /\b(sign up|register|create (an )?account|change password|close account|unsubscribe)\b/i,
    "account",
  ],
  [/\b(password|log ?in|sign in|credential|2fa|one-time code|otp)\b/i, "credentials"],
  [/\b(sudo|install|brew|pip install|npm install|launchctl|crontab|chmod|chown)\b/i, "system"],
  [/\b(submit|send form)\b/i, "form_submission"],
];

/** Pulls the fenced sections out of the judge prompt. */
export function parseJudgePrompt(text: string): JudgePromptView {
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? "";
  const action = tag("action");
  const line = (prefix: string) =>
    action
      .split("\n")
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? "";
  const inputAt = action.indexOf("input: ");
  return {
    task: tag("task"),
    role: tag("agent_role"),
    tool: line("tool: ").replace(/\s*\(.*\)$/, ""),
    description: line("description: "),
    input: inputAt === -1 ? "" : action.slice(inputAt + "input: ".length).trim(),
    rationale: tag("agent_rationale"),
    signals: tag("rule_signals"),
  };
}

export function judgeVerdict(view: JudgePromptView): FakeVerdict {
  // The rationale is untrusted, but manipulation attempts inside it are exactly what to deny.
  const action = `${view.tool} ${view.description} ${view.input}`;
  const everything = `${action} ${view.rationale}`;
  for (const [pattern, category, reason] of DENY) {
    if (pattern.test(everything)) {
      return { decision: "deny", risk: "critical", categories: [category], reason };
    }
  }
  const categories = APPROVAL.filter(([pattern]) => pattern.test(action)).map(
    ([, category]) => category,
  );
  if (categories.length > 0) {
    const unique = [...new Set(categories)];
    const risk: RiskLevel = unique.some(
      (c) => c === "payment" || c === "destructive" || c === "credentials",
    )
      ? "high"
      : "medium";
    return {
      decision: "require_approval",
      risk,
      categories: unique,
      reason: `This has real-world effects (${unique.join(", ")}), so it needs your approval.`,
    };
  }
  const read =
    /\b(read|get|list|search|find|fetch|navigate|open|view|scroll|snapshot|screenshot|look up)\b/i.test(
      action,
    );
  return {
    decision: "allow",
    risk: "low",
    categories: [read ? "read" : "compute"],
    reason: "Harmless and consistent with the task.",
  };
}

export function judgeTurn(request: BrainRequest): AssistantTurn {
  return { text: JSON.stringify(judgeVerdict(parseJudgePrompt(lastUserText(request.messages)))) };
}
