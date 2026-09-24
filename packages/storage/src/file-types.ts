import { extname } from "@ddl/core";

/**
 * Extensions of files that can't round-trip through the text-only StorageProvider API. Local-fs
 * versions them by stat instead of content, and the sync engine leaves them alone.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
  ".psd",
  // audio / video
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".flac",
  ".opus",
  ".webm",
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".avi",
  ".3gp",
  // documents & archives
  ".pdf",
  ".epub",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".numbers",
  ".key",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".dmg",
  ".iso",
  // fonts, binaries, databases
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".class",
  ".jar",
  ".pyc",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

/** Plain-text formats where a line-based three-way merge is meaningful. */
const MERGEABLE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".txt"]);

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isMergeablePath(path: string): boolean {
  return MERGEABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** UTF-8 byte length without Node's Buffer (sync + search stay isomorphic). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
