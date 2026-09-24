import type { AgentHarnessKind, AgentSettings } from "@ddl/core";

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
