import { readFileSync } from "node:fs";
import { addDays, today, toISODate } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { Capability } from "../../execution/types";
import { formatOrchestratorDigest } from "../../prompts/orchestrator";
import { parseDigest } from "./digest";
import { planDirect } from "./direct";
import { evaluateArithmetic, grantableCapabilities, quickAnswer, triage } from "./intent";

interface TriageCase {
  id: string;
  task: string;
  notes?: string[];
  expected: "delegate" | "comment" | "ask_user" | "ignore" | "drop" | "forward" | "reply";
  acceptable?: string[];
  capabilities?: Capability[];
  computerAccess?: "missing";
  direct?: string;
  agentStatus?: "working" | "done" | "waiting_user";
}

const DATASET = new URL("../../../../../evals/datasets/triage.jsonl", import.meta.url);
/** The desktop apps the eval's digest lists. */
const DESKTOP_APPS: string[] = JSON.parse(
  readFileSync(
    new URL("../../../../../evals/datasets/triage-desktop-apps.json", import.meta.url),
    "utf8",
  ),
);
const OUTCOME = {
  delegate: "delegate",
  answer: "comment",
  ask: "ask_user",
  ignore: "ignore",
} as const;

describe("triage against the eval dataset", () => {
  const cases: TriageCase[] = readFileSync(DATASET, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TriageCase);
  const todayIso = toISODate(today());

  it("matches the expected (or an acceptable) decision and capabilities for every case", () => {
    const misses: string[] = [];
    for (const c of cases.filter((c) => c.direct === undefined)) {
      const text = c.task.replace(/\{\{\+(\d+)d\}\}/g, (_, days: string) =>
        toISODate(addDays(today(), Number(days))),
      );
      const decision = triage({
        text,
        notes: c.notes ?? [],
        today: todayIso,
        desktopApps: DESKTOP_APPS,
      });
      // Without computer access the orchestrator asks the user to allow it instead (a comment).
      const needsAccess =
        decision.kind === "delegate" &&
        decision.capabilities.includes("computer") &&
        c.computerAccess === "missing";
      const outcome = needsAccess ? "comment" : OUTCOME[decision.kind];
      if (![c.expected, ...(c.acceptable ?? [])].includes(outcome)) {
        misses.push(`${c.id}: got ${outcome}, expected ${c.expected}`);
        continue;
      }
      if (decision.kind === "delegate" && c.capabilities) {
        const missing = c.capabilities.filter((cap) => !decision.capabilities.includes(cap));
        if (missing.length > 0) misses.push(`${c.id}: missing capabilities ${missing.join(", ")}`);
      }
    }
    expect(cases.length).toBeGreaterThan(50);
    expect(misses).toEqual([]);
  });

  it("handles every direct message to the orchestrator the way the case expects", () => {
    const direct = cases.filter((c) => c.direct !== undefined);
    const outcomes = direct.map((c) => {
      const status = c.agentStatus ?? "working";
      const digest = formatOrchestratorDigest({
        now: Date.now(),
        notes: [
          {
            notePath: "Daily/2026-09-23.md",
            date: todayIso,
            changed: [],
            others: [
              { taskId: "tsk_case", text: c.task, notes: [], agentStatus: status },
              { taskId: "tsk_filler", text: "Reply to Alex about the offsite", notes: [] },
            ],
          },
        ],
        replies: [],
        reports: [],
        direct: [c.direct!],
        subagents: [
          ...(status === "working"
            ? [{ taskId: "tsk_case", taskText: c.task, status: "working" as const }]
            : []),
          { taskId: "tsk_filler", taskText: "Reply to Alex about the offsite", status: "working" },
        ],
        capabilities: { available: ["web"], unavailable: [], connectors: [] },
      });
      const plan = planDirect(parseDigest(digest), [], false);
      const own = plan.calls.filter(
        (call) => (call.arguments as { taskId?: string }).taskId === "tsk_case",
      );
      const outcome = own.some((call) => call.name === "message_subagent")
        ? "forward"
        : own.length > 0
          ? "drop"
          : plan.reply
            ? "reply"
            : "nothing";
      return `${c.id}: ${outcome}`;
    });
    expect(direct.length).toBeGreaterThanOrEqual(6);
    expect(outcomes).toEqual(direct.map((c) => `${c.id}: ${c.expected}`));
  });
});

describe("grantableCapabilities", () => {
  it("grants what is wanted and available, else the closest substitute, within the allowed set", () => {
    expect(grantableCapabilities(["browser"], ["web", "browser"])).toEqual(["browser"]);
    expect(grantableCapabilities(["browser"], ["web", "files"])).toEqual(["web"]);
    expect(grantableCapabilities(["connectors"], ["files"])).toEqual(["files"]);
    expect(
      grantableCapabilities(["shell", "files"], ["shell", "files", "web"], ["web", "files"]),
    ).toEqual(["files"]);
    expect(grantableCapabilities(["browser"], [])).toEqual([]);
  });

  test.prop([
    fc.uniqueArray(
      fc.constantFrom<Capability>("web", "browser", "computer", "shell", "files", "connectors"),
    ),
    fc.uniqueArray(
      fc.constantFrom<Capability>("web", "browser", "computer", "shell", "files", "connectors"),
    ),
  ])("never grants anything unavailable", (desired, available) => {
    for (const cap of grantableCapabilities(desired, available)) expect(available).toContain(cap);
  });
});

describe("quick answers", () => {
  it("answers common questions offline", () => {
    expect(quickAnswer("What's the capital of Australia?")).toEqual({
      answer: "Canberra.",
      summary: "Canberra",
    });
    expect(quickAnswer("Calculate an 18% tip on $86.40")?.answer).toBe("$15.55 (total $101.95).");
    expect(quickAnswer("Convert 10 km to miles")?.summary).toBe("6.21 miles");
    expect(quickAnswer("What is 2 + 3 * 4?")?.answer).toBe("2 + 3 * 4 = 14.");
    expect(quickAnswer("What time does Costco close today?")).toBeUndefined();
  });

  test.prop([
    fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 6 }),
    fc.array(fc.constantFrom("+", "-", "*"), { maxLength: 5 }),
  ])("evaluates + - * like JavaScript", (numbers, ops) => {
    const parts = [String(numbers[0])];
    for (const [i, n] of numbers.slice(1).entries()) {
      parts.push(ops[i % Math.max(1, ops.length)] ?? "+", String(n));
    }
    const expression = parts.join(" ");
    // biome-ignore lint/security/noGlobalEval: reference implementation for digits and + - * only.
    expect(evaluateArithmetic(expression)).toBe(eval(expression));
  });

  it("rejects anything that isn't plain arithmetic", () => {
    expect(evaluateArithmetic("2 + ")).toBeUndefined();
    expect(evaluateArithmetic("process.exit()")).toBeUndefined();
    expect(evaluateArithmetic("1 / 0")).toBeUndefined();
    expect(evaluateArithmetic("(1 + 2")).toBeUndefined();
    expect(evaluateArithmetic("-(3 * 4) + 20 / 5")).toBe(-8);
  });
});
