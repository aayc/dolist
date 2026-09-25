import { type ArtifactMeta, extname } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError } from "../errors";
import { idParam, isTruthyFlag } from "../http-utils";

/** Types that can run script or navigate when rendered; always served as downloads. */
const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/pdf",
]);

const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const TEXT_TYPES: ReadonlySet<string> = new Set(["application/json", "image/svg+xml"]);

/**
 * Agent output is untrusted. Even if an artifact URL were opened directly, the document runs in a
 * unique opaque origin with scripts disabled. The UI renders HTML via a sandboxed iframe.
 */
const ARTIFACT_CSP =
  "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'";

export function registerArtifactRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/artifacts/:threadId/:artifactId", async (c) => {
    const artifact = await ctx.runtime.readArtifact(
      idParam(c, "threadId"),
      idParam(c, "artifactId"),
    );
    if (!artifact) throw new ApiError(404, "not_found", "Artifact not found");
    const { meta, body } = artifact;
    const mimeType = safeMimeType(meta.mimeType);
    const download = isTruthyFlag(c.req.query("download")) || ACTIVE_CONTENT_TYPES.has(mimeType);
    return c.body(toArrayBufferView(body), 200, {
      "Content-Type": withCharset(mimeType),
      "Content-Disposition": contentDisposition(download, artifactFilename(meta)),
      "Content-Security-Policy": ARTIFACT_CSP,
      "X-Content-Type-Options": "nosniff",
    });
  });
}

/**
 * Headers for artifact bytes relayed from the always-on machine, under the same rules as local
 * ones: a valid type, active content as an attachment, the sandbox CSP and nosniff.
 */
export function relayedArtifactHeaders(
  contentType: string | null,
  disposition: string | null,
): Record<string, string> {
  const mimeType = safeMimeType(contentType ?? "");
  const known = disposition !== null && /^(inline|attachment);/.test(disposition);
  const params = known ? disposition.slice(disposition.indexOf(";")) : '; filename="artifact"';
  const inline = known && disposition.startsWith("inline;") && !ACTIVE_CONTENT_TYPES.has(mimeType);
  return {
    "Content-Type": withCharset(mimeType),
    "Content-Disposition": `${inline ? "inline" : "attachment"}${params}`,
    "Content-Security-Policy": ARTIFACT_CSP,
    "X-Content-Type-Options": "nosniff",
  };
}

/** The runtime-provided type without parameters, or octet-stream when it is not a valid type. */
export function safeMimeType(value: string): string {
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return MIME_TYPE_RE.test(type) ? type : "application/octet-stream";
}

function withCharset(mimeType: string): string {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType)
    ? `${mimeType}; charset=utf-8`
    : mimeType;
}

function artifactFilename(meta: ArtifactMeta): string {
  const title = meta.title.trim() || meta.id;
  const ext = extname(meta.path);
  return ext && !title.toLowerCase().endsWith(ext.toLowerCase()) ? `${title}${ext}` : title;
}

function contentDisposition(download: boolean, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 150) || "artifact";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}
