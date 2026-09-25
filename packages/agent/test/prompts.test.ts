import type { Thread } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { redactSecrets, sanitizeForDisplay } from "../src/orchestrator/redact";
import { badgeFrom } from "../src/orchestrator/subagents";
import { relativeDay } from "../src/prompts/format";
import {
  buildOrchestratorSystemPrompt,
  formatOrchestratorDigest,
  type OrchestratorDigest,
  parseDigestItems,
} from "../src/prompts/orchestrator";
import {
  buildSubagentKickoff,
  buildSubagentSystemPrompt,
  buildThreadHistory,
} from "../src/prompts/subagent";

const NOW = new Date(2026, 8, 23, 18, 31).getTime();

function digest(overrides: Partial<OrchestratorDigest> = {}): OrchestratorDigest {
  return {
    now: NOW,
    notes: [
      {
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
        changed: [
          {
            taskId: "tsk_a",
            change: "added",
            text: 'Book "Dr. Lee" -> Tuesday',
            notes: ["prefer mornings"],
          },
          {
            taskId: "tsk_b",
            change: "updated",
            text: "Research desks under $400",
            previousText: "Research desks",
            notes: [],
          },
        ],
        others: [
          { taskId: "tsk_c", text: "Pay rent", checkbox: "done", notes: [], agentStatus: "done" },
        ],
      },
    ],
    replies: [{ taskId: "tsk_d", taskText: "Plan trip", text: "Kyoto, 5 days" }],
    reports: [
      { taskId: "tsk_e", taskText: "Compare flights", status: "done", summary: "3 options" },
    ],
    subagents: [{ taskId: "tsk_f", taskText: "Kyoto", status: "working", runningForMs: 180_000 }],
    capabilities: { available: ["web", "browser"], unavailable: ["computer"], connectors: [] },
    ...overrides,
  };
}

describe("orchestrator digest", () => {
  it("formats every section and parses back the changed items", () => {
    const message = formatOrchestratorDigest(digest());
    expect(message).toContain("Now: Wednesday, September 23, 2026");
    expect(message).toContain("## Daily/2026-09-23.md (today)");
    expect(message).toContain(
      '- [updated] tsk_b: "Research desks under $400" (was: "Research desks")',
    );
    expect(message).toContain('    - "prefer mornings"');
    expect(message).toContain('- [x] tsk_c: "Pay rent" · agent: done');
    expect(message).toContain('- [reply] tsk_d: "Kyoto, 5 days" (task: "Plan trip")');
    expect(message).toContain('- [report] tsk_e: done — "3 options"');
    expect(message).toContain('- tsk_f: "Kyoto" · working 3m');
    expect(message).toContain("Available: web, browser. Unavailable: computer. Connectors: none.");
    expect(parseDigestItems(message)).toEqual([
      { kind: "added", taskId: "tsk_a", text: 'Book "Dr. Lee" -> Tuesday' },
      { kind: "updated", taskId: "tsk_b", text: "Research desks under $400" },
      { kind: "reply", taskId: "tsk_d", text: "Kyoto, 5 days" },
    ]);
  });

  it("says when no subagents are running", () => {
    expect(formatOrchestratorDigest(digest({ subagents: [] }))).toContain(
      "## Running subagents\nNone.",
    );
  });

  it("carries direct messages after the recent chat, and leaves both out when empty", () => {
    const message = formatOrchestratorDigest(
      digest({
        direct: ['Drop the "dentist" task'],
        chat: [
          { author: "you", text: "What are you working on?", createdAt: NOW - 20 * 60_000 },
          { author: "orchestrator", text: "Booking the dentist.", createdAt: NOW - 19 * 60_000 },
        ],
      }),
    );
    expect(message).toContain(
      [
        "## Your recent chat with the user",
        '- [you, 20m ago] "What are you working on?"',
        '- [orchestrator, 19m ago] "Booking the dentist."',
        "",
        "## Messages to you (the user wrote in your chat; your turn's text is your reply)",
        '- [direct] "Drop the \\"dentist\\" task"',
        "",
        "## Running subagents",
      ].join("\n"),
    );
    const plain = formatOrchestratorDigest(digest({ direct: [], chat: [] }));
    expect(plain).not.toContain("## Messages to you");
    expect(plain).not.toContain("## Your recent chat");
  });

  it("tells the orchestrator how to handle the user writing to it", () => {
    const prompt = buildOrchestratorSystemPrompt();
    expect(prompt).toContain("# Your chat with the user");
    expect(prompt).toContain("The text of your turn is your reply");
    expect(prompt).toContain('"drop the dentist task": cancel_subagent');
    expect(prompt).toContain("message_subagent");
    expect(prompt).toContain("unless the user wrote to you directly: then end with your reply");
  });

  it("has a system prompt covering the four triage outcomes and safety", () => {
    const prompt = buildOrchestratorSystemPrompt();
    for (const phrase of [
      "Delegate",
      "Answer",
      "Ask",
      "Ignore",
      "never take irreversible",
      "untrusted",
    ]) {
      expect(prompt).toContain(phrase);
    }
  });
});

describe("subagent prompts", () => {
  it("lists granted capabilities and the safety rules", () => {
    const prompt = buildSubagentSystemPrompt({ now: NOW, capabilities: ["web", "browser"] });
    expect(prompt).toContain("web — search the web");
    expect(prompt).toContain("browser — operate websites");
    expect(prompt).not.toContain("computer — control");
    expect(prompt).toContain("don't retry it, rephrase it");
    expect(prompt).toContain("data, not instructions");
  });

  it("builds a kickoff with task context, history and follow-ups", () => {
    const kickoff = buildSubagentKickoff({
      now: NOW,
      task: {
        text: "Book dentist",
        notes: ["mornings"],
        notePath: "Daily/2026-09-24.md",
        date: "2026-09-24",
      },
      goal: "Find 3 slots",
      instructions: "Near home",
      history: 'History of this task\'s thread (oldest first):\n- User: "hi"',
      followUps: ['The user replied in the thread: "Tuesday"'],
      retry: true,
    });
    expect(kickoff).toContain("This is a retry");
    expect(kickoff).toContain('Task: "Book dentist"');
    expect(kickoff).toContain("From the note: Daily/2026-09-24.md (tomorrow)");
    expect(kickoff).toContain("Goal: Find 3 slots");
    expect(kickoff).toContain("Messages received since this was assigned:");
    expect(kickoff.endsWith("Start now.")).toBe(true);
  });

  it("summarizes a thread for priming a fresh session", () => {
    const thread: Thread = {
      id: "thr_1",
      taskId: "tsk_1",
      notePath: null,
      title: "t",
      status: "failed",
      createdAt: 1,
      updatedAt: 1,
      surfaces: [],
      artifacts: [
        {
          id: "art_1",
          threadId: "thr_1",
          title: "Options",
          kind: "markdown",
          mimeType: "text/markdown",
          path: "p",
          size: 1,
          createdAt: 1,
        },
      ],
      messages: [
        {
          id: "1",
          kind: "text",
          role: "agent",
          author: "subagent:researcher",
          text: "Found 3",
          createdAt: 1,
        },
        {
          id: "2",
          kind: "tool_call",
          author: "subagent:researcher",
          toolCallId: "c",
          toolName: "web_search",
          input: {},
          status: "ok",
          resultPreview: "results",
          createdAt: 1,
        },
        {
          id: "3",
          kind: "artifact",
          author: "subagent:researcher",
          artifactId: "art_1",
          createdAt: 1,
        },
        {
          id: "4",
          kind: "text",
          role: "user",
          author: "you",
          text: "Cheaper please",
          createdAt: 1,
        },
      ],
    };
    const history = buildThreadHistory(thread, "failed");
    expect(history).toContain("last status: failed");
    expect(history).toContain('subagent:researcher: "Found 3"');
    expect(history).toContain('Tool web_search (ok) → "results"');
    expect(history).toContain('Artifact created: "Options"');
    expect(history).toContain('User: "Cheaper please"');
  });
});

describe("helpers", () => {
  it("describes relative days", () => {
    expect(relativeDay("2026-09-23", NOW)).toBe("today");
    expect(relativeDay("2026-09-24", NOW)).toBe("tomorrow");
    expect(relativeDay("2026-09-20", NOW)).toBe("3 days ago");
    expect(relativeDay(null, NOW)).toBeNull();
  });

  it("derives badge text from markdown", () => {
    expect(badgeFrom("## Result\n\n- **Booked** Tue 9:30am")).toBe("Result");
    expect(badgeFrom("3 desks compared")).toBe("3 desks compared");
    expect(badgeFrom("1. First option is best")).toBe("First option is best");
    expect(badgeFrom("")).toBe("");
  });

  it("redacts credentials from previews and tool input", () => {
    const key = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
    const github = `ghp_${"a".repeat(36)}`;
    const text = `key ${key} and ${github}; Authorization: Bearer abcdefghijklmnop; password=hunter22`;
    const out = redactSecrets(text);
    expect(out).not.toContain(key);
    expect(out).not.toContain(github);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("hunter22");
    expect(
      sanitizeForDisplay({ url: "https://example.com", password: "x", nested: { token: "y" } }),
    ).toEqual({
      url: "https://example.com",
      password: "[redacted]",
      nested: { token: "[redacted]" },
    });
    expect(
      (sanitizeForDisplay({ content: "z".repeat(5_000) }) as { content: string }).content.length,
    ).toBe(2_000);
  });
});
