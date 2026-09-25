import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  buildSubagentKickoff,
  FINISH_NUDGE,
  formatSteerMessage,
  formatTaskUpdate,
} from "../../prompts/subagent";
import { isKickoff, parseKickoff, parseSteer } from "./kickoff";

const NOW = new Date(2026, 8, 23, 9, 0).getTime();
const line = fc
  .string({ minLength: 1, maxLength: 80 })
  .map((s) => s.replace(/[\r\n\u2028\u2029]/g, " "))
  .filter((s) => s.trim().length > 0);

describe("parseKickoff ⇄ buildSubagentKickoff", () => {
  test.prop([
    fc.record(
      {
        text: line,
        notes: fc.array(line, { maxLength: 4 }),
        goal: line,
        instructions: line,
        reassignment: fc.boolean(),
        retry: fc.boolean(),
        replies: fc.array(line, { maxLength: 2 }),
        uncertain: fc.array(line, { maxLength: 2 }),
      },
      { requiredKeys: ["text", "notes", "goal", "reassignment", "retry", "replies", "uncertain"] },
    ),
  ])("recovers task, notes, goal, instructions, flags, follow-ups and uncertain steps", (input) => {
    const text = buildSubagentKickoff({
      now: NOW,
      task: {
        text: input.text,
        notes: input.notes,
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-24",
      },
      goal: input.goal,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      followUps: input.replies.map((reply) => formatSteerMessage("user", reply)),
      reassignment: input.reassignment,
      retry: input.retry,
      uncertain: input.uncertain,
    });
    expect(isKickoff(text)).toBe(true);
    const parsed = parseKickoff(text)!;
    expect(parsed.uncertain).toEqual(input.uncertain);
    expect(parsed.task).toBe(input.text);
    expect(parsed.notes).toEqual(input.notes);
    expect(parsed.goal).toBe(input.goal);
    expect(parsed.instructions).toBe(input.instructions);
    expect(parsed.notePath).toBe("Daily/2026-09-23.md");
    expect(parsed.relativeDay).toBe("tomorrow");
    expect(parsed.reassignment).toBe(input.reassignment);
    expect(parsed.retry).toBe(input.retry);
    expect(parsed.followUps).toEqual(
      input.replies.map((reply) => ({ kind: "user_reply", text: reply })),
    );
  });

  it("reads the history block of a retry", () => {
    const text = buildSubagentKickoff({
      now: NOW,
      task: {
        text: "Book a table",
        notes: [],
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
      },
      goal: "Book a table",
      history:
        'History of this task\'s thread (last status: failed; oldest first):\n- Tool mock_irreversible_action (blocked) → "Blocked"\n- User: "hi"',
      retry: true,
    });
    const parsed = parseKickoff(text)!;
    expect(parsed.history).toEqual([
      'Tool mock_irreversible_action (blocked) → "Blocked"',
      'User: "hi"',
    ]);
    expect(parsed.retry).toBe(true);
  });
});

describe("parseSteer", () => {
  test.prop([line, fc.option(line, { nil: undefined }), fc.array(line, { maxLength: 3 })])(
    "recovers task edits",
    (now, previous, notes) => {
      const message = formatTaskUpdate({
        text: now,
        ...(previous !== undefined ? { previousText: previous } : {}),
        notes,
      });
      const [parsed] = parseSteer(message);
      expect(parsed).toEqual({
        kind: "task_update",
        text: now,
        ...(previous !== undefined && previous !== now ? { previousText: previous } : {}),
        notes,
      });
    },
  );

  test.prop([line])("recovers replies and orchestrator messages", (text) => {
    expect(parseSteer(formatSteerMessage("user", text))).toEqual([{ kind: "user_reply", text }]);
    expect(parseSteer(formatSteerMessage("orchestrator", text.trim()))).toEqual([
      { kind: "orchestrator", text: text.trim() },
    ]);
  });

  it("recognizes the finish nudge and splits joined messages", () => {
    expect(parseSteer(FINISH_NUDGE)).toEqual([{ kind: "nudge" }]);
    const joined = [formatSteerMessage("user", "a"), formatSteerMessage("user", "b")].join("\n\n");
    expect(parseSteer(joined)).toEqual([
      { kind: "user_reply", text: "a" },
      { kind: "user_reply", text: "b" },
    ]);
    expect(parseSteer("   ")).toEqual([]);
  });
});
