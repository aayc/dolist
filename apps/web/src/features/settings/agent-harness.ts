import {
  type AgentHarnessKind,
  type AgentSettings,
  DEFAULT_CURSOR_DEEP_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_MODEL,
} from "@ddl/core";

type ModelKey =
  | "model"
  | "orchestratorModel"
  | "deepModel"
  | "cursorModel"
  | "cursorOrchestratorModel"
  | "cursorDeepModel";

export type ModelRole = "subagent" | "orchestrator" | "deep";

/** Settings → Agent's model fields for each harness: subagents, the orchestrator, hard tasks. */
export const MODEL_FIELDS: Record<
  AgentHarnessKind,
  ReadonlyArray<{ role: ModelRole; key: ModelKey; placeholder: string; testId: string }>
> = {
  pi: [
    { role: "subagent", key: "model", placeholder: DEFAULT_MODEL, testId: "setting-model" },
    {
      role: "orchestrator",
      key: "orchestratorModel",
      placeholder: DEFAULT_MODEL,
      testId: "setting-orchestrator-model",
    },
    { role: "deep", key: "deepModel", placeholder: DEFAULT_MODEL, testId: "setting-deep-model" },
  ],
  cursor: [
    {
      role: "subagent",
      key: "cursorModel",
      placeholder: DEFAULT_CURSOR_MODEL,
      testId: "setting-cursor-model",
    },
    {
      role: "orchestrator",
      key: "cursorOrchestratorModel",
      placeholder: DEFAULT_CURSOR_MODEL,
      testId: "setting-cursor-orchestrator-model",
    },
    {
      role: "deep",
      key: "cursorDeepModel",
      placeholder: DEFAULT_CURSOR_DEEP_MODEL,
      testId: "setting-cursor-deep-model",
    },
  ],
};

export const MODEL_ROLE_TEXT: Record<ModelRole, { name: string; description: string }> = {
  subagent: { name: "Subagent model", description: "Does the work on each task." },
  orchestrator: {
    name: "Orchestrator model",
    description: "Decides what to do with each line. A fast model keeps the note responsive.",
  },
  deep: {
    name: "Hard-task model",
    description: "For tasks the orchestrator marks hard, like in-depth research. A stronger model.",
  },
};

/** The choices of Settings → Agent → Agent, one per harness. */
export const HARNESS_OPTIONS: ReadonlyArray<{ kind: AgentHarnessKind; label: string }> = [
  { kind: "pi", label: "Pi · OpenRouter model" },
  { kind: "cursor", label: "Cursor CLI · your Cursor account" },
];

/**
 * The harness settings show as selected. A harness added by a newer daemon shows as Pi, the way
 * `agentModel` treats it; nothing is saved unless the user picks one.
 */
export function shownHarness(agent: Pick<AgentSettings, "harness">): AgentHarnessKind {
  return agent.harness === "cursor" ? "cursor" : "pi";
}
