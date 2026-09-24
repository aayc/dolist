/**
 * The Cursor harness gates tools the CLI runs itself (its web search and fetch) and its own
 * built-in file/shell tools without a ToolSpec. These pin that such calls get exactly the verdicts
 * our spec'd web tools and Pi's built-ins get.
 */
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { createWebTools } from "../tools/web";
import { createApprovalBroker } from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { WORKSPACE } from "./test-helpers";
import type { SafetyVerdict } from "./types";

function verdictsFor(requests: ToolCallRequest[]): Promise<SafetyVerdict[]> {
  const verdicts: SafetyVerdict[] = [];
  const approvals = createApprovalBroker({ defaultTimeoutMs: 1 });
  const gate = createSafetyGate({
    evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
    approvals,
    resolveContext: () => ({ taskId: "task-1", threadId: "thread-1", workspaceDir: WORKSPACE }),
    onVerdict: (_call, verdict) => verdicts.push(verdict),
    approvalTimeoutMs: 1,
  });
  return requests
    .reduce<Promise<unknown>>(
      (chain, request) => chain.then(() => gate(request)),
      Promise.resolve(),
    )
    .then(() => verdicts);
}

const request = (
  toolName: string,
  input: unknown,
  spec?: ToolCallRequest["spec"],
): ToolCallRequest => ({
  sessionId: "s",
  role: "subagent",
  toolCallId: "c",
  toolName,
  input,
  ...(spec ? { spec } : {}),
});

const WEB_INPUTS: Array<["web_search" | "web_fetch", Record<string, string>]> = [
  ["web_search", { query: "IANA example domain" }],
  ["web_search", { query: "is sk_test_EXAMPLEnotAREALkey0000 still valid" }],
  ["web_search", { query: "4111 1111 1111 1111 cvv 123" }],
  ["web_fetch", { url: "https://example.com/guide" }],
  ["web_fetch", { url: "http://127.0.0.1:7331/api/notes" }],
  ["web_fetch", { url: "http://192.168.1.10/admin" }],
  ["web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }],
  ["web_fetch", { url: "file:///etc/passwd" }],
  ["web_fetch", { url: "https://example.com/unsubscribe?u=1" }],
];

describe("tool calls from the Cursor harness", () => {
  it("gates the CLI's web search and fetch exactly like our web tools", async () => {
    const specs = new Map(createWebTools().map((tool) => [tool.name, tool]));
    const withSpec = await verdictsFor(
      WEB_INPUTS.map(([name, input]) => request(name, input, specs.get(name))),
    );
    const withoutSpec = await verdictsFor(WEB_INPUTS.map(([name, input]) => request(name, input)));
    const summary = (verdicts: SafetyVerdict[]) =>
      verdicts.map(({ decision, categories, matchedRules }) => ({
        decision,
        categories,
        matchedRules,
      }));
    expect(summary(withoutSpec)).toEqual(summary(withSpec));
    expect(withoutSpec.map((v) => v.decision)).toEqual([
      "allow",
      "require_approval",
      "require_approval",
      "allow",
      "deny",
      "require_approval",
      "require_approval",
      "deny",
      "require_approval",
    ]);
  });

  it("applies the built-in rules to the harness's own file and shell tools", async () => {
    const verdicts = await verdictsFor([
      request("read", { path: "notes/today.md" }),
      request("read", { path: "~/.ssh/id_ed25519" }),
      request("write", { path: "draft.md", content: "# Draft" }),
      request("write", { path: "~/.zshrc", content: "alias ls='rm -rf ~'" }),
      request("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] }),
      request("bash", { command: "ls -la" }),
      request("bash", { command: "rm -rf ~" }),
    ]);
    expect(verdicts.map((v) => v.decision)).toEqual([
      "allow",
      "deny",
      "allow",
      "require_approval",
      "allow",
      "allow",
      "deny",
    ]);
  });
});
