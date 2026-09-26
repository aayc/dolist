/**
 * Test utilities for the agent system (`@ddl/agent/testing`): the FakeBrain (a deterministic
 * stand-in for the model), the HTTP fake of OpenRouter, the in-process script, `brainResponder`
 * (the brain behind a `MockLlmClient`), fake web/browser/execution/connectors, and
 * `createFakeAgentRuntime`. Never imported by production
 * code, except the brain and script, which power `DDL_AGENT_MODE=mock`. See README.md.
 */
export {
  createFakeAgentRuntime,
  type ExecutionRecord,
  type FakeAgentRuntime,
  type FakeAgentRuntimeOptions,
  type FakeVia,
  type GateRecord,
  type RuntimeEvent,
  type ToolAudit,
  type WaitOptions,
} from "./agent-runtime";
export {
  type ArgsCorruption,
  createFakeBrain,
  DEFAULT_DISCLAIMER,
  FakeBrain,
  type FakeBrainOptions,
  type FaultOptions,
  type RuleOptions,
  type TurnFactory,
} from "./brain/brain";
export { isDigest, type ParsedDigest, parseDigest } from "./brain/digest";
export {
  desiredCapabilities,
  grantableCapabilities,
  quickAnswer,
  type TriageDecision,
  triage,
} from "./brain/intent";
export { judgeVerdict, parseJudgePrompt } from "./brain/judge";
export {
  isKickoff,
  type ParsedKickoff,
  parseKickoff,
  parseSteer,
  type SteerMessage,
} from "./brain/kickoff";
export { classifyResult, detectRole } from "./brain/transcript";
export type * from "./brain/types";
export { type FlowchartSpec, flowchartDrawing, flowchartScene } from "./drawings";
export {
  FAKE_OPENROUTER_KEY,
  type FakeEndpoint,
  type FakeOpenRouter,
  type FakeOpenRouterOptions,
  type InjectOptions,
  type RecordedRequest,
  type ServerFault,
  startFakeOpenRouter,
} from "./fake-openrouter";
export {
  type BrowserEffect,
  brainResponder,
  createFakeBrowser,
  createFakeConnectors,
  createFakeExecution,
  createFakeWeb,
  createFakeWebTools,
  type FakeBrowser,
  type FakeConnectorServer,
  type FakeConnectors,
  type FakeExecution,
  type FakeExecutionOptions,
  type FakePage,
  type FakeWeb,
  type SentMessage,
} from "./fakes";
export { synthesizeJson, validateJson } from "./json-schema";
export {
  createFakeAgentScript,
  type FakeAgentScriptOptions,
  modelText,
  type ScriptToolEvent,
} from "./script";
export { brainRequestFromChat, chatCompletionBody, chatCompletionChunks, splitText } from "./wire";
