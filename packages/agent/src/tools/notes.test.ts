import { emptyDrawingScene, serializeDrawingFile, toolResultText } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { evaluateRules } from "../safety/test-helpers";
import {
  createNoteEditTool,
  describeNoteEdit,
  type NoteItemLocation,
  planNoteEdits,
} from "./notes";

const NOTE = [
  "# Thursday",
  "- [ ] Book a table for Friday dinner",
  "  - for 2, somewhere Italian",
  "- [ ] Renew passport",
  "What's the tallest building in NYC?",
  "",
].join("\n");

const tasks: Record<string, { line: number; text: string }> = {
  tsk_table: { line: 1, text: "Book a table for Friday dinner" },
  tsk_passport: { line: 3, text: "Renew passport" },
  anc_question: { line: 4, text: "What's the tallest building in NYC?" },
};
const locate = (id: string) => tasks[id] ?? null;
const plan = (edits: Parameters<typeof planNoteEdits>[1], threadId: string | null = "thr_1") =>
  planNoteEdits(NOTE, edits, { threadId, locate });

describe("planNoteEdits", () => {
  it("adds sub-bullets after a task's existing ones, signed with the thread", () => {
    const result = plan([
      {
        op: "add_under",
        taskId: "tsk_table",
        lines: ["Trattoria Sole has a table at 7 PM ([OpenTable](https://example.com/t))"],
      },
    ]);
    expect(result.content.split("\n").slice(1, 4)).toEqual([
      "- [ ] Book a table for Friday dinner",
      "  - for 2, somewhere Italian",
      "  - Trattoria Sole has a table at 7 PM ([OpenTable](https://example.com/t)) %%agent:thr_1%%",
    ]);
    expect(result.changes).toEqual(['added 1 line under "Book a table for Friday dinner"']);
  });

  it("indents the first child of a task two spaces and keeps given list markers", () => {
    const result = plan([
      {
        op: "add_under",
        taskId: "tsk_passport",
        lines: ["- [ ] Book a photo booth slot", "Bring the old passport"],
      },
    ]);
    expect(result.content.split("\n").slice(3, 6)).toEqual([
      "- [ ] Renew passport",
      "  - [ ] Book a photo booth slot %%agent:thr_1%%",
      "  - Bring the old passport %%agent:thr_1%%",
    ]);
  });

  it("answers under a question line, after its earlier answers", () => {
    const once = plan([
      { op: "add_under", taskId: "anc_question", lines: ["One World Trade Center, 541 m"] },
    ]);
    const twice = planNoteEdits(
      once.content,
      [{ op: "add_under", taskId: "anc_question", lines: ["(Source: CTBUH)"] }],
      {
        threadId: "thr_1",
        locate,
      },
    );
    expect(twice.content.split("\n").slice(4, 7)).toEqual([
      "What's the tallest building in NYC?",
      "One World Trade Center, 541 m %%agent:thr_1%%",
      "(Source: CTBUH) %%agent:thr_1%%",
    ]);
  });

  it("finds a quoted line near a miscounted number and appends at the end", () => {
    const result = plan(
      [
        {
          op: "insert_after",
          line: 3,
          expect: "- [ ] Renew passport",
          lines: ["- [ ] Pick up dry cleaning"],
        },
        { op: "append", lines: ["Notes from the agent"] },
      ],
      null,
    );
    const lines = result.content.split("\n");
    expect(lines[4]).toBe("- [ ] Pick up dry cleaning %%agent%%");
    expect(lines[6]).toBe("Notes from the agent %%agent%%");
    expect(lines[7]).toBe("");
  });

  it("rewrites and deletes its own lines, keeping indentation", () => {
    const withAgent = plan([
      { op: "add_under", taskId: "tsk_table", lines: ["Checking OpenTable…"] },
    ]).content;
    const result = planNoteEdits(
      withAgent,
      [
        {
          op: "replace",
          line: 4,
          expect: "- Checking OpenTable…",
          text: "- Booked for 7 PM",
          mine: true,
        },
      ],
      { threadId: "thr_1", locate },
    );
    expect(result.content.split("\n")[3]).toBe("  - Booked for 7 PM %%agent:thr_1%%");
    const deleted = planNoteEdits(
      result.content,
      [{ op: "delete", line: 4, expect: "- Booked for 7 PM", mine: true }],
      {
        threadId: "thr_1",
        locate,
      },
    );
    expect(deleted.content).toBe(NOTE);
  });

  it("refuses to treat the user's line as its own", () => {
    expect(() =>
      plan([{ op: "delete", line: 3, expect: "  - for 2, somewhere Italian", mine: true }]),
    ).toThrow(/written by the user/);
    expect(() =>
      plan([{ op: "set_checkbox", taskId: "tsk_table", checked: true, mine: true }]),
    ).toThrow(/written by the user/);
  });

  it("changes the user's lines when not claimed (the gate asks first)", () => {
    const result = plan([
      { op: "set_checkbox", taskId: "tsk_passport", checked: true },
      {
        op: "replace",
        line: 3,
        expect: "- for 2, somewhere Italian",
        text: "- for 4, somewhere Italian",
      },
    ]);
    const lines = result.content.split("\n");
    expect(lines[2]).toBe("  - for 4, somewhere Italian %%agent:thr_1%%");
    expect(lines[3]).toBe("- [x] Renew passport");
  });

  it("explains a quote that no longer matches", () => {
    expect(() => plan([{ op: "delete", line: 2, expect: "- [ ] Buy milk" }])).toThrow(
      /reads .*Book a table.* not "- \[ \] Buy milk"/,
    );
    expect(() => plan([{ op: "add_under", taskId: "tsk_gone", lines: ["x"] }])).toThrow(
      /Unknown task id/,
    );
    expect(() =>
      plan([
        { op: "delete", line: 4, expect: "- [ ] Renew passport" },
        { op: "replace", line: 4, expect: "- [ ] Renew passport", text: "x" },
      ]),
    ).toThrow(/changed twice/);
  });
});

describe("edit_note safety", () => {
  it("lets the agent add and rewrite its own text without asking", async () => {
    const verdict = await evaluateRules("edit_note", {
      edits: [
        { op: "add_under", taskId: "tsk_1", lines: ["Found 3 flights"] },
        { op: "replace", line: 4, expect: "- Checking", text: "- Done", mine: true },
      ],
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.matchedRules).toContain("notes.edit.own");
  });

  it.each([
    [
      { op: "replace", line: 2, expect: "- [ ] Book a table", text: "- [ ] Book a table for 4" },
      "notes.edit.user-text",
    ],
    [{ op: "set_checkbox", taskId: "tsk_1", checked: true }, "notes.edit.user-text"],
    [{ op: "delete", line: 2, expect: "- [ ] Book a table" }, "notes.edit.delete-user-text"],
    [{ op: "rewrite_everything" }, "notes.edit.unreadable"],
  ])("asks before touching the user's text: %o", async (edit, rule) => {
    const verdict = await evaluateRules("edit_note", { edits: [edit] });
    expect(verdict.decision).toBe("require_approval");
    expect(verdict.matchedRules).toContain(rule);
  });

  it("denies writing the app's hidden state", async () => {
    const verdict = await evaluateRules("edit_note", {
      notePath: ".daily-do-list/state/records.json",
      edits: [{ op: "append", lines: ["x"] }],
    });
    expect(verdict.decision).toBe("deny");
  });

  it("describes the edit for the approval card", () => {
    expect(
      describeNoteEdit({
        notePath: "Daily/2026-09-24.md",
        edits: [{ op: "replace", expect: "- [ ] Book a table", text: "- [ ] Book a table for 4" }],
      }),
    ).toBe('Edit Daily/2026-09-24.md: change "- [ ] Book a table" to "- [ ] Book a table for 4"');
  });
});

describe("edit_note tool", () => {
  async function setup() {
    const storage = new MemoryStorageProvider();
    await storage.write("Daily/2026-09-24.md", NOTE);
    const located: Record<string, NoteItemLocation> = Object.fromEntries(
      Object.entries(tasks).map(([id, at]) => [id, { notePath: "Daily/2026-09-24.md", ...at }]),
    );
    const edited: string[][] = [];
    const tool = createNoteEditTool({
      storage,
      locate: (id) => located[id] ?? null,
      threadFor: (taskId) => (taskId ? `thr_${taskId}` : null),
      defaultNotePath: () => "Daily/2026-09-24.md",
      waitForPause: async () => {},
      onEdited: ({ lines }) => edited.push(lines),
    });
    return { storage, tool, edited };
  }

  it("writes under the subagent's own task by default and reports the change", async () => {
    const { storage, tool, edited } = await setup();
    const result = await tool.execute(
      { edits: [{ op: "add_under", lines: ["Trattoria Sole, 7 PM"] }] },
      { toolCallId: "c1", taskId: "tsk_table", threadId: "thr_x" },
    );
    expect(result.isError).toBeUndefined();
    expect((await storage.read("Daily/2026-09-24.md"))!.content).toContain(
      "  - Trattoria Sole, 7 PM %%agent:thr_tsk_table%%",
    );
    expect(edited).toEqual([["  - Trattoria Sole, 7 PM %%agent:thr_tsk_table%%"]]);
  });

  it("never writes in a drawing, by its name or its frontmatter", async () => {
    const { storage, tool } = await setup();
    const drawing = serializeDrawingFile(emptyDrawingScene());
    await storage.write("Excalidraw/Plan.excalidraw.md", drawing);
    await storage.write("Notes/Sketch.md", drawing);
    for (const notePath of [
      "Plan.excalidraw",
      "Excalidraw/Plan.excalidraw.md",
      "Notes/Sketch.md",
    ]) {
      const result = await tool.execute(
        { notePath, edits: [{ op: "append", lines: ["A note from the agent"] }] },
        { toolCallId: "c9" },
      );
      expect(result.isError, notePath).toBe(true);
      expect(toolResultText(result), notePath).toMatch(/is a drawing: edit_note writes in notes/);
    }
    expect((await storage.read("Excalidraw/Plan.excalidraw.md"))!.content).toBe(drawing);
    expect((await storage.read("Notes/Sketch.md"))!.content).toBe(drawing);
  });

  it("replans on the new note when the user saved in between", async () => {
    const { storage, tool } = await setup();
    const original = storage.read.bind(storage);
    let reads = 0;
    storage.read = async (path) => {
      const file = await original(path);
      if (reads++ === 0) await storage.write(path, `- [ ] Call mom\n${NOTE}`);
      return file;
    };
    const result = await tool.execute(
      { taskId: "tsk_passport", edits: [{ op: "add_under", lines: ["Appointment Tue 10:00"] }] },
      { toolCallId: "c2" },
    );
    expect(result.isError).toBeUndefined();
    const content = (await original("Daily/2026-09-24.md"))!.content;
    expect(content.startsWith("- [ ] Call mom\n")).toBe(true);
    expect(content).toContain(
      "- [ ] Renew passport\n  - Appointment Tue 10:00 %%agent:thr_tsk_passport%%",
    );
  });

  it("rejects hidden paths and unknown tasks", async () => {
    const { tool } = await setup();
    const hidden = await tool.execute(
      { notePath: ".daily-do-list/x.md", edits: [{ op: "append", lines: ["x"] }] },
      { toolCallId: "c3" },
    );
    expect(hidden.isError).toBe(true);
    const unknown = await tool.execute(
      { taskId: "tsk_nope", edits: [{ op: "add_under", lines: ["x"] }] },
      { toolCallId: "c4" },
    );
    expect(unknown.isError).toBe(true);
  });
});
