/**
 * Fake orchestrator: parses the event digest and triages every changed task and reply the way the
 * orchestrator prompt asks (delegate / answer / ask / ignore), all first calls in one response.
 * It is a pure function of the conversation: tool results since the digest decide the next step
 * (a failed spawn is retried with the capabilities the error lists, a failed message_subagent
 * falls back to spawning), and once everything is handled the turn ends without further calls.
 */
import type { Capability } from "../../execution/types";
import {
  isDigest,
  type ParsedChangedTask,
  type ParsedDigest,
  type ParsedNote,
  type ParsedReply,
  parseDigest,
} from "./digest";
import {
  desiredCapabilities,
  grantableCapabilities,
  quickAnswer,
  type TriageDecision,
  triage,
} from "./intent";
import { excerpt, firstUrl, lowerFirst, pick } from "./text";
import { argString, type CallRecord, collectCalls, firstLine, lastUserIndex } from "./transcript";
import type { AssistantTurn, BrainRequest, TurnToolCall } from "./types";

export interface OrchestratorPolicyOptions {
  seed: number;
  /** Upper bound on what the orchestrator grants (e.g. only web/files in mock mode). */
  allowedCapabilities?: readonly Capability[];
}

interface Context {
  digest: ParsedDigest;
  calls: CallRecord[];
  tools: ReadonlySet<string>;
  options: OrchestratorPolicyOptions;
}

interface Work {
  taskId: string;
  text: string;
  notes: readonly string[];
  parentText?: string;
  previousText?: string;
  reply?: string;
  ack: string;
  /** A non-task line the orchestrator anchored: answers also go into the note under it. */
  anchored?: boolean;
}

const MAX_GOAL = 500;
const MAX_COMMENT_TASK = 120;
/** A line that isn't a task is only work when it's addressed to the agent. */
const ADDRESSED = /\?\s*$|^@?agent\b[:,]?\s/i;

export function orchestratorTurn(
  request: BrainRequest,
  options: OrchestratorPolicyOptions,
): AssistantTurn {
  const index = lastUserIndex(request.messages);
  const message = request.messages[index];
  if (message?.role !== "user" || !isDigest(message.content)) return {};
  const ctx: Context = {
    digest: parseDigest(message.content),
    calls: collectCalls(request.messages, index + 1),
    tools: new Set(request.tools.map((tool) => tool.name)),
    options,
  };
  const changedIds = new Set<string>();
  const calls: TurnToolCall[] = [];
  for (const note of ctx.digest.notes) {
    for (const task of note.changed) {
      changedIds.add(task.taskId);
      calls.push(...planTask(task, ctx));
    }
  }
  for (const reply of ctx.digest.replies) {
    if (reply.taskId && !changedIds.has(reply.taskId)) calls.push(...planReply(reply, ctx));
  }
  for (const note of ctx.digest.notes) {
    for (const line of note.changedLines) calls.push(...planLine(note, line, ctx));
  }
  return calls.length > 0 ? { toolCalls: calls } : {};
}

/** A changed line addressed to the agent: anchor a thread to it, then triage it like a task. */
function planLine(
  note: ParsedNote,
  line: { n: number; text: string },
  ctx: Context,
): TurnToolCall[] {
  const text = line.text.trim();
  if (!ADDRESSED.test(text) || !ctx.tools.has("anchor_line")) return [];
  const request = text.replace(/^@?agent\b[:,]?\s*/i, "");
  const decision = triage({
    text: request,
    notes: [],
    ...(ctx.digest.today ? { today: ctx.digest.today } : {}),
  });
  if (decision.kind === "ignore") return [];
  const anchor = ctx.calls.find(
    (call) => call.name === "anchor_line" && argString(call, "text") === line.text,
  );
  if (!anchor) {
    return [
      {
        name: "anchor_line",
        arguments: { notePath: note.notePath, line: line.n, text: line.text },
      },
    ];
  }
  const id =
    anchor.status === "ok" ? /\b((?:anc|tsk)_[\w-]+)/.exec(anchor.result ?? "")?.[1] : null;
  if (!id) return [];
  const work: Work = {
    taskId: id,
    text: request,
    notes: [],
    ack: pick(
      [`On it — ${lowerFirst(excerpt(request, 100))}`, `Looking into it: ${excerpt(request, 100)}`],
      ctx.options.seed,
      request,
    ),
    anchored: true,
  };
  return planOutcome(work, decision, ctx);
}

function callsFor(taskId: string, ctx: Context): CallRecord[] {
  return ctx.calls.filter((call) => argString(call, "taskId") === taskId);
}

function planTask(task: ParsedChangedTask, ctx: Context): TurnToolCall[] {
  const work: Work = {
    taskId: task.taskId,
    text: task.text,
    notes: task.notes,
    ...(task.parentText ? { parentText: task.parentText } : {}),
    ...(task.previousText !== undefined ? { previousText: task.previousText } : {}),
    ack: acknowledgment(task, ctx.options.seed),
  };
  const decision = triage({
    text: task.text,
    notes: task.notes,
    ...(ctx.digest.today ? { today: ctx.digest.today } : {}),
  });
  if (task.change !== "updated") return planOutcome(work, decision, ctx);

  if (task.previousText !== undefined && isCosmeticEdit(task.previousText, task.text)) return [];
  if (decision.kind === "ignore") return [];
  if (decision.kind !== "delegate") return planOutcome(work, decision, ctx);
  // A finished subagent resumes with the new details; without one the task is triaged afresh.
  const message = callsFor(task.taskId, ctx).find((call) => call.name === "message_subagent");
  if (!message) {
    const was =
      task.previousText !== undefined ? ` (was ${JSON.stringify(task.previousText)})` : "";
    const notes = task.notes.length > 0 ? ` Notes: ${task.notes.join("; ")}.` : "";
    return [
      {
        name: "message_subagent",
        arguments: {
          taskId: task.taskId,
          text: `The user edited the task: now ${JSON.stringify(task.text)}${was}.${notes} Update your work to match.`,
        },
      },
    ];
  }
  if (message.status === undefined || message.status === "ok") return [];
  return planOutcome(work, decision, ctx);
}

function planReply(reply: ParsedReply, ctx: Context): TurnToolCall[] {
  const taskId = reply.taskId!;
  const mine = callsFor(taskId, ctx);
  const text = reply.text.trim();
  if (
    /^(thanks|thank you|thx|ty|ok|okay|great|perfect|cool|nice|awesome|got it)\b[\s!.]*$/i.test(
      text,
    ) ||
    /^👍/u.test(text)
  ) {
    if (mine.some((call) => call.name === "post_comment")) return [];
    return [
      { name: "post_comment", arguments: { taskId, text: "Thanks — noted.", summary: "Noted" } },
    ];
  }
  if (/\b(never ?mind|forget it|don'?t bother|cancel (it|that)|stop)\b/i.test(text)) {
    if (mine.some((call) => call.name === "set_task_status")) return [];
    return [
      { name: "set_task_status", arguments: { taskId, status: "ignored", summary: "Dropped" } },
    ];
  }
  const answer = quickAnswer(text);
  if (answer) return planOutcome(workFor(taskId, reply, ctx), { kind: "answer", ...answer }, ctx);
  const combined = `${reply.taskText ?? ""} ${text}`.trim();
  return planOutcome(
    workFor(taskId, reply, ctx),
    { kind: "delegate", capabilities: desiredCapabilities(combined) },
    ctx,
  );
}

function workFor(taskId: string, reply: ParsedReply, ctx: Context): Work {
  return {
    taskId,
    text: reply.taskText ?? reply.text,
    notes: [],
    reply: reply.text,
    ack: pick(
      [`Got it — ${excerpt(reply.text, 80)}.`, `Thanks, that helps — ${excerpt(reply.text, 80)}.`],
      ctx.options.seed,
      reply.text,
    ),
  };
}

function planOutcome(work: Work, decision: TriageDecision, ctx: Context): TurnToolCall[] {
  const { taskId } = work;
  const mine = callsFor(taskId, ctx);
  const has = (name: string) => mine.some((call) => call.name === name);
  switch (decision.kind) {
    case "ignore":
      return has("set_task_status")
        ? []
        : [{ name: "set_task_status", arguments: { taskId, status: "ignored" } }];
    case "ask":
      return has("ask_user")
        ? []
        : [{ name: "ask_user", arguments: { taskId, question: decision.question } }];
    case "answer":
      return planAnswer(work, decision, ctx);
    case "delegate":
      return planDelegate(work, decision.capabilities, ctx);
  }
}

function planAnswer(
  work: Work,
  decision: Extract<TriageDecision, { kind: "answer" }>,
  ctx: Context,
): TurnToolCall[] {
  const { taskId } = work;
  if (callsFor(taskId, ctx).some((call) => call.name === "post_comment")) return [];
  let text = decision.answer;
  let summary = decision.summary ?? "Answered";
  if (!text) {
    const query = work.reply ?? work.text;
    const search = ctx.calls.find(
      (call) => call.name === "web_search" && argString(call, "query") === query,
    );
    if (!search && ctx.tools.has("web_search")) {
      return [{ name: "web_search", arguments: { query, maxResults: 3 } }];
    }
    if (search?.status === "ok" && search.result) {
      const url = firstUrl(search.result);
      const first = firstLine(search.result).replace(/^\d+\.\s*/, "");
      const link = url ? `[${hostOf(url)}](${url})` : "";
      text = !url ? first : first.includes(url) ? first.replace(url, link) : `${first} (${link})`;
      summary = "Answered";
    } else {
      text = "I couldn't look this up right now; the official source is the safest bet.";
      summary = "Couldn't look up";
    }
  }
  const calls: TurnToolCall[] = [
    { name: "post_comment", arguments: { taskId, text, summary } },
    { name: "set_task_status", arguments: { taskId, status: "done", summary } },
  ];
  if (work.anchored && ctx.tools.has("edit_note")) {
    calls.push({
      name: "edit_note",
      arguments: { taskId, edits: [{ op: "add_under", taskId, lines: [text] }] },
    });
  }
  return calls;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function planDelegate(work: Work, wanted: readonly Capability[], ctx: Context): TurnToolCall[] {
  const { taskId } = work;
  const mine = callsFor(taskId, ctx);
  const desired =
    mentionsConnector(work, ctx) && !wanted.includes("connectors")
      ? ["connectors" as const, ...wanted]
      : wanted;
  const spawns = mine.filter((call) => call.name === "spawn_subagent");
  const allowed = ctx.options.allowedCapabilities;
  const last = spawns.at(-1);
  if (!last) {
    const capabilities = grantableCapabilities(desired, ctx.digest.capabilities.available, allowed);
    const calls: TurnToolCall[] = [];
    if (!mine.some((call) => call.name === "post_comment")) {
      calls.push({ name: "post_comment", arguments: { taskId, text: work.ack, summary: "On it" } });
    }
    calls.push(spawnCall(work, capabilities));
    return calls;
  }
  if (last.status === undefined || last.status === "ok" || last.status === "blocked") return [];
  const error = last.result ?? "";
  if (/already working/i.test(error)) {
    if (mine.some((call) => call.name === "message_subagent")) return [];
    const text = work.reply ?? `The task now reads ${JSON.stringify(work.text)}.`;
    return [{ name: "message_subagent", arguments: { taskId, text } }];
  }
  const available = /Available: ([^.]*)\./.exec(error)?.[1];
  if (available !== undefined && spawns.length < 2) {
    const listed = available === "none" ? [] : available.split(",").map((c) => c.trim());
    const capabilities = grantableCapabilities(desired, listed, allowed);
    if (capabilities.length > 0) return [spawnCall(work, capabilities)];
  }
  return [];
}

function spawnCall(work: Work, capabilities: Capability[]): TurnToolCall {
  const goal = work.text.length > MAX_GOAL ? `${work.text.slice(0, MAX_GOAL - 1)}…` : work.text;
  const instructions: string[] = [];
  if (work.notes.length > 0) instructions.push(`Notes from the list: ${work.notes.join("; ")}.`);
  if (work.parentText)
    instructions.push(`This is a subtask of ${JSON.stringify(work.parentText)}.`);
  if (work.previousText !== undefined && work.previousText !== work.text) {
    instructions.push(`The task used to read ${JSON.stringify(work.previousText)}.`);
  }
  if (work.reply) instructions.push(`The user replied: ${JSON.stringify(work.reply)}.`);
  instructions.push(
    "Make sensible assumptions, hand back a short summary and put details in an artifact.",
  );
  return {
    name: "spawn_subagent",
    arguments: {
      taskId: work.taskId,
      goal,
      instructions: instructions.join(" ").slice(0, 7_900),
      capabilities,
    },
  };
}

/** Variations are keyed on the task's content (not its random id) so a seed reproduces across runs. */
function acknowledgment(task: ParsedChangedTask, seed: number): string {
  const text = lowerFirst(excerpt(task.text, MAX_COMMENT_TASK));
  const key = `${task.change}:${task.text}`;
  switch (task.change) {
    case "reopened":
      return pick(
        ["Reopened — picking this back up.", "Back on it — this was reopened."],
        seed,
        key,
      );
    case "retry":
      return pick([`Trying again — ${text}.`, `Another attempt — ${text}.`], seed, key);
    default:
      return pick([`On it — ${text}.`, `Working on it: ${text}.`, `Got it — ${text}.`], seed, key);
  }
}

/** The task names one of the user's connected apps (as listed in the digest). */
function mentionsConnector(work: Work, ctx: Context): boolean {
  const text = [work.text, work.reply ?? "", ...work.notes].join(" ").toLowerCase();
  return ctx.digest.capabilities.connectors.some(
    (c) =>
      c.state !== "error" &&
      c.name.length > 1 &&
      new RegExp(`\\b${escapeRegExp(c.name.toLowerCase())}\\b`).test(text),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCosmeticEdit(previous: string, next: string): boolean {
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return normalize(previous) === normalize(next);
}
