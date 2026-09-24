import type { TaskAgentStatus } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { type BadgeTone, badgeClassName, badgeTone } from "./widget";

describe("badge tone", () => {
  it("makes only needs-you loud, tints failures and quiets finished work", () => {
    const tones: Record<TaskAgentStatus, BadgeTone> = {
      waiting_approval: "needs-you",
      waiting_user: "needs-you",
      failed: "failed",
      triaging: "working",
      queued: "working",
      working: "working",
      done: "quiet",
      cancelled: "quiet",
      idle: "quiet",
      ignored: "quiet",
    };
    for (const [status, tone] of Object.entries(tones)) {
      expect(badgeTone(status as TaskAgentStatus), status).toBe(tone);
    }
  });

  it("classes a badge by status (dot) and tone (fill, border, text)", () => {
    expect(badgeClassName("waiting_user")).toBe(
      "cm-ddl-badge cm-ddl-badge-waiting_user cm-ddl-badge-tone-needs-you",
    );
    expect(badgeClassName("triaging")).toBe(
      "cm-ddl-badge cm-ddl-badge-triaging cm-ddl-badge-tone-working",
    );
    expect(badgeClassName("done")).toBe("cm-ddl-badge cm-ddl-badge-done cm-ddl-badge-tone-quiet");
  });
});
