import { readFileSync } from "node:fs";
import { addDays, today, toISODate } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { Capability } from "../../execution/types";
import { evaluateArithmetic, grantableCapabilities, quickAnswer, triage } from "./intent";

interface TriageCase {
  id: string;
  task: string;
  notes?: string[];
  expected: "delegate" | "comment" | "ask_user" | "ignore";
  acceptable?: string[];
  capabilities?: Capability[];
}

const DATASET = new URL("../../../../../evals/datasets/triage.jsonl", import.meta.url);
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
    for (const c of cases) {
      const text = c.task.replace(/\{\{\+(\d+)d\}\}/g, (_, days: string) =>
        toISODate(addDays(today(), Number(days))),
      );
      const decision = triage({ text, notes: c.notes ?? [], today: todayIso });
      const outcome = OUTCOME[decision.kind];
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
