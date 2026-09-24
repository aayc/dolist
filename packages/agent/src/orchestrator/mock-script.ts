import type { AgentScript } from "../harness/scripted";
import type { HarnessSessionOptions } from "../harness/types";
import { createFakeBrain, type FakeBrain } from "../testing/brain/brain";
import { createFakeAgentScript } from "../testing/script";

/**
 * The default script for `mode: "mock"`: the FakeBrain (`src/testing/brain`) run in-process. It
 * exercises the whole pipeline — triage, comments, subagents, streaming, artifacts, approvals via
 * `mock_irreversible_action` — without any network. The brain is sandboxed: it grants only web/files
 * and never calls tools with real-world reach, so mock mode stays harmless with a real execution
 * provider or connectors configured.
 */
export function createMockScript(
  options: { brain?: FakeBrain } = {},
): (options: HarnessSessionOptions) => AgentScript {
  return createFakeAgentScript(options.brain ?? createFakeBrain({ sandbox: true }));
}
