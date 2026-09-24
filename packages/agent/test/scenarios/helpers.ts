/**
 * Vitest glue for the scenario matrix: tracks fake runtimes for cleanup and bundles the invariant
 * checks every scenario ends with.
 */
import type { TaskAgentStatus } from "@ddl/core";
import { afterEach, expect, vi } from "vitest";
import {
  type BrainMatcher,
  createFakeAgentRuntime,
  type FakeAgentRuntime,
  type FakeAgentRuntimeOptions,
} from "../../src/testing";

const active: FakeAgentRuntime[] = [];

/**
 * Registers cleanup of every runtime created with `fakeRuntime` in the calling test file. Scenarios
 * take milliseconds; the higher timeout is headroom for a saturated full-suite run.
 */
export function useFakeRuntimes(): void {
  vi.setConfig({ testTimeout: 15_000 });
  afterEach(async () => {
    for (const t of active.splice(0)) await t.stop();
  });
}

export async function fakeRuntime(
  options: FakeAgentRuntimeOptions = {},
): Promise<FakeAgentRuntime> {
  const t = await createFakeAgentRuntime(options);
  active.push(t);
  return t;
}

/** Brain matcher for the subagent working on one task (its kickoff names the task). */
export function subagentFor(text: string): BrainMatcher {
  return (request, info) =>
    info.role === "subagent" &&
    request.messages.some(
      (m) => m.role === "user" && m.content.includes(`Task: ${JSON.stringify(text)}`),
    );
}

/** Every executed tool passed the gate, and nothing the gate blocked ran. */
export function expectAllGated(t: FakeAgentRuntime): void {
  expect(t.audit.ungated()).toEqual([]);
}

export function isSubsequence<T>(needle: readonly T[], haystack: readonly T[]): boolean {
  let i = 0;
  for (const item of haystack) if (item === needle[i]) i++;
  return i === needle.length;
}

export function expectStatuses(
  t: FakeAgentRuntime,
  text: string,
  expected: readonly TaskAgentStatus[],
): void {
  const seen = t.statusesOf(text);
  expect(isSubsequence(expected, seen), `statuses of "${text}": ${seen.join(" → ")}`).toBe(true);
}

/** Tool names the gate saw for one task's thread (subagent calls), in order. */
export function gatedToolsOf(t: FakeAgentRuntime, text: string): string[] {
  const threadId = t.thread(text).id;
  return t.audit.gate.filter((g) => g.sessionId.startsWith(threadId)).map((g) => g.toolName);
}

/** Tool names the orchestrator called through the gate for a task. */
export function orchestratorCallsFor(t: FakeAgentRuntime, text: string): string[] {
  const taskId = t.record(text)?.taskId;
  return t.audit.gate
    .filter((g) => g.sessionId.startsWith("orchestrator:"))
    .filter((g) => (g.input as { taskId?: string } | undefined)?.taskId === taskId)
    .map((g) => g.toolName);
}
