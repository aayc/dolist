/**
 * The fake orchestrator's side of its chat: messages the user wrote to it directly. Each one is
 * read as a status question ("what are you working on?"), a request to drop a task, instructions
 * for a working subagent, or something else; the brain acts with its tools first and then replies
 * in text, like the prompt asks. A pure function of the conversation: the intended calls are
 * derived from the digest again on every step and made once; the reply comes when they have run.
 */
import type { Capability } from "../../execution/types";
import type { ParsedDigest } from "./digest";
import { type RoutineRequest, routineRequest } from "./intent";
import { excerpt, upperFirst } from "./text";
import { argString, type CallRecord, firstLine } from "./transcript";
import type { TurnToolCall } from "./types";

interface KnownTask {
  taskId: string;
  text: string;
  agentStatus?: string;
}

type Intent =
  | { kind: "status" }
  | { kind: "routine"; routine: RoutineRequest; uses: Capability[] }
  | { kind: "drop"; task: KnownTask | null }
  | { kind: "forward"; task: KnownTask | null; text: string }
  | { kind: "other" };

export interface DirectPlan {
  /** Calls still to make (none once they all ran). */
  calls: TurnToolCall[];
  /** The reply, once every call has a result; absent while calls are pending or already replied. */
  reply?: string;
}

/** Agent statuses that mean a subagent is on the task right now. */
const WORKING = new Set(["working", "queued", "waiting_approval"]);
const STATUS_QUESTION =
  /\b(what(?:'s| is| are)? (?:you )?(?:working on|doing|up to)|what'?s (?:going on|happening|running)|status|progress|how'?s it going|anything (?:running|waiting)|waiting on me)\b/i;
const DROP = /\b(drop|cancel|stop|forget(?: about)?|never ?mind|skip|remove|don'?t bother with)\b/i;
const STOPWORDS = new Set([
  "the",
  "task",
  "that",
  "this",
  "one",
  "please",
  "for",
  "and",
  "with",
  "also",
  "about",
  "drop",
  "cancel",
  "stop",
  "forget",
  "skip",
  "remove",
  "never",
  "mind",
  "just",
  "can",
  "you",
  "your",
  "it's",
  "its",
  "from",
  "into",
  "then",
  "there",
  "tell",
  "ask",
  "agent",
]);

export interface DirectOptions {
  /** The session has create_routine. */
  canCreateRoutines: boolean;
  /** What a routine's runs may use. */
  uses: (routine: RoutineRequest) => Capability[];
}

export function planDirect(
  digest: ParsedDigest,
  calls: readonly CallRecord[],
  replied: boolean,
  options: DirectOptions = { canCreateRoutines: false, uses: (r) => r.capabilities },
): DirectPlan {
  if (digest.direct.length === 0 || replied) return { calls: [] };
  const tasks = knownTasks(digest);
  const intents = digest.direct.map((text) => {
    const routine = options.canCreateRoutines ? routineRequest(text) : undefined;
    return routine
      ? ({ kind: "routine", routine, uses: options.uses(routine) } as const)
      : readIntent(text, tasks);
  });
  const intended = intents.flatMap((intent) => callsFor(intent));
  const pending = intended.filter((call) => !made(call, calls));
  if (pending.length > 0) return { calls: pending };
  const sentences = intents.map((intent) => replyFor(intent, digest, tasks, calls));
  return { calls: [], reply: [...new Set(sentences)].join(" ") };
}

function knownTasks(digest: ParsedDigest): KnownTask[] {
  const byId = new Map<string, KnownTask>();
  for (const note of digest.notes) {
    for (const task of note.changed)
      byId.set(task.taskId, { taskId: task.taskId, text: task.text });
    for (const task of note.others) {
      byId.set(task.taskId, {
        taskId: task.taskId,
        text: task.text,
        ...(task.agentStatus ? { agentStatus: task.agentStatus } : {}),
      });
    }
  }
  for (const agent of digest.subagents) {
    const known = byId.get(agent.taskId);
    byId.set(agent.taskId, {
      taskId: agent.taskId,
      text: known?.text ?? agent.taskText,
      agentStatus: agent.status,
    });
  }
  return [...byId.values()];
}

function readIntent(text: string, tasks: readonly KnownTask[]): Intent {
  if (STATUS_QUESTION.test(text)) return { kind: "status" };
  if (DROP.test(text)) return { kind: "drop", task: bestMatch(text, tasks) };
  const working = tasks.filter((task) => WORKING.has(task.agentStatus ?? ""));
  const match = bestMatch(text, working) ?? (working.length === 1 ? working[0]! : null);
  if (match || working.length > 1) return { kind: "forward", task: match, text };
  return { kind: "other" };
}

/** The task sharing the most words with the message (at least one), in list order on ties. */
function bestMatch(text: string, tasks: readonly KnownTask[]): KnownTask | null {
  const wanted = words(text);
  let best: KnownTask | null = null;
  let bestScore = 0;
  for (const task of tasks) {
    const have = words(task.text);
    let score = 0;
    for (const word of wanted) if (have.has(word)) score++;
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  return best;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .map((word) => word.replace(/'s$/, ""))
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

function callsFor(intent: Intent): TurnToolCall[] {
  if (intent.kind === "routine") {
    const { routine } = intent;
    return [
      {
        name: "create_routine",
        arguments: {
          name: routine.name,
          schedule: routine.schedule,
          instructions: routine.instructions,
          notify: routine.notify,
          uses: intent.uses,
        },
      },
    ];
  }
  if (intent.kind === "drop" && intent.task) {
    const { taskId } = intent.task;
    return WORKING.has(intent.task.agentStatus ?? "")
      ? [{ name: "cancel_subagent", arguments: { taskId, reason: "The user asked to drop it." } }]
      : [
          {
            name: "set_task_status",
            arguments: { taskId, status: "ignored", summary: "Dropped" },
          },
        ];
  }
  if (intent.kind === "forward" && intent.task) {
    return [
      {
        name: "message_subagent",
        arguments: { taskId: intent.task.taskId, text: `The user adds: ${intent.text}` },
      },
    ];
  }
  return [];
}

function made(call: TurnToolCall, calls: readonly CallRecord[]): boolean {
  const args = call.arguments as Record<string, unknown>;
  const key = call.name === "create_routine" ? "name" : "taskId";
  return calls.some((record) => record.name === call.name && argString(record, key) === args[key]);
}

function outcome(
  name: string,
  taskId: string,
  calls: readonly CallRecord[],
): CallRecord | undefined {
  return calls.find((record) => record.name === name && argString(record, "taskId") === taskId);
}

function replyFor(
  intent: Intent,
  digest: ParsedDigest,
  tasks: readonly KnownTask[],
  calls: readonly CallRecord[],
): string {
  switch (intent.kind) {
    case "status":
      return describeWork(digest, tasks);
    case "routine": {
      const { routine } = intent;
      const call = calls.find(
        (record) => record.name === "create_routine" && argString(record, "name") === routine.name,
      );
      if (call?.status === "blocked") return "Okay — I won't set up that routine.";
      if (call?.status !== "ok") return `I couldn't create that routine: ${failure(call)}`;
      const words = /: (.+?) · /.exec(call.result ?? "")?.[1] ?? routine.schedule;
      return `Done — “${routine.name}” runs ${lowerWords(words)}. Each run reports under Routines.`;
    }
    case "drop": {
      if (!intent.task) return "Which task should I drop? I couldn't tell from your message.";
      const name = `“${excerpt(intent.task.text, 60)}”`;
      const call =
        outcome("cancel_subagent", intent.task.taskId, calls) ??
        outcome("set_task_status", intent.task.taskId, calls);
      if (call?.status !== "ok") return `I couldn't drop ${name}: ${failure(call)}`;
      return call.name === "cancel_subagent"
        ? `Dropped ${name} — I stopped its agent.`
        : `Dropped ${name}.`;
    }
    case "forward": {
      if (!intent.task) {
        return "Several agents are working right now — which task is that for?";
      }
      const name = `“${excerpt(intent.task.text, 60)}”`;
      const call = outcome("message_subagent", intent.task.taskId, calls);
      if (call?.status !== "ok") return `I couldn't pass that on to ${name}: ${failure(call)}`;
      return `Passed that on to the agent working on ${name}.`;
    }
    case "other":
      return "Noted. I can tell you what I'm working on, drop a task, or pass instructions to an agent that's working on one.";
  }
}

function lowerWords(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function failure(call: CallRecord | undefined): string {
  const line = firstLine(call?.result).replace(/^Error:\s*/i, "");
  return line ? excerpt(line, 160) : "the tool didn't answer.";
}

/** "Working on “A” (2m) and “B” (queued). Waiting on you: “C”. Done: 2." */
function describeWork(digest: ParsedDigest, tasks: readonly KnownTask[]): string {
  const running = digest.subagents.map((agent) => {
    const detail = agent.status === "working" ? (agent.elapsed ?? "just started") : agent.status;
    return `“${excerpt(agent.taskText, 60)}” (${detail.replace("_", " ")})`;
  });
  const waiting = tasks
    .filter((task) => task.agentStatus === "waiting_user")
    .map((task) => `“${excerpt(task.text, 60)}”`);
  const done = tasks.filter((task) => task.agentStatus === "done").length;
  const parts: string[] = [];
  parts.push(
    running.length > 0 ? `Working on ${joinAnd(running)}.` : "Nothing is running right now.",
  );
  if (waiting.length > 0) parts.push(`Waiting on you: ${joinAnd(waiting)}.`);
  if (done > 0) parts.push(`Done today: ${done}.`);
  if (running.length === 0 && waiting.length === 0 && done === 0) {
    parts.push("Write a task in today's note and I'll pick it up.");
  }
  return upperFirst(parts.join(" "));
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
