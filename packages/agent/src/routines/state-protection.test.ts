/**
 * Agents drive the scheduler only through the gated routine tools: its state (next runs, last
 * results, today's extra runs) lives in `.daily-do-list/state/routines.json`, and every way of
 * writing, deleting or moving it is a hard deny under every policy, "Run everything" included.
 */
import { APPROVAL_POLICIES } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { createApprovalBroker } from "../safety/approvals";
import { createSafetyEvaluator } from "../safety/evaluator";
import { createSafetyGate } from "../safety/gate";
import { WORKSPACE } from "../safety/test-helpers";
import type { SafetyVerdict } from "../safety/types";
import { TOOL } from "../tools/contracts";
import { ROUTINES_STATE_PATH } from "./state";

const VAULT = "/Users/me/DailyDoList";
const STATE = `${VAULT}/${ROUTINES_STATE_PATH}`;
const FORGED = JSON.stringify({
  version: 1,
  routines: { rtn_1: { extraRuns: { date: "2026-09-23", count: 0 }, nextRunAt: 0 } },
});

const ATTEMPTS: Array<{ name: string; toolName: string; input: unknown; rule: string }> = [
  {
    name: "reset today's extra runs",
    toolName: TOOL.write,
    input: { path: STATE, content: FORGED },
    rule: "secrets.app-config-write",
  },
  {
    name: "move the next run up",
    toolName: TOOL.edit,
    input: { path: STATE, oldText: '"nextRunAt":1790', newText: '"nextRunAt":0' },
    rule: "secrets.app-config-write",
  },
  {
    name: "write it through a connector's file tool",
    toolName: "mcp__fs__write_file",
    input: { path: ROUTINES_STATE_PATH, content: FORGED },
    rule: "secrets.app-config-write",
  },
  {
    name: "edit it as a note",
    toolName: TOOL.editNote,
    input: { notePath: ROUTINES_STATE_PATH, edits: [{ op: "append", text: "{}", mine: true }] },
    rule: "notes.edit.hidden-path",
  },
  {
    name: "redirect into it",
    toolName: TOOL.bash,
    input: { command: `echo '${FORGED}' > ${STATE}` },
    rule: "secrets.app-config-write",
  },
  {
    name: "delete it (forgetting every last run and budget)",
    toolName: TOOL.bash,
    input: { command: `rm ${STATE}` },
    rule: "secrets.app-config-write",
  },
  {
    name: "move it away",
    toolName: TOOL.bash,
    input: { command: `cd ${VAULT} && mv .daily-do-list/state/routines.json /tmp/` },
    rule: "secrets.app-config-write",
  },
  {
    name: "rewrite it from inline Python",
    toolName: TOOL.bash,
    input: { command: `python3 -c "open('${STATE}','w').write('{}')"` },
    rule: "secrets.app-config-write",
  },
  {
    name: "climb out of the workspace into it",
    toolName: TOOL.write,
    input: { path: `${WORKSPACE}/../../../DailyDoList/${ROUTINES_STATE_PATH}`, content: "{}" },
    rule: "secrets.app-config-write",
  },
];

function call(toolName: string, input: unknown): ToolCallRequest {
  return { sessionId: "session-1", role: "subagent", toolCallId: "call-1", toolName, input };
}

describe("agents can't write the routine scheduler's state", () => {
  it.each(ATTEMPTS.map((a) => [a.name, a] as const))(
    "%s: denied under every policy without asking",
    async (_name, attempt) => {
      for (const policy of APPROVAL_POLICIES) {
        const approvals = createApprovalBroker();
        const verdicts: SafetyVerdict[] = [];
        const gate = createSafetyGate({
          evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
          approvals,
          resolveContext: () => ({
            taskId: "run_1",
            threadId: "thread-1",
            taskText: "Run the routine “Morning briefing”",
            workspaceDir: WORKSPACE,
          }),
          approvalPolicy: () => policy,
          onVerdict: (_call, verdict) => verdicts.push(verdict),
        });
        const decision = await gate(call(attempt.toolName, attempt.input));
        expect(decision.allow, `${policy}: ${JSON.stringify(verdicts[0])}`).toBe(false);
        expect(approvals.list(), policy).toEqual([]);
        expect(verdicts[0], policy).toMatchObject({ decision: "deny" });
        expect(verdicts[0]?.matchedRules, policy).toContain(attempt.rule);
      }
    },
  );

  it("offers agents no tool that touches the scheduler's state", () => {
    const routineTools: string[] = [
      TOOL.createRoutine,
      TOOL.updateRoutine,
      TOOL.runRoutine,
      TOOL.listRoutines,
    ];
    for (const name of Object.values(TOOL)) {
      if (routineTools.includes(name)) continue;
      expect(name).not.toMatch(/routine|schedul|budget/i);
    }
  });
});
