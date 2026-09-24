import { type ToolSpec, textResult, truncate } from "@ddl/core";
import type { Capability } from "../execution/types";
import {
  type AnchorLineInput,
  type CancelSubagentInput,
  type ListTasksInput,
  type MessageSubagentInput,
  type OrchestratorAskUserInput,
  type PostCommentInput,
  type SetTaskStatusInput,
  type SettableTaskStatus,
  type SpawnSubagentInput,
  TOOL,
} from "./contracts";
import {
  asInput,
  guarded,
  optionalString,
  requireEnum,
  requireEnumArray,
  requireString,
  ToolInputError,
} from "./input";

export const CAPABILITIES: readonly Capability[] = [
  "web",
  "browser",
  "computer",
  "shell",
  "files",
  "connectors",
];

export const SETTABLE_TASK_STATUSES: readonly SettableTaskStatus[] = [
  "ignored",
  "done",
  "waiting_user",
  "failed",
];

/**
 * What the orchestrator's tools do. The runtime implements it on top of records, threads and the
 * subagent manager; evals implement it to record decisions. Methods return the text the model sees
 * and throw `ToolInputError` for requests the model should correct.
 */
export interface OrchestratorToolHost {
  spawnSubagent(input: SpawnSubagentInput): Promise<string>;
  postComment(input: PostCommentInput): Promise<string>;
  askUser(input: OrchestratorAskUserInput): Promise<string>;
  setTaskStatus(input: SetTaskStatusInput): Promise<string>;
  messageSubagent(input: MessageSubagentInput): Promise<string>;
  cancelSubagent(input: CancelSubagentInput): Promise<string>;
  listTasks(input: ListTasksInput): Promise<string>;
  anchorLine(input: AnchorLineInput): Promise<string>;
}

const TASK_ID = {
  type: "string",
  description: "The task id from the event digest, e.g. tsk_ab12cd34ef.",
} as const;

/** Orchestrator-internal effects (threads, badges, starting gated subagents) only. */
const INTERNAL = { readOnly: true, category: "compute" } as const;

export function createOrchestratorTools(host: OrchestratorToolHost): ToolSpec[] {
  const spawn: ToolSpec = {
    name: TOOL.spawnSubagent,
    label: "Delegate to subagent",
    description:
      "Start a subagent that does the task end to end and reports in the task's thread. Grant the fewest capabilities that can do the job.",
    parameters: {
      type: "object",
      properties: {
        taskId: TASK_ID,
        goal: {
          type: "string",
          description: "One sentence naming the concrete outcome.",
        },
        instructions: {
          type: "string",
          description:
            "Constraints and context: specifics from the task and its notes, assumptions to make, what to hand back.",
        },
        capabilities: {
          type: "array",
          items: { type: "string", enum: [...CAPABILITIES] },
          uniqueItems: true,
          description: 'Minimal capabilities, e.g. ["web"] for research.',
        },
      },
      required: ["taskId", "goal", "capabilities"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Delegate: ${truncate(String(field(input, "goal")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const instructions = optionalString(args, "instructions", { maxLength: 8_000 });
        return textResult(
          await host.spawnSubagent({
            taskId: requireString(args, "taskId"),
            goal: requireString(args, "goal", { maxLength: 1_000 }),
            ...(instructions ? { instructions } : {}),
            capabilities: requireEnumArray(args, "capabilities", CAPABILITIES),
          }),
        );
      }),
  };

  const postComment: ToolSpec = {
    name: TOOL.postComment,
    label: "Comment on task",
    description:
      "Post a short comment in the task's thread; it also becomes the badge text next to the task.",
    parameters: {
      type: "object",
      properties: {
        taskId: TASK_ID,
        text: { type: "string", description: "1-2 sentences of markdown." },
        summary: {
          type: "string",
          description: "Badge text, at most 6 words. Defaults to a shortened comment.",
        },
      },
      required: ["taskId", "text"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Comment: ${truncate(String(field(input, "text")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const summary = optionalString(args, "summary", { maxLength: 200 });
        return textResult(
          await host.postComment({
            taskId: requireString(args, "taskId"),
            text: requireString(args, "text", { maxLength: 4_000 }),
            ...(summary ? { summary } : {}),
          }),
        );
      }),
  };

  const askUser: ToolSpec = {
    name: TOOL.askUser,
    label: "Ask the user",
    description:
      "Ask the user one short, specific question about a task. Only when the task is genuinely ambiguous and blocking.",
    parameters: {
      type: "object",
      properties: { taskId: TASK_ID, question: { type: "string" } },
      required: ["taskId", "question"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Ask: ${truncate(String(field(input, "question")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        return textResult(
          await host.askUser({
            taskId: requireString(args, "taskId"),
            question: requireString(args, "question", { maxLength: 2_000 }),
          }),
        );
      }),
  };

  const setStatus: ToolSpec = {
    name: TOOL.setTaskStatus,
    label: "Set task status",
    description:
      'Set a task\'s agent status: "ignored" (nothing digital to do), "done" (answered), "waiting_user", or "failed".',
    parameters: {
      type: "object",
      properties: {
        taskId: TASK_ID,
        status: { type: "string", enum: [...SETTABLE_TASK_STATUSES] },
        summary: { type: "string", description: "Optional badge text, at most 6 words." },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Mark task ${String(field(input, "status"))}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const summary = optionalString(args, "summary", { maxLength: 200 });
        return textResult(
          await host.setTaskStatus({
            taskId: requireString(args, "taskId"),
            status: requireEnum(args, "status", SETTABLE_TASK_STATUSES),
            ...(summary ? { summary } : {}),
          }),
        );
      }),
  };

  const messageSubagent: ToolSpec = {
    name: TOOL.messageSubagent,
    label: "Message subagent",
    description:
      "Send guidance to the subagent of a task (steers it while running, resumes it if it finished).",
    parameters: {
      type: "object",
      properties: { taskId: TASK_ID, text: { type: "string" } },
      required: ["taskId", "text"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Message subagent: ${truncate(String(field(input, "text")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        return textResult(
          await host.messageSubagent({
            taskId: requireString(args, "taskId"),
            text: requireString(args, "text", { maxLength: 8_000 }),
          }),
        );
      }),
  };

  const cancelSubagent: ToolSpec = {
    name: TOOL.cancelSubagent,
    label: "Cancel subagent",
    description: "Stop the subagent working on a task.",
    parameters: {
      type: "object",
      properties: { taskId: TASK_ID, reason: { type: "string" } },
      required: ["taskId", "reason"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Cancel subagent: ${truncate(String(field(input, "reason")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        return textResult(
          await host.cancelSubagent({
            taskId: requireString(args, "taskId"),
            reason: requireString(args, "reason", { maxLength: 1_000 }),
          }),
        );
      }),
  };

  const listTasks: ToolSpec = {
    name: TOOL.listTasks,
    label: "List tasks",
    description:
      "List the tasks on a daily note (default: today's) with ids, checkbox and agent status.",
    parameters: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault path of the note, e.g. Daily/2026-09-23.md.",
        },
      },
      additionalProperties: false,
    },
    safety: { readOnly: true, category: "read", describe: () => "List tasks" },
    execute: (input) =>
      guarded(async () => {
        const args = input === undefined || input === null ? {} : asInput(input);
        const notePath = optionalString(args, "notePath", { maxLength: 500 });
        return textResult(await host.listTasks(notePath ? { notePath } : {}));
      }),
  };

  const anchorLine: ToolSpec = {
    name: TOOL.anchorLine,
    label: "Attach a thread to a line",
    description:
      "Attach a thread to a line of the note that isn't a task (a question, a request, a heading) so the user gets a badge there. Returns an id that works as taskId with post_comment, set_task_status, ask_user, spawn_subagent and edit_note.",
    parameters: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault path of the note; defaults to today's daily note.",
        },
        line: {
          type: "integer",
          minimum: 1,
          description: "1-based line number from the note view.",
        },
        text: { type: "string", description: "The line's current text, as shown." },
      },
      required: ["line", "text"],
      additionalProperties: false,
    },
    safety: {
      ...INTERNAL,
      describe: (input) => `Attach a thread to ${truncate(String(field(input, "text")), 120)}`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const line = args.line;
        if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          throw new ToolInputError('"line" must be the 1-based line number from the note view.');
        }
        const notePath = optionalString(args, "notePath", { maxLength: 500 });
        return textResult(
          await host.anchorLine({
            ...(notePath ? { notePath } : {}),
            line,
            text: requireString(args, "text", { maxLength: 2_000 }),
          }),
        );
      }),
  };

  return [
    spawn,
    postComment,
    askUser,
    setStatus,
    messageSubagent,
    cancelSubagent,
    listTasks,
    anchorLine,
  ];
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? ((input as Record<string, unknown>)[key] ?? "")
    : "";
}
