import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BASE64_CHARS, projectCallToolResult } from "./content";

const ctx = { server: "srv", tool: "t" };
const PNG = "iVBORw0KGgo=";

describe("projectCallToolResult", () => {
  it("maps text and supported images", () => {
    const result = projectCallToolResult(
      {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: PNG, mimeType: "image/PNG; charset=binary" },
          { type: "image", data: PNG, mimeType: "image/jpg" },
        ],
      },
      ctx,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: PNG, mimeType: "image/jpeg" },
      ],
      details: { server: "srv", tool: "t" },
    });
  });

  it("replaces unusable binary payloads with placeholders", () => {
    const { content } = projectCallToolResult(
      {
        content: [
          { type: "image", data: PNG, mimeType: "image/svg+xml" },
          { type: "image", data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4), mimeType: "image/png" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        ],
      },
      ctx,
    );
    expect(content).toEqual([
      { type: "text", text: "[Image omitted: image/svg+xml is not supported: 8 B]" },
      { type: "text", text: "[Image omitted: 6.0 MB exceeds the size limit]" },
      { type: "text", text: "[Audio omitted: audio/wav, 3 B]" },
    ]);
  });

  it("renders embedded resources and resource links", () => {
    const { content } = projectCallToolResult(
      {
        content: [
          {
            type: "resource",
            resource: { uri: "file:///notes/a.md", mimeType: "text/markdown", text: "# A" },
          },
          {
            type: "resource",
            resource: { uri: "file:///b.bin", mimeType: "application/zip", blob: "AAAA" },
          },
          {
            type: "resource",
            resource: { uri: "file:///c.png", mimeType: "image/png", blob: PNG },
          },
          {
            type: "resource_link",
            uri: "https://example.com/doc",
            name: "doc",
            title: "Design doc",
            description: "v2",
          },
          { type: "resource_link", uri: "https://example.com/raw", name: "" },
        ],
      },
      ctx,
    );
    expect(content).toEqual([
      { type: "text", text: "[Resource: file:///notes/a.md (text/markdown)]\n# A" },
      {
        type: "text",
        text: "[Resource: file:///b.bin: application/zip, 3 B; binary content not shown]",
      },
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "text", text: "[Resource link: Design doc] https://example.com/doc (v2)" },
      { type: "text", text: "[Resource link] https://example.com/raw" },
    ]);
  });

  it("describes unknown or malformed blocks instead of dropping them", () => {
    const { content } = projectCallToolResult(
      { content: [{ type: "video", url: "x" }, { type: "text" }, "raw", { type: "resource" }] },
      ctx,
    );
    expect(content.map((block) => (block.type === "text" ? block.text : block.type))).toEqual([
      "[Unsupported MCP content block: type=video]",
      "[Unsupported MCP content block: type=text]",
      "[Unsupported MCP content: string]",
      "[Unsupported MCP content: resource without a uri]",
    ]);
  });

  it("moves structuredContent to details and adds its JSON only when there is no text", () => {
    const structured = { temperature: 21, unit: "C" };
    const withText = projectCallToolResult(
      { content: [{ type: "text", text: "21 C" }], structuredContent: structured },
      ctx,
    );
    expect(withText.content).toEqual([{ type: "text", text: "21 C" }]);
    expect(withText.details?.structuredContent).toEqual(structured);

    const withoutText = projectCallToolResult({ content: [], structuredContent: structured }, ctx);
    expect(withoutText.content).toEqual([
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ]);
  });

  it("flags errors and never returns empty content", () => {
    expect(
      projectCallToolResult({ content: [{ type: "text", text: "nope" }], isError: true }, ctx),
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "nope" }],
    });
    expect(projectCallToolResult({ content: [], isError: true }, ctx).content).toEqual([
      { type: "text", text: "The tool reported an error without details." },
    ]);
    expect(projectCallToolResult(undefined, ctx)).toEqual({
      content: [{ type: "text", text: "The tool returned no content." }],
      details: { server: "srv", tool: "t" },
    });
  });

  it("supports the 2024-10-07 toolResult shape", () => {
    expect(projectCallToolResult({ toolResult: { ok: true } }, ctx).content).toEqual([
      { type: "text", text: '{\n  "ok": true\n}' },
    ]);
  });

  it("caps text across blocks with a notice", () => {
    const result = projectCallToolResult(
      {
        content: [
          { type: "text", text: "a".repeat(6) },
          { type: "image", data: PNG, mimeType: "image/png" },
          { type: "text", text: "b".repeat(6) },
          { type: "text", text: "c".repeat(6) },
        ],
      },
      { ...ctx, maxTextChars: 10 },
    );
    expect(result.content).toEqual([
      { type: "text", text: "aaaaaa" },
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "text", text: "bbbb" },
      { type: "text", text: "[Output truncated: 8 of 18 characters omitted.]" },
    ]);
    expect(result.details?.truncated).toBe(true);
  });

  it("never splits a surrogate pair when truncating", () => {
    const result = projectCallToolResult(
      { content: [{ type: "text", text: "ab😀cd" }] },
      { ...ctx, maxTextChars: 3 },
    );
    expect(result.content[0]).toEqual({ type: "text", text: "ab" });
  });
});
