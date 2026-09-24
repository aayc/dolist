/**
 * Fake subagent: one tool call per turn along a fixed plan, re-derived from the transcript on every
 * call (a replay), so it reacts to what actually happened:
 *
 *   post_update → research (web_search/web_fetch, or browser_navigate + browser_snapshot, or bash
 *   for code) → write a draft (files) → create_artifact → the irreversible step for book/buy/order/
 *   pay/email/send/reserve tasks (MCP send tool, browser_click, or mock_irreversible_action) →
 *   finish_task (done / needs_user when blocked or denied / failed after errors)
 *
 * Invalid arguments are re-issued once; errors move on to the next research source; steering
 * messages are acknowledged and folded into the summary; a reply after finishing resumes it.
 */
import { MCP_TOOL_PREFIX } from "../../tools/contracts";
import { synthesizeJson } from "../json-schema";
import { desiredCapabilities, irreversibleVerb, isCommunicationVerb } from "./intent";
import {
  isKickoff,
  type ParsedKickoff,
  parseKickoff,
  parseSteer,
  type SteerMessage,
} from "./kickoff";
import { allUrls, excerpt, firstUrl, pick, slugify } from "./text";
import { type CallRecord, collectCalls, type ResultStatus } from "./transcript";
import type { AssistantTurn, BrainMessage, BrainRequest, BrainTool, TurnToolCall } from "./types";

export interface SubagentPolicyOptions {
  seed: number;
  /** Tools the fake agent may call besides its thread tools (sandboxing). */
  canUse: (toolName: string) => boolean;
  /** Appended to summaries so nobody mistakes fake output for real work. */
  disclaimer: string;
}

const THREAD_TOOLS = new Set(["post_update", "ask_user", "create_artifact", "finish_task"]);
const RISKY_BUTTON =
  /(?:button|link) "([^"]*(?:place order|order|buy|purchase|checkout|pay|book|reserve|confirm|send)[^"]*)" \[ref=(e\d+)\]/i;
const ASK_TRIGGER = /\b(ask me|check with me|confirm with me)\b/i;
const PAST_TENSE: Record<string, string> = {
  book: "Booked",
  reserve: "Reserved",
  order: "Ordered",
  buy: "Bought",
  pay: "Paid",
  email: "Emailed",
  send: "Sent",
};
const GO_AHEAD =
  /\b(go ahead|yes|approved?|do it|try again|please (?:book|order|send|pay|buy|reserve|email))\b/i;

interface Outcome {
  status: ResultStatus | "pending";
  result?: string;
  attempts: number;
}

/** Walks the calls in order, matching each planned step with the call that performed it. */
class Replay {
  private next = 0;
  private readonly calls: readonly CallRecord[];

  constructor(calls: readonly CallRecord[]) {
    this.calls = calls;
  }

  take(tool: string): Outcome | undefined {
    for (let i = this.next; i < this.calls.length; i++) {
      if (this.calls[i]!.name !== tool) continue;
      let attempts = 1;
      let call = this.calls[i]!;
      this.next = i + 1;
      // Invalid arguments are re-issued right away: fold the retry into this step.
      while (call.status === "invalid" && this.calls[this.next]?.name === tool) {
        call = this.calls[this.next]!;
        this.next++;
        attempts++;
      }
      return {
        status: call.status ?? "pending",
        ...(call.result !== undefined ? { result: call.result } : {}),
        attempts,
      };
    }
    return undefined;
  }
}

interface Plan {
  task: string;
  kickoff: ParsedKickoff;
  tools: Map<string, BrainTool>;
  options: SubagentPolicyOptions;
  adjustments: string[];
  /** Steering that arrived since the assistant last spoke (acknowledged in this turn's text). */
  fresh: SteerMessage[];
  replay: Replay;
  errors: string[];
  researchOk: boolean;
  urls: string[];
  lastPage?: string;
  /** The irreversible call for this task and, once made, what came back. */
  risky?: { call: TurnToolCall; outcome?: Outcome };
}

type Step = { call: TurnToolCall; text?: string } | { finish: true } | null;

export function subagentTurn(request: BrainRequest, options: SubagentPolicyOptions): AssistantTurn {
  const { messages } = request;
  let k = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user" && isKickoff(message.content)) {
      k = i;
      break;
    }
  }
  const tools = new Map<string, BrainTool>();
  for (const tool of request.tools) {
    if (THREAD_TOOLS.has(tool.name) || options.canUse(tool.name)) tools.set(tool.name, tool);
  }
  const kickoff = k >= 0 ? parseKickoff((messages[k] as { content: string }).content) : null;
  if (!kickoff) return orphanTurn(messages, tools, options);

  const after = messages.slice(k + 1);
  const calls = collectCalls(messages, k + 1);
  const finishes = calls.filter((call) => call.name === "finish_task" && call.status === "ok");
  const lastFinish = finishes.at(-1);
  if (lastFinish) {
    const resultAt = messages.findIndex(
      (m, i) => i > k && m.role === "tool" && m.toolCallId === lastFinish.id,
    );
    const later = userSteers(messages, resultAt + 1);
    if (later.length === 0 || later.every((s) => s.kind === "nudge")) return {};
    return followUp(kickoff, calls, lastFinish, later, messages, tools, options);
  }

  const steers = userSteers(messages, k + 1);
  const updates = steers.filter(
    (s): s is Extract<SteerMessage, { kind: "task_update" }> => s.kind === "task_update",
  );
  const lastAssistant = lastIndexOf(after, (m) => m.role === "assistant");
  const fresh = userSteers(after, lastAssistant + 1);
  const plan: Plan = {
    task: updates.at(-1)?.text || kickoff.task,
    kickoff,
    tools,
    options,
    adjustments: [...kickoff.followUps, ...steers].flatMap(adjustmentText),
    fresh,
    replay: new Replay(calls),
    errors: [],
    researchOk: false,
    urls: [],
  };
  const planned = nextStep(plan);
  const step = fresh.some((s) => s.kind === "nudge") ? { finish: true as const } : planned;
  if (step === null) return {};
  const ack = acknowledge(fresh, options.seed);
  if ("finish" in step) {
    const finish = finishCall(plan);
    return withText(finish, [ack, finish.text].filter(Boolean).join(" "));
  }
  return withText({ toolCalls: [step.call] }, [ack, step.text].filter(Boolean).join(" "));
}

function nextStep(plan: Plan): Step {
  const { tools, replay } = plan;
  const task = plan.task;

  // 1. Tell the user what's happening.
  const update = replay.take("post_update");
  const intro = plan.kickoff.retry
    ? `Picking “${excerpt(task, 100)}” back up — reviewing what was done before.`
    : `Looking into “${excerpt(task, 100)}” — gathering a few options first.`;
  if (!update) {
    return {
      text: intro,
      call: {
        name: "post_update",
        arguments: {
          text: pick(
            [
              `Plan: ${researchDescription(plan)}, then a short write-up${irreversibleVerb(task) ? ` and the final ${irreversibleVerb(task)} step (it will ask for your approval)` : ""}.`,
              `Starting on it: ${researchDescription(plan)} first.`,
            ],
            plan.options.seed,
            task,
          ),
          summary: "Researching…",
        },
      },
    };
  }
  if (update.status === "invalid" && update.attempts < 2) return { call: postUpdateCall(plan) };

  // 2. Questions only the user can answer.
  if (ASK_TRIGGER.test([task, ...plan.kickoff.notes, plan.kickoff.instructions ?? ""].join(" "))) {
    const ask = replay.take("ask_user");
    if (!ask) {
      return {
        call: {
          name: "ask_user",
          arguments: {
            question: `Before I start on “${excerpt(task, 80)}”: any preferences I should know about?`,
          },
        },
      };
    }
    if (ask.status === "ok" && plan.adjustments.length === 0) return null;
  }

  // 3. Research, trying the next source when one fails.
  const research = researchStep(plan);
  if (research) return research;

  // 4. A draft file for document tasks, when file tools exist.
  if (tools.has("write") && desiredCapabilities(task).includes("files")) {
    const write = replay.take("write");
    if (!write || (write.status === "invalid" && write.attempts < 2)) {
      return {
        call: { name: "write", arguments: { path: "draft.md", content: artifactContent(plan) } },
      };
    }
    if (write.status === "error" || write.status === "blocked")
      plan.errors.push(errorLine("write", write));
  }

  // 5. The deliverable.
  const artifact = replay.take("create_artifact");
  if (!artifact || (artifact.status === "invalid" && artifact.attempts < 2)) {
    return {
      call: {
        name: "create_artifact",
        arguments: {
          title: `Summary: ${excerpt(task, 180)}`,
          kind: "markdown",
          content: artifactContent(plan),
        },
      },
    };
  }
  if (artifact.status !== "ok") plan.errors.push(errorLine("create_artifact", artifact));

  // 6. The irreversible step (the safety gate decides whether it needs approval).
  const verb = irreversibleVerb(task);
  if (verb && !deniedBefore(plan) && plan.errors.length === 0) {
    const risky = riskyCall(plan, verb);
    if (risky) {
      const outcome = replay.take(risky.name);
      plan.risky = { call: risky, ...(outcome ? { outcome } : {}) };
      if (!outcome || (outcome.status === "invalid" && outcome.attempts < 2)) {
        return { call: risky, text: `Everything's ready — attempting to ${verb} now.` };
      }
    }
  }
  return { finish: true };
}

function researchStep(plan: Plan): Step {
  const { tools, replay } = plan;
  const task = plan.task;
  const sourceText = [task, ...plan.kickoff.notes, plan.kickoff.instructions ?? ""].join(" ");
  const attempt = (tool: string, args: Record<string, unknown>): Step | "done" => {
    const outcome = replay.take(tool);
    if (!outcome || (outcome.status === "invalid" && outcome.attempts < 2)) {
      return { call: { name: tool, arguments: args } };
    }
    if (outcome.status === "ok") {
      plan.researchOk = true;
      plan.urls.push(...allUrls(outcome.result ?? ""));
      if (tool.startsWith("browser_")) plan.lastPage = outcome.result ?? "";
    } else plan.errors.push(errorLine(tool, outcome));
    return "done";
  };
  const errorsBefore = plan.errors.length;
  if (tools.has("web_search")) {
    const step = attempt("web_search", { query: excerpt(task, 200), maxResults: 3 });
    if (step !== "done") return step;
  }
  const url = plan.urls[0] ?? firstUrl(sourceText);
  if (tools.has("web_fetch") && (url || !tools.has("web_search"))) {
    const step = attempt("web_fetch", {
      url: url ?? `https://www.example.com/search?q=${slugify(task)}`,
      maxChars: 4_000,
    });
    if (step !== "done") return step;
  }
  if (!tools.has("web_search") && !tools.has("web_fetch") && tools.has("browser_navigate")) {
    const step = attempt("browser_navigate", {
      url: firstUrl(sourceText) ?? `https://shop.example.com/search?q=${slugify(task)}`,
    });
    if (step !== "done") return step;
    if (tools.has("browser_snapshot") && plan.researchOk) {
      const snapshot = attempt("browser_snapshot", {});
      if (snapshot !== "done") return snapshot;
    }
  } else if (
    !tools.has("web_search") &&
    !tools.has("web_fetch") &&
    tools.has("bash") &&
    desiredCapabilities(task).includes("shell")
  ) {
    const step = attempt("bash", { command: "ls -la" });
    if (step !== "done") return step;
  }
  // One source working is enough; errors only count when nothing worked.
  if (plan.researchOk) plan.errors.splice(errorsBefore);
  return null;
}

function riskyCall(plan: Plan, verb: string): TurnToolCall | undefined {
  const { tools, task } = plan;
  if (isCommunicationVerb(verb)) {
    const send = [...tools.values()].find(
      (tool) =>
        tool.name.startsWith(MCP_TOOL_PREFIX) &&
        /__(send|reply|send_email|send_message)/.test(tool.name),
    );
    if (send) {
      return {
        name: send.name,
        arguments: synthesizeJson(send.parameters, {
          to: "recipient@example.com",
          recipient: "recipient@example.com",
          subject: excerpt(task, 60),
          body: draftText(plan),
          text: draftText(plan),
          message: draftText(plan),
        }),
      };
    }
  }
  if (!isCommunicationVerb(verb) && tools.has("browser_click") && plan.lastPage !== undefined) {
    const button = RISKY_BUTTON.exec(plan.lastPage);
    const label = button?.[1] ?? buttonLabel(verb);
    return {
      name: "browser_click",
      arguments: {
        ...(button ? { ref: button[2] } : { text: label }),
        element: `${label} button`,
      },
    };
  }
  if (tools.has("mock_irreversible_action")) {
    return {
      name: "mock_irreversible_action",
      arguments: { action: verb, details: `${verb} for “${excerpt(task, 200)}”` },
    };
  }
  return undefined;
}

function finishCall(plan: Plan): AssistantTurn {
  const { task, options } = plan;
  const verb = irreversibleVerb(task);
  const shortTask = excerpt(task, 120);
  const notes =
    plan.adjustments.length > 0
      ? `\n\nAdjusted for your notes: ${plan.adjustments.map((a) => excerpt(a, 200)).join("; ")}.`
      : "";
  let status: "done" | "failed" | "needs_user";
  let summary: string;
  let shortSummary: string;
  let text: string | undefined;
  const risky = plan.risky?.outcome;
  if (verb && deniedBefore(plan)) {
    status = "needs_user";
    summary = `I didn't try to ${verb} again because you denied it earlier. Reply “go ahead” if you want me to.`;
    shortSummary = "Not approved";
  } else if (risky?.status === "blocked") {
    status = "needs_user";
    text = `Stopping here: the ${verb} step wasn't approved.`;
    summary = `I prepared everything but didn't ${verb} because it wasn't approved (${blockReason(risky.result)}).`;
    shortSummary = "Not approved";
  } else if (risky && risky.status !== "ok") {
    status = "failed";
    summary = `I tried to ${verb} but it failed: ${excerpt(risky.result ?? "unknown error", 300)}`;
    shortSummary = `${verb} error`;
  } else if (plan.errors.length > 0) {
    status = "failed";
    summary = `I couldn't finish “${shortTask}”: ${plan.errors.join("; ")}.`;
    shortSummary = `${plan.errors[0]!.split(" ")[0]} error`;
  } else if (verb && !plan.risky) {
    status = "needs_user";
    summary = `I prepared everything for “${shortTask}”, but I can't ${verb} from here — the last step is yours. See the summary artifact.`;
    shortSummary = "Ready for you";
  } else if (verb) {
    status = "done";
    text = `All set — the ${verb} step went through.`;
    summary = `Done: ${verb} for “${shortTask}”. See the summary artifact. ${options.disclaimer}`;
    // The badge already says "Done · …".
    shortSummary = `${PAST_TENSE[verb] ?? "Done"} (mock)`;
  } else {
    status = "done";
    summary = `Here's a quick summary for “${shortTask}” — details are in the artifact. ${options.disclaimer}`;
    shortSummary = "Summary ready";
  }
  return {
    ...(text ? { text } : {}),
    toolCalls: [
      { name: "finish_task", arguments: { status, summary: summary + notes, shortSummary } },
    ],
  };
}

function followUp(
  kickoff: ParsedKickoff,
  calls: CallRecord[],
  lastFinish: CallRecord,
  steers: SteerMessage[],
  messages: readonly BrainMessage[],
  tools: Map<string, BrainTool>,
  options: SubagentPolicyOptions,
): AssistantTurn {
  const updates = steers.filter(
    (s): s is Extract<SteerMessage, { kind: "task_update" }> => s.kind === "task_update",
  );
  const task = updates.at(-1)?.text || kickoff.task;
  const text = steers.flatMap(adjustmentText).join(" ") || task;
  const verb = irreversibleVerb(task);
  const before = calls.filter((call) => call.at < lastFinish.at);
  const since = calls.filter((call) => call.at > lastFinish.at);
  const wasBlocked = before.some((call) => call.status === "blocked" && isRiskyTool(call.name));
  if (verb && wasBlocked && steers.some((s) => "text" in s && GO_AHEAD.test(s.text))) {
    const plan: Plan = {
      task,
      kickoff,
      tools,
      options,
      adjustments: [],
      fresh: [],
      replay: new Replay(since),
      errors: [],
      researchOk: true,
      urls: [],
      lastPage: lastBrowserPage(messages),
    };
    const risky = riskyCall(plan, verb);
    if (risky) {
      const outcome = plan.replay.take(risky.name);
      if (!outcome || (outcome.status === "invalid" && outcome.attempts < 2)) {
        return { text: `Okay — trying to ${verb} again.`, toolCalls: [risky] };
      }
      return finishCall({ ...plan, risky: { call: risky, outcome } });
    }
  }
  return {
    text: `Got it — ${excerpt(text, 80)}`,
    toolCalls: [
      {
        name: "finish_task",
        arguments: {
          status: "done",
          summary: `Updated based on your message: ${excerpt(text, 200)}. ${options.disclaimer}`,
          shortSummary: "Updated",
        },
      },
    ],
  };
}

/** No kickoff in sight (a session primed differently): wrap up politely. */
function orphanTurn(
  messages: readonly BrainMessage[],
  tools: Map<string, BrainTool>,
  options: SubagentPolicyOptions,
): AssistantTurn {
  const calls = collectCalls(messages);
  if (
    calls.some((call) => call.name === "finish_task" && call.status === "ok") ||
    !tools.has("finish_task")
  ) {
    return {};
  }
  return {
    toolCalls: [
      {
        name: "finish_task",
        arguments: {
          status: "done",
          summary: `Nothing specific to do here. ${options.disclaimer}`,
          shortSummary: "Done",
        },
      },
    ],
  };
}

function userSteers(messages: readonly BrainMessage[], from: number): SteerMessage[] {
  const out: SteerMessage[] = [];
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "user" && !isKickoff(message.content))
      out.push(...parseSteer(message.content));
  }
  return out;
}

function adjustmentText(steer: SteerMessage): string[] {
  switch (steer.kind) {
    case "user_reply":
    case "orchestrator":
    case "other":
      return steer.text.trim() ? [steer.text.trim()] : [];
    case "task_update":
      return [`the task now reads “${steer.text}”`];
    case "nudge":
      return [];
  }
}

function acknowledge(fresh: SteerMessage[], seed: number): string {
  const reply = fresh.find((s) => s.kind === "user_reply" || s.kind === "orchestrator");
  if (reply && "text" in reply) {
    return pick(
      [
        `Noted — ${excerpt(reply.text, 80)}.`,
        `Thanks — adjusting for: ${excerpt(reply.text, 80)}.`,
      ],
      seed,
      reply.text,
    );
  }
  const update = fresh.find((s) => s.kind === "task_update");
  if (update && "text" in update)
    return `The task changed to “${excerpt(update.text, 80)}” — adjusting.`;
  return "";
}

function withText(turn: AssistantTurn, text: string): AssistantTurn {
  return text ? { ...turn, text } : turn;
}

function postUpdateCall(plan: Plan): TurnToolCall {
  return {
    name: "post_update",
    arguments: {
      text: `Plan: ${researchDescription(plan)}, then a short write-up.`,
      summary: "Researching…",
    },
  };
}

function researchDescription(plan: Plan): string {
  const { tools } = plan;
  if (tools.has("web_search")) return "search the web for good options";
  if (tools.has("web_fetch")) return "read the most relevant page";
  if (tools.has("browser_navigate")) return "check the site in the browser";
  if (tools.has("bash") && desiredCapabilities(plan.task).includes("shell"))
    return "look at the workspace";
  return "pull together what I know";
}

function deniedBefore(plan: Plan): boolean {
  return (
    plan.kickoff.retry &&
    plan.kickoff.history.some((line) => {
      const match = /^Tool (\S+) \(blocked\)/.exec(line);
      return match !== null && isRiskyTool(match[1]!);
    })
  );
}

function isRiskyTool(name: string): boolean {
  return (
    name === "mock_irreversible_action" ||
    name === "browser_click" ||
    (name.startsWith(MCP_TOOL_PREFIX) && /__(send|reply)/.test(name))
  );
}

function blockReason(result: string | undefined): string {
  return (result ?? "").replace(/^Blocked by safety policy:\s*/i, "").trim() || "not approved";
}

function errorLine(tool: string, outcome: Outcome): string {
  const detail = (outcome.result ?? "").replace(/^(Error:\s*|Blocked by safety policy:\s*)/i, "");
  return `${tool} ${outcome.status === "blocked" ? "was blocked" : "failed"} (${excerpt(detail || "no details", 160)})`;
}

function buttonLabel(verb: string): string {
  switch (verb) {
    case "book":
    case "reserve":
      return "Confirm booking";
    case "pay":
      return "Pay now";
    default:
      return "Place order";
  }
}

function draftText(plan: Plan): string {
  return `Hi,\n\nFollowing up about: ${excerpt(plan.task, 200)}.\n\nThanks!`;
}

function lastBrowserPage(messages: readonly BrainMessage[]): string | undefined {
  const calls = collectCalls(messages);
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (call.name.startsWith("browser_") && call.status === "ok") return call.result;
  }
  return undefined;
}

function lastIndexOf<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

function artifactContent(plan: Plan): string {
  const task = plan.task.length > 300 ? excerpt(plan.task, 300) : plan.task;
  const sources = [...new Set(plan.urls)].slice(0, 3);
  const rows = [
    ["A", "Best overall", "$$"],
    ["B", "Cheapest", "$"],
    ["C", "Fastest", "$$$"],
  ].map(([option, why, cost], i) => `| ${option} | ${why} | ${cost} | ${sources[i] ?? "—"} |`);
  const notes = [
    ...plan.kickoff.notes.map((note) => `- From your list: ${note}`),
    ...plan.adjustments.map((a) => `- Adjusted for: ${a}`),
  ];
  return [
    `# ${task}`,
    "",
    "_Prepared by the fake agent: deterministic sample content, no real research._",
    "",
    "## Options",
    "",
    "| Option | Why | Cost | Source |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...(notes.length > 0 ? ["## Notes", "", ...notes, ""] : []),
    "## Recommendation",
    "",
    "Option A balances quality and price.",
    "",
  ].join("\n");
}
