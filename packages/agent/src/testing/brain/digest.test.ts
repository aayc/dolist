import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  type DigestChange,
  type DigestNote,
  formatOrchestratorDigest,
  type OrchestratorDigest,
} from "../../prompts/orchestrator";
import { isDigest, parseDigest } from "./digest";

const NOW = new Date(2026, 8, 23, 18, 31).getTime();
const CHECKBOX_CHARS: Record<string, string> = {
  open: " ",
  done: "x",
  in_progress: "/",
  cancelled: "-",
  deferred: ">",
};

/** Text that survives `quote()` untruncated: tricky characters, no line breaks. */
const text = fc
  .array(
    fc.oneof(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.constantFrom(
        '"',
        "\\",
        " (was: ",
        " (subtask of ",
        "] ",
        "[x]",
        " · agent: ",
        " — ",
        "…",
        "🌱",
        "é",
        "\t",
      ),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.join("").replace(/[\r\n\u2028\u2029]/g, " "))
  .filter((s) => s.trim().length > 0 && s.length <= 150);

const taskId = fc.stringMatching(/^tsk_[a-z0-9]{6,10}$/);
const change = fc.constantFrom<DigestChange>("added", "updated", "reopened", "retry");
const status = fc.constantFrom(
  "triaging",
  "queued",
  "working",
  "done",
  "failed",
  "ignored",
  "waiting_user",
);
const checkbox = fc.constantFrom("open", "done", "cancelled", "in_progress", "deferred");

const viewLines = fc
  .array(
    fc.record({
      text: fc.oneof(
        text,
        fc.constant(""),
        text.map((t) => `  - ${t}`),
      ),
      id: fc.option(fc.oneof(taskId, fc.stringMatching(/^anc_[a-z0-9]{6,10}$/)), {
        nil: undefined,
      }),
      agent: fc.boolean(),
      agentStatus: fc.option(status, { nil: undefined }),
      agentSummary: fc.option(text, { nil: undefined }),
    }),
    { maxLength: 8 },
  )
  .map((lines) =>
    lines.map((line, i) => ({
      n: i + 1,
      text: line.text,
      ...(line.id?.startsWith("anc_") ? { anchorId: line.id } : line.id ? { taskId: line.id } : {}),
      ...(line.agent ? { agent: true } : {}),
      ...(line.agentStatus ? { agentStatus: line.agentStatus } : {}),
      ...(line.agentStatus && line.agentSummary ? { agentSummary: line.agentSummary } : {}),
    })),
  );

const note: fc.Arbitrary<DigestNote> = fc.record({
  notePath: fc.constantFrom("Daily/2026-09-23.md", "Daily/2026-09-24.md", "Daily/2026-09-20.md"),
  date: fc.constantFrom("2026-09-23", "2026-09-24", "2026-09-20", null),
  changedLines: fc.array(fc.record({ n: fc.integer({ min: 1, max: 500 }), text }), {
    maxLength: 3,
  }),
  view: viewLines,
  changed: fc.array(
    fc.record(
      {
        taskId,
        text,
        change,
        notes: fc.array(text, { maxLength: 3 }),
        previousText: text,
        parentText: text,
      },
      { requiredKeys: ["taskId", "text", "change", "notes"] },
    ),
    { maxLength: 4 },
  ),
  others: fc.array(
    fc.record(
      { taskId, text, notes: fc.constant([]), checkbox, agentStatus: status, agentSummary: text },
      { requiredKeys: ["taskId", "text", "notes"] },
    ),
    { maxLength: 4 },
  ),
}) as fc.Arbitrary<DigestNote>;

const digest: fc.Arbitrary<OrchestratorDigest> = fc.record({
  now: fc.constant(NOW),
  notes: fc.array(note, { maxLength: 3 }),
  replies: fc.array(
    fc.record(
      { taskId: fc.option(taskId, { nil: null }), text, taskText: text },
      { requiredKeys: ["taskId", "text"] },
    ),
    { maxLength: 3 },
  ),
  reports: fc.array(
    fc.record(
      { taskId, taskText: text, status, summary: text },
      { requiredKeys: ["taskId", "taskText", "status"] },
    ),
    { maxLength: 3 },
  ),
  subagents: fc.array(
    fc.record(
      {
        taskId,
        taskText: text,
        status,
        runningForMs: fc.integer({ min: 0, max: 5 * 3_600_000 }),
        summary: text,
      },
      { requiredKeys: ["taskId", "taskText", "status"] },
    ),
    { maxLength: 3 },
  ),
  capabilities: fc.record({
    available: fc.uniqueArray(
      fc.constantFrom("web", "browser", "computer", "shell", "files", "connectors"),
      { maxLength: 6 },
    ),
    unavailable: fc.uniqueArray(
      fc.constantFrom("web", "browser", "computer", "shell", "files", "connectors"),
      { maxLength: 6 },
    ),
    connectors: fc.array(
      fc.record({
        name: fc.stringMatching(/^[a-z][a-z0-9-]{1,12}$/),
        state: fc.constantFrom("connected", "idle", "error"),
        toolCount: fc.nat(40),
      }),
      { maxLength: 3 },
    ),
  }),
}) as fc.Arbitrary<OrchestratorDigest>;

describe("parseDigest ⇄ formatOrchestratorDigest", () => {
  test.prop([digest])("round-trips every field the formatter writes", (input) => {
    const text = formatOrchestratorDigest(input);
    expect(isDigest(text)).toBe(true);
    const parsed = parseDigest(text);
    expect(parsed.today).toBe("2026-09-23");
    expect(parsed.notes.map((n) => n.notePath)).toEqual(input.notes.map((n) => n.notePath));
    input.notes.forEach((inputNote, i) => {
      const out = parsed.notes[i]!;
      expect(out.changed).toEqual(
        inputNote.changed.map((task) => ({
          change: task.change,
          taskId: task.taskId,
          text: task.text,
          notes: task.notes.slice(0, 20),
          ...(task.previousText !== undefined && task.previousText !== task.text
            ? { previousText: task.previousText }
            : {}),
          ...(task.parentText ? { parentText: task.parentText } : {}),
        })),
      );
      expect(
        out.others.map((o) => [o.taskId, o.checkbox, o.text, o.agentStatus, o.agentSummary]),
      ).toEqual(
        inputNote.others.map((o) => [
          o.taskId,
          o.checkbox ? CHECKBOX_CHARS[o.checkbox] : undefined,
          o.text,
          o.agentStatus,
          o.agentSummary,
        ]),
      );
      expect(out.changedLines).toEqual(inputNote.changedLines ?? []);
      const view = [...(inputNote.view ?? [])];
      while (view.length > 0 && view.at(-1)!.text.trim() === "") view.pop();
      expect(out.view).toEqual(
        view.map((line) => ({
          n: line.n,
          text: line.text,
          ...(line.taskId || line.anchorId ? { id: line.taskId ?? line.anchorId } : {}),
          ...(line.agentStatus ? { agentStatus: line.agentStatus } : {}),
          ...(line.agentSummary ? { agentSummary: line.agentSummary } : {}),
          ...(line.agent ? { agent: true } : {}),
        })),
      );
    });
    expect(parsed.replies).toEqual(
      input.replies.map((r) => ({
        taskId: r.taskId,
        text: r.text,
        ...(r.taskText ? { taskText: r.taskText } : {}),
      })),
    );
    expect(parsed.reports).toEqual(
      input.reports.map((r) => ({
        taskId: r.taskId,
        status: r.status,
        taskText: r.taskText,
        ...(r.summary ? { summary: r.summary } : {}),
      })),
    );
    expect(parsed.subagents.map((s) => [s.taskId, s.taskText, s.status, s.summary])).toEqual(
      input.subagents.map((s) => [s.taskId, s.taskText, s.status, s.summary]),
    );
    expect(parsed.capabilities.available).toEqual(input.capabilities.available);
    expect(parsed.capabilities.unavailable).toEqual(input.capabilities.unavailable);
    expect(parsed.capabilities.connectors).toEqual(input.capabilities.connectors);
  });

  it("parses a realistic digest", () => {
    const text = formatOrchestratorDigest({
      now: NOW,
      notes: [
        {
          notePath: "Daily/2026-09-23.md",
          date: "2026-09-23",
          changed: [
            { taskId: "tsk_a", text: "Book dentist", change: "added", notes: ["prefer mornings"] },
            {
              taskId: "tsk_b",
              text: "Book flights",
              change: "updated",
              previousText: "Book flight",
              parentText: "Plan trip",
              notes: [],
            },
          ],
          others: [
            {
              taskId: "tsk_c",
              text: "Paid rent",
              checkbox: "done",
              notes: [],
              agentStatus: "ignored",
            },
          ],
        },
      ],
      replies: [{ taskId: "tsk_d", text: "the tax form", taskText: "Figure out the thing" }],
      reports: [
        { taskId: "tsk_e", taskText: "Compare desks", status: "done", summary: "3 desks compared" },
      ],
      subagents: [
        { taskId: "tsk_f", taskText: "Order ink", status: "working", runningForMs: 90_000 },
      ],
      capabilities: {
        available: ["web", "files"],
        unavailable: ["browser"],
        connectors: [{ name: "gmail", state: "connected", toolCount: 5 }],
      },
    });
    const parsed = parseDigest(text);
    expect(parsed.notes[0]).toMatchObject({
      notePath: "Daily/2026-09-23.md",
      relativeDay: "today",
      moreOthers: 0,
    });
    expect(parsed.notes[0]!.changed[1]).toEqual({
      change: "updated",
      taskId: "tsk_b",
      text: "Book flights",
      previousText: "Book flight",
      parentText: "Plan trip",
      notes: [],
    });
    expect(parsed.notes[0]!.others[0]).toEqual({
      taskId: "tsk_c",
      checkbox: "x",
      text: "Paid rent",
      agentStatus: "ignored",
    });
    expect(parsed.subagents[0]).toEqual({
      taskId: "tsk_f",
      taskText: "Order ink",
      status: "working",
      elapsed: "2m",
    });
    expect(parsed.capabilities.connectors).toEqual([
      { name: "gmail", state: "connected", toolCount: 5 },
    ]);
  });

  it("counts elided other tasks and rejects non-digests", () => {
    const others = Array.from({ length: 45 }, (_, i) => ({
      taskId: `tsk_${i}`,
      text: `Task ${i}`,
      notes: [],
    }));
    const text = formatOrchestratorDigest({
      now: NOW,
      notes: [{ notePath: "Daily/2026-09-23.md", date: "2026-09-23", changed: [], others }],
      replies: [],
      reports: [],
      subagents: [],
      capabilities: { available: [], unavailable: [], connectors: [] },
    });
    const parsed = parseDigest(text);
    expect(parsed.notes[0]!.others).toHaveLength(40);
    expect(parsed.notes[0]!.moreOthers).toBe(5);
    expect(parsed.capabilities).toEqual({ available: [], unavailable: [], connectors: [] });
    expect(isDigest('Task: "x"\nGoal: y\n\nStart now.')).toBe(false);
  });
});
