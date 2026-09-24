import type { ToolContent } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BASE64_CHARS,
  MAX_RESULT_IMAGE_BASE64_CHARS,
  MAX_RESULT_TEXT_CHARS,
  projectCallToolResult,
} from "./content";

const runs = (factor: number) =>
  Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));
const MODEL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PNG = "iVBORw0KGgo=";
const ctx = { server: "srv", tool: "t" };

const mimeType = fc.oneof(
  fc.constantFrom(
    "image/png",
    "IMAGE/JPEG; q=1",
    "image/jpg",
    "image/svg+xml",
    "audio/wav",
    "",
    "x".repeat(300),
  ),
  fc.string({ maxLength: 20 }),
  fc.integer(),
);
const base64ish = fc.oneof(
  fc.constant(PNG),
  fc.base64String({ maxLength: 64 }),
  fc.constantFrom(
    "not base64!!",
    "data:image/png;base64,iVBORw0KGgo=",
    "iVBO Rw0K\nGgo=",
    "iVBORw0KGgo",
    "-_-_",
    "",
    "====",
  ),
  fc.string({ maxLength: 40 }),
);

const block: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    type: fc.constant("text"),
    text: fc.oneof(fc.string({ maxLength: 200 }), fc.integer(), fc.constant(null)),
  }),
  fc.record({ type: fc.constant("image"), data: base64ish, mimeType }, { requiredKeys: ["type"] }),
  fc.record({ type: fc.constant("audio"), data: base64ish, mimeType }, { requiredKeys: ["type"] }),
  fc.record({
    type: fc.constant("resource"),
    resource: fc.oneof(
      fc.record(
        {
          uri: fc.oneof(fc.webUrl(), fc.integer()),
          text: fc.string({ maxLength: 100 }),
          blob: base64ish,
          mimeType,
        },
        { requiredKeys: [] },
      ),
      fc.constant(null),
    ),
  }),
  fc.record(
    {
      type: fc.constant("resource_link"),
      uri: fc.oneof(fc.webUrl(), fc.constant(3)),
      name: fc.string(),
      title: fc.string(),
      description: fc.string(),
    },
    { requiredKeys: ["type"] },
  ),
  fc.record({ type: fc.oneof(fc.string({ maxLength: 60 }), fc.integer()) }),
  fc.anything(),
);

const result = fc.record(
  {
    content: fc.oneof(fc.array(block, { maxLength: 8 }), fc.anything()),
    isError: fc.oneof(fc.boolean(), fc.constantFrom("true", 1, null)),
    structuredContent: fc.oneof(
      fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 })),
      fc.anything(),
    ),
    toolResult: fc.jsonValue({ maxDepth: 2 }),
  },
  { requiredKeys: [] },
);

function textLength(content: ToolContent[]): number {
  return content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
}

function expectValid(projected: ReturnType<typeof projectCallToolResult>, maxText: number): void {
  expect(projected.content.length).toBeGreaterThan(0);
  let imageChars = 0;
  for (const b of projected.content) {
    if (b.type === "text") {
      expect(typeof b.text).toBe("string");
    } else {
      expect(b.type).toBe("image");
      if (b.type !== "image") continue;
      expect(MODEL_IMAGE_TYPES).toContain(b.mimeType);
      expect(b.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_CHARS);
      expect(b.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(b.data.length % 4).toBe(0);
      imageChars += b.data.length;
    }
  }
  expect(imageChars).toBeLessThanOrEqual(MAX_RESULT_IMAGE_BASE64_CHARS);
  // The truncation note is the only text allowed beyond the cap.
  const note = projected.content.at(-1);
  const noteLength = projected.details?.truncated && note?.type === "text" ? note.text.length : 0;
  expect(textLength(projected.content) - noteLength).toBeLessThanOrEqual(maxText);
}

describe("projectCallToolResult", () => {
  test.prop([fc.oneof(result, fc.anything())], { numRuns: runs(3) })(
    "never throws and yields a valid, capped ToolResult",
    (raw) => {
      const projected = projectCallToolResult(raw, ctx);
      expectValid(projected, MAX_RESULT_TEXT_CHARS);
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      expect(projected.isError === true).toBe(record.isError === true);
      expect(projected.details).toMatchObject(ctx);
    },
  );

  test.prop([result, fc.integer({ min: 1, max: 500 })])(
    "honors any text cap without splitting surrogate pairs",
    (raw, maxTextChars) => {
      const projected = projectCallToolResult(
        {
          ...raw,
          content: [
            { type: "text", text: "😀".repeat(400) },
            ...(Array.isArray(raw.content) ? raw.content : []),
          ],
        },
        { ...ctx, maxTextChars },
      );
      expectValid(projected, maxTextChars);
      for (const b of projected.content)
        if (b.type === "text") expect(b.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    },
  );

  it("caps huge text, many images and oversized structured output", () => {
    const projected = projectCallToolResult(
      {
        content: [
          { type: "text", text: "a".repeat(250_000) },
          ...Array.from({ length: 30 }, () => ({
            type: "image",
            data: "A".repeat(6_000_000),
            mimeType: "image/png",
          })),
        ],
        structuredContent: { big: "x".repeat(300_000) },
      },
      ctx,
    );
    expectValid(projected, MAX_RESULT_TEXT_CHARS);
    expect(projected.content.filter((b) => b.type === "image")).toHaveLength(2);
    expect(projected.details?.truncated).toBe(true);
  });

  it("normalizes image data servers send in other base64 spellings", () => {
    const content = projectCallToolResult(
      {
        content: [
          { type: "image", data: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
          { type: "image", data: "iVBO\nRw0K\nGgo=", mimeType: "image/png" },
          { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
          { type: "image", data: "not base64!!", mimeType: "image/png" },
        ],
      },
      ctx,
    ).content;
    expect(content.slice(0, 3)).toEqual(
      Array(3).fill({ type: "image", data: PNG, mimeType: "image/png" }),
    );
    expect(content[3]).toEqual({
      type: "text",
      text: "[Image omitted: image/png data is not valid base64]",
    });
  });
});
