/**
 * One pass over the Obsidian vault for the preview and the import's totals: what it holds, by
 * kind, without reading any note. Memory grows with the number of paths (one key each, for
 * collision checks), never with their contents.
 */
import {
  type AttachmentSummary,
  type AttachmentType,
  type ImportSkipped,
  isHiddenPath,
  SIDECAR_DIR,
} from "@ddl/core";
import { pathKey } from "./places";
import { BoundedList } from "./report-lists";
import { walkVault } from "./walk";

export const DRAWING_SUFFIX = ".excalidraw.md";

const ATTACHMENT_TYPES: readonly AttachmentType[] = ["image", "pdf", "audio", "video", "other"];
const EXTENSION_TYPES: Readonly<Record<string, AttachmentType>> = {
  ...byExtension("image", "png jpg jpeg gif webp svg bmp avif heic heif tif tiff ico"),
  ...byExtension("pdf", "pdf"),
  ...byExtension("audio", "mp3 wav m4a ogg oga flac aac opus"),
  ...byExtension("video", "mp4 mov mkv webm ogv avi m4v"),
};

export interface SourceScan {
  files: number;
  bytes: number;
  notes: number;
  folders: number;
  attachments: AttachmentSummary;
  canvases: BoundedList<string>;
  drawings: BoundedList<string>;
  skipped: BoundedList<ImportSkipped>;
  /** `pathKey` → path of every file that will be copied. */
  byKey: Map<string, string>;
  /** Notes in the templates folder. */
  templates: number;
}

export function isSourceSidecar(path: string): boolean {
  return path === SIDECAR_DIR;
}

export async function scanSource(
  root: string,
  options: { templatesFolder: string | null; signal?: AbortSignal },
): Promise<SourceScan> {
  const attachments = new Map<AttachmentType, { count: number; bytes: number }>();
  const scan: SourceScan = {
    files: 0,
    bytes: 0,
    notes: 0,
    folders: 0,
    attachments: { count: 0, bytes: 0, byType: [] },
    canvases: new BoundedList(),
    drawings: new BoundedList(),
    skipped: new BoundedList(),
    byKey: new Map(),
    templates: 0,
  };
  const templatesPrefix = options.templatesFolder ? `${options.templatesFolder}/` : null;
  const walk = walkVault(root, {
    ...(options.signal ? { signal: options.signal } : {}),
    prune: (path) => {
      if (!isSourceSidecar(path)) return false;
      scan.skipped.add({ path, reason: "sidecar" });
      return true;
    },
  });
  for await (const entry of walk) {
    if (entry.kind === "skipped") {
      scan.skipped.add({ path: entry.path, reason: entry.reason });
      continue;
    }
    const hidden = isHiddenPath(entry.path);
    if (entry.kind === "folder") {
      if (!hidden) scan.folders++;
      continue;
    }
    scan.files++;
    scan.bytes += entry.size;
    scan.byKey.set(pathKey(entry.path), entry.path);
    if (hidden) continue;
    const lower = entry.path.toLowerCase();
    if (lower.endsWith(DRAWING_SUFFIX)) {
      scan.drawings.add(entry.path);
    } else if (lower.endsWith(".md")) {
      scan.notes++;
      if (templatesPrefix && entry.path.startsWith(templatesPrefix)) scan.templates++;
    } else if (lower.endsWith(".canvas")) {
      scan.canvases.add(entry.path);
    } else {
      const type = attachmentType(lower);
      const summary = attachments.get(type) ?? { count: 0, bytes: 0 };
      summary.count++;
      summary.bytes += entry.size;
      attachments.set(type, summary);
      scan.attachments.count++;
      scan.attachments.bytes += entry.size;
    }
  }
  scan.attachments.byType = ATTACHMENT_TYPES.filter((type) => attachments.has(type)).map(
    (type) => ({ type, ...attachments.get(type)! }),
  );
  return scan;
}

function attachmentType(lowerPath: string): AttachmentType {
  const dot = lowerPath.lastIndexOf(".");
  const slash = lowerPath.lastIndexOf("/");
  if (dot <= slash + 1) return "other";
  const extension = lowerPath.slice(dot + 1);
  return Object.hasOwn(EXTENSION_TYPES, extension) ? EXTENSION_TYPES[extension]! : "other";
}

function byExtension(type: AttachmentType, extensions: string): Record<string, AttachmentType> {
  return Object.fromEntries(extensions.split(" ").map((ext) => [ext, type]));
}
