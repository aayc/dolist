/**
 * Projects an MCP `CallToolResult` into the harness-agnostic `ToolResult`. Server output is
 * untrusted: every block is checked, payloads the model can't use become short placeholders, and
 * text is capped so one misbehaving server can't flood the context window.
 *
 * Adapted from OpenClaw (MIT): src/agents/mcp-content.ts.
 */
import type { ToolContent, ToolResult } from "@ddl/core";
import { isPlainObject, type PlainObject, typeName } from "./util";

export const MAX_RESULT_TEXT_CHARS = 100_000;
/** Roughly 6 MB decoded; larger images are rejected by model providers anyway. */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;
/** All images of one result together (about 12 MB decoded); later images become placeholders. */
export const MAX_RESULT_IMAGE_BASE64_CHARS = 2 * MAX_IMAGE_BASE64_CHARS;
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface McpToolResultDetails {
  server: string;
  tool: string;
  structuredContent?: Record<string, unknown>;
  /** Set when text content was cut to the size limit. */
  truncated?: boolean;
}

export interface ProjectResultOptions {
  server: string;
  tool: string;
  maxTextChars?: number;
}

export function projectCallToolResult(
  result: unknown,
  options: ProjectResultOptions,
): ToolResult<McpToolResultDetails> {
  const record = isPlainObject(result) ? result : {};
  const isError = record.isError === true;
  const blocks: unknown[] = Array.isArray(record.content) ? record.content : [];
  const content = blocks.map(projectBlock);
  const structured = isPlainObject(record.structuredContent) ? record.structuredContent : undefined;
  // Protocol 2024-10-07 servers answer with `toolResult` instead of `content`.
  if (!Array.isArray(record.content) && record.toolResult !== undefined) {
    content.push(text(stringify(record.toolResult)));
  }
  if (structured && !content.some((block) => block.type === "text")) {
    content.push(text(stringify(structured)));
  }
  if (content.length === 0) {
    content.push(
      text(
        isError ? "The tool reported an error without details." : "The tool returned no content.",
      ),
    );
  }
  const capped = capText(capImages(content), options.maxTextChars ?? MAX_RESULT_TEXT_CHARS);
  const details: McpToolResultDetails = {
    server: options.server,
    tool: options.tool,
    ...(structured ? { structuredContent: structured } : {}),
    ...(capped.truncated ? { truncated: true } : {}),
  };
  return isError
    ? { content: capped.content, details, isError: true }
    : { content: capped.content, details };
}

function projectBlock(block: unknown): ToolContent {
  if (!isPlainObject(block)) return text(`[Unsupported MCP content: ${typeName(block)}]`);
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? text(block.text) : unsupported(block);
    case "image":
      return typeof block.data === "string" && typeof block.mimeType === "string"
        ? image(block.data, block.mimeType)
        : unsupported(block);
    case "audio":
      return text(`[Audio omitted${binaryInfo(block.mimeType, block.data)}]`);
    case "resource":
      return embeddedResource(block.resource);
    case "resource_link":
      return resourceLink(block);
    default:
      return unsupported(block);
  }
}

function image(data: string, mimeType: string): ToolContent {
  const type = normalizeImageType(mimeType);
  if (!MODEL_IMAGE_TYPES.has(type)) {
    return text(
      `[Image omitted: ${type || "unknown type"} is not supported${binaryInfo(undefined, data)}]`,
    );
  }
  if (data.length > MAX_IMAGE_BASE64_CHARS) {
    return text(`[Image omitted: ${formatBytes(base64Bytes(data))} exceeds the size limit]`);
  }
  // Providers reject a whole request over one undecodable image.
  const base64 = canonicalBase64(data);
  if (base64 === undefined) return text(`[Image omitted: ${type} data is not valid base64]`);
  return { type: "image", data: base64, mimeType: type };
}

/** Standard padded base64 from what servers send (data: URLs, line breaks, URL-safe or unpadded), or undefined. */
function canonicalBase64(data: string): string | undefined {
  let body = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  body = body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (body.length % 4 !== 0) body += "=".repeat(4 - (body.length % 4));
  return body.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length % 4 === 0
    ? body
    : undefined;
}

/** Keeps images until their combined size reaches the per-result limit. */
function capImages(content: ToolContent[]): ToolContent[] {
  let budget = MAX_RESULT_IMAGE_BASE64_CHARS;
  return content.map((block) => {
    if (block.type !== "image") return block;
    budget -= block.data.length;
    return budget >= 0
      ? block
      : text(`[Image omitted: this result's images exceed the combined size limit]`);
  });
}

function embeddedResource(resource: unknown): ToolContent {
  if (!isPlainObject(resource) || typeof resource.uri !== "string") {
    return text("[Unsupported MCP content: resource without a uri]");
  }
  const mime = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
  if (typeof resource.text === "string") {
    return text(`[Resource: ${resource.uri}${mime ? ` (${mime})` : ""}]\n${resource.text}`);
  }
  if (typeof resource.blob === "string") {
    if (mime && MODEL_IMAGE_TYPES.has(normalizeImageType(mime))) return image(resource.blob, mime);
    return text(
      `[Resource: ${resource.uri}${binaryInfo(mime, resource.blob)}; binary content not shown]`,
    );
  }
  return text(`[Resource: ${resource.uri}]`);
}

function resourceLink(block: PlainObject): ToolContent {
  if (typeof block.uri !== "string") return unsupported(block);
  const label =
    typeof block.title === "string"
      ? block.title
      : typeof block.name === "string"
        ? block.name
        : "";
  const description = typeof block.description === "string" ? ` (${block.description})` : "";
  return text(`[Resource link${label ? `: ${label}` : ""}] ${block.uri}${description}`);
}

function unsupported(block: PlainObject): ToolContent {
  const type = typeof block.type === "string" ? block.type.slice(0, 40) : "unknown";
  return text(`[Unsupported MCP content block: type=${type}]`);
}

function capText(
  content: ToolContent[],
  max: number,
): { content: ToolContent[]; truncated: boolean } {
  let total = 0;
  for (const block of content) if (block.type === "text") total += block.text.length;
  if (total <= max) return { content, truncated: false };
  let remaining = max;
  let kept = 0;
  const out: ToolContent[] = [];
  for (const block of content) {
    if (block.type !== "text") {
      out.push(block);
    } else if (block.text.length <= remaining) {
      out.push(block);
      remaining -= block.text.length;
      kept += block.text.length;
    } else if (remaining > 0) {
      const cut = cutText(block.text, remaining);
      out.push(text(cut));
      kept += cut.length;
      remaining = 0;
    }
  }
  out.push(text(`[Output truncated: ${total - kept} of ${total} characters omitted.]`));
  return { content: out, truncated: true };
}

/** Avoids leaving half of a surrogate pair at the cut. */
function cutText(value: string, length: number): string {
  const code = value.charCodeAt(length - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

function text(value: string): ToolContent {
  return { type: "text", text: value };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeImageType(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return base === "image/jpg" ? "image/jpeg" : base;
}

function binaryInfo(mimeType: unknown, data: unknown): string {
  const parts: string[] = [];
  if (typeof mimeType === "string" && mimeType !== "") parts.push(mimeType);
  if (typeof data === "string") parts.push(formatBytes(base64Bytes(data)));
  return parts.length > 0 ? `: ${parts.join(", ")}` : "";
}

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
