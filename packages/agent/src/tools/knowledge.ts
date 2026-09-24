import {
  errorResult,
  isHiddenPath,
  isMarkdownPath,
  normalizePath,
  resolveWikiLink,
  type ToolSpec,
  textResult,
  truncate,
} from "@ddl/core";
import { type StorageProvider, searchVault } from "@ddl/storage";
import { TOOL } from "./contracts";
import { asInput, guarded, optionalInt, requireString, ToolInputError } from "./input";

export interface KnowledgeToolsOptions {
  storage: StorageProvider;
  maxNoteChars?: number;
}

const DEFAULT_MAX_NOTE_CHARS = 40_000;

export function createKnowledgeTools(options: KnowledgeToolsOptions): ToolSpec[] {
  const { storage } = options;
  const maxChars = options.maxNoteChars ?? DEFAULT_MAX_NOTE_CHARS;

  const readNote: ToolSpec = {
    name: TOOL.readNote,
    label: "Read note",
    description:
      "Read a note from the user's vault by path (e.g. Daily/2026-09-23.md or a wikilink target like Projects/Kyoto).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path." } },
      required: ["path"],
      additionalProperties: false,
    },
    safety: {
      readOnly: true,
      category: "read",
      describe: (input) => `Read note ${String((input as { path?: unknown })?.path ?? "")}`,
    },
    execute: (input) =>
      guarded(async () => {
        const requested = requireString(asInput(input), "path", { maxLength: 1_000 });
        const path = await resolveNotePath(storage, requested);
        if (!path) return errorResult(`Note not found: ${requested}`);
        const file = await storage.read(path);
        if (!file) return errorResult(`Note not found: ${requested}`);
        const body =
          file.content.length > maxChars
            ? `${file.content.slice(0, maxChars)}\n\n[… truncated: ${file.content.length - maxChars} more characters]`
            : file.content;
        return textResult(`# ${path}\n\n${body}`, { path, version: file.version });
      }),
  };

  const searchNotes: ToolSpec = {
    name: TOOL.searchNotes,
    label: "Search notes",
    description: "Full-text search across the user's notes. Returns matching lines with paths.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    safety: {
      readOnly: true,
      category: "read",
      describe: (input) =>
        `Search notes for "${String((input as { query?: unknown })?.query ?? "")}"`,
    },
    execute: (input) =>
      guarded(async () => {
        const args = asInput(input);
        const query = requireString(args, "query", { maxLength: 500 });
        const limit = optionalInt(args, "limit", { min: 1, max: 50 }) ?? 10;
        const hits = await searchVault(storage, query, { limit });
        if (hits.length === 0) return textResult(`No notes match "${query}".`);
        const lines = hits.map((hit) =>
          hit.kind === "name"
            ? `${hit.path} (name match)`
            : `${hit.path}:${hit.line + 1}: ${truncate(hit.preview.trim(), 200)}`,
        );
        return textResult(lines.join("\n"), { hits });
      }),
  };

  return [readNote, searchNotes];
}

async function resolveNotePath(
  storage: StorageProvider,
  requested: string,
): Promise<string | null> {
  let path: string;
  try {
    path = normalizePath(
      requested
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]!
        .split("#")[0]!,
    );
  } catch {
    throw new ToolInputError(`Invalid path: ${requested}`);
  }
  if (!path || isHiddenPath(path)) throw new ToolInputError(`Not a readable note: ${requested}`);
  if (await storage.stat(path)) return path;
  if (!isMarkdownPath(path) && (await storage.stat(`${path}.md`))) return `${path}.md`;
  const entries = await storage.list();
  return resolveWikiLink(
    path,
    entries.map((e) => e.path),
  );
}
