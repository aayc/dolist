import type { ToolSafetyHints } from "@ddl/core";
import { createSafetyEvaluator } from "./evaluator";
import type { ActionContext, SafetyEvaluatorOptions, SafetyVerdict } from "./types";

/** A synthetic task workspace; nothing is ever read from or written to it. */
export const WORKSPACE = "/Users/me/.daily-do-list/workspaces/task-1";

export function actionContext(
  toolName: string,
  input: unknown,
  extra: Partial<ActionContext> = {},
): ActionContext {
  return {
    toolName,
    input,
    hints: {} as ToolSafetyHints,
    role: "subagent",
    taskId: "task-1",
    threadId: "thread-1",
    taskText: "Research options and report back",
    workspaceDir: WORKSPACE,
    ...extra,
  };
}

/** Rules-only evaluation (no LLM judge), the way mock mode runs. */
export function evaluateRules(
  toolName: string,
  input: unknown,
  extra: Partial<ActionContext> = {},
  options: SafetyEvaluatorOptions = {},
): Promise<SafetyVerdict> {
  const evaluator = createSafetyEvaluator({
    ...options,
    policy: { llmJudge: false, ...options.policy },
  });
  return evaluator.evaluate(actionContext(toolName, input, extra));
}

export function bash(command: string, extra: Partial<ActionContext> = {}): Promise<SafetyVerdict> {
  return evaluateRules("bash", { command }, extra);
}
