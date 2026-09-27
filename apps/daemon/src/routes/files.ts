import { API_CONTRACT, WIRE_LIMITS } from "@ddl/contract";
import {
  API_PATHS,
  basename,
  decodeVaultPath,
  extname,
  type VaultFileMetadata,
  WORKSPACE_ID_HEADER,
} from "@ddl/core";
import type { BinaryFileContent, WriteResult } from "@ddl/storage";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError } from "../errors";
import { clientWriteSource, readQuery } from "../http-utils";
import { moveNoteToTrash } from "../vault-ops";
import { isTextNotePath, resolveVaultPath } from "../vault-paths";
import { relayedArtifactHeaders } from "./artifacts";

export function registerFileRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.file, async (c) => {
    const path = filePath(c.req.url);
    const file = await ctx.storage.readBinary(path, { maxBytes: WIRE_LIMITS.bodyBytes });
    if (!file) throw new ApiError(404, "not_found", "Attachment not found");
    const mimeType = detectFileMime(file.bytes, path);
    const inline = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType);
    const name = encodeURIComponent(basename(file.path)).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const headers = relayedArtifactHeaders(
      mimeType,
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    );
    return c.body(new Uint8Array(file.bytes), 200, {
      ...headers,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-DDL-File-Path": encodeURIComponent(file.path),
      "X-DDL-File-Version": file.version,
      "X-DDL-File-Mtime": String(file.mtime),
      ETag: `"${file.version}"`,
    });
  });

  app.put(API_PATHS.file, async (c) => {
    const path = attachmentPath(c.req.url);
    requireWorkspace(c.req.header(WORKSPACE_ID_HEADER));
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/octet-stream"
    ) {
      throw new ApiError(415, "unsupported_media_type", "Upload application/octet-stream bytes");
    }
    const query = readQuery(c, API_CONTRACT.file.methods.PUT.query);
    if (
      new URL(c.req.url).searchParams.size !== 1 ||
      (query.ifAbsent !== undefined) === (query.ifMatch !== undefined)
    ) {
      throw new ApiError(400, "invalid_request", "Supply exactly one of ifAbsent=1 or ifMatch");
    }
    // The global authenticated body limiter consumes at most 5 MiB before this conversion.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await ctx.storage.writeBinary(path, bytes, { ifMatch: query.ifMatch ?? null });
    ctx.writes.record(result.path, result.version, clientWriteSource(c));
    return c.json(metadata(result, detectFileMime(bytes, path)), result.created ? 201 : 200);
  });

  app.delete(API_PATHS.file, async (c) => {
    const path = attachmentPath(c.req.url);
    requireWorkspace(c.req.header(WORKSPACE_ID_HEADER));
    const moved = await moveNoteToTrash(ctx.storage, path, ctx.now());
    const source = clientWriteSource(c);
    ctx.writes.record(moved.from, undefined, source);
    ctx.writes.record(moved.to, moved.version, source);
    return c.json({ ok: true as const, trashedTo: moved.to });
  });
}

function requireWorkspace(value: string | undefined): void {
  if (!value) throw new ApiError(400, "invalid_request", "A verified workspace header is required");
}

function filePath(url: string): string {
  try {
    return resolveVaultPath(decodeVaultPath(new URL(url).pathname.split("/").slice(3).join("/")));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_path", "Malformed attachment path");
  }
}

function attachmentPath(url: string): string {
  const path = filePath(url);
  if (isTextNotePath(path))
    throw new ApiError(400, "invalid_path", "Use the notes API for text notes");
  return path;
}

function metadata(file: BinaryFileContent | WriteResult, mimeType: string): VaultFileMetadata {
  return { path: file.path, version: file.version, mtime: file.mtime, size: file.size, mimeType };
}

/** Extensions can label downloads, but only byte signatures grant an inline raster type. */
export function detectFileMime(bytes: Uint8Array, path: string): string {
  const starts = (values: number[]) => values.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  switch (extname(path).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}
