/**
 * Wire strings must be well-formed UTF-16: a lone surrogate survives JSON.stringify as `\udXXX`
 * but strict decoders (Swift's JSONDecoder) reject the whole payload.
 */
import { summarizeThread, type Thread } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { ThreadSummarySchema } from "../../src/wire";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const isWellFormed = (text: string) => !LONE_SURROGATE.test(text);

function threadWithText(text: string): Thread {
  return {
    id: "thr_1",
    taskId: null,
    notePath: null,
    title: "t",
    status: "working",
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { id: "m", author: "orchestrator", createdAt: 0, kind: "text", role: "agent", text },
    ],
    artifacts: [],
    surfaces: [],
  };
}

describe("summarizeThread previews", () => {
  it("detects lone surrogates", () => {
    expect(isWellFormed("😀")).toBe(true);
    expect(isWellFormed("😀".slice(0, 1))).toBe(false);
    expect(isWellFormed("😀".slice(1))).toBe(false);
  });

  it("does not split an emoji that straddles the 200-unit cut (regression)", () => {
    const text = `${"a".repeat(199)}😀 and more`;
    const summary = summarizeThread(threadWithText(text));
    expect(summary.lastMessagePreview).toBe("a".repeat(199));
    expect(isWellFormed(summary.lastMessagePreview ?? "")).toBe(true);
  });

  test.prop([fc.string({ unit: "grapheme", maxLength: 250 })])(
    "are well-formed prefixes of at most 200 units",
    (text) => {
      const summary = summarizeThread(threadWithText(text));
      const preview = summary.lastMessagePreview ?? "";
      expect(isWellFormed(preview)).toBe(true);
      expect(text.startsWith(preview)).toBe(true);
      expect(preview.length).toBeLessThanOrEqual(200);
      expect(preview.length).toBeGreaterThanOrEqual(Math.min(text.length, 199));
      expect(ThreadSummarySchema.safeParse(summary).success).toBe(true);
    },
  );
});
