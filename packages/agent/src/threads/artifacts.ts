import type { ArtifactKind } from "@ddl/core";

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  bash: "sh",
  c: "c",
  "c#": "cs",
  "c++": "cpp",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  csv: "csv",
  go: "go",
  html: "html",
  java: "java",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  kotlin: "kt",
  markdown: "md",
  php: "php",
  py: "py",
  python: "py",
  rb: "rb",
  ruby: "rb",
  rs: "rs",
  rust: "rs",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  swift: "swift",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "sh",
};

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};

const KIND_MIME_TYPES: Record<ArtifactKind, string> = {
  markdown: "text/markdown",
  code: "text/plain",
  html: "text/html",
  image: "image/png",
  json: "application/json",
  text: "text/plain",
  file: "application/octet-stream",
};

/** Default MIME type for an artifact the agent created from text. */
export function defaultMimeType(kind: ArtifactKind): string {
  return KIND_MIME_TYPES[kind];
}

/** File extension (without dot) for an artifact body in the sidecar. */
export function artifactExtension(kind: ArtifactKind, mimeType: string, language?: string): string {
  switch (kind) {
    case "markdown":
      return "md";
    case "html":
      return "html";
    case "json":
      return "json";
    case "text":
      return "txt";
    case "code":
      return (language && LANGUAGE_EXTENSIONS[language.toLowerCase()]) || "txt";
    case "image":
    case "file":
      return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? (kind === "image" ? "img" : "bin");
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.trim(), "base64"));
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
