/**
 * Rules for the harness file tools (read/grep/find/ls, write/edit): where the path points and,
 * for writes, whether the content stages something dangerous to run later.
 */
import { TOOL } from "../../tools/contracts";
import type { ActionFacts } from "../facts";
import { initialCwd, type ResolvedPath, resolvePath } from "../paths";
import { writtenContentHits } from "./content";
import { readPathHits, writePathHits } from "./path-rules";
import { info, quote, type RuleHit } from "./types";

export const FILES_READ = info("files.read", "read", "allow", "low", "Reads or searches files");
export const NOTES_READ = info(
  "notes.read",
  "read",
  "allow",
  "low",
  "Reads or searches your notes",
);
export const FILES_WORKSPACE_WRITE = info(
  "file_write.workspace",
  "file_write",
  "allow",
  "low",
  "Writes files inside the task workspace",
);
export const SECRET_SEARCH = info(
  "credentials.secret-search",
  "credentials",
  "require_approval",
  "medium",
  "Searches files outside the workspace for passwords, keys or tokens",
);

const SECRET_WORDS_RE =
  /pass(?:word|wd|phrase)|secret|token|api[ _-]?key|private[ _-]?key|BEGIN [A-Z ]*PRIVATE|credential|aws_access|bearer/i;

export function resolveToolPath(facts: ActionFacts, raw: string): ResolvedPath {
  return resolvePath(raw, initialCwd(facts.ctx.workspaceDir), facts.ctx.workspaceDir);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function writtenContent(input: Readonly<Record<string, unknown>>): string {
  const parts = [str(input.content), str(input.newText), str(input.text)];
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object")
        parts.push(str((edit as Record<string, unknown>).newText));
    }
  }
  return parts.filter((p): p is string => p !== undefined).join("\n");
}

export interface FileAnalysis {
  hits: RuleHit[];
  benign?: RuleHit;
}

export function fileReadAnalysis(facts: ActionFacts): FileAnalysis {
  const raw = str(facts.input.path) ?? ".";
  const target = resolveToolPath(facts, raw);
  const hits: RuleHit[] = [];
  if (facts.operation === TOOL.read || facts.operation === TOOL.grep)
    hits.push(...readPathHits(target, raw));
  const pattern = str(facts.input.pattern);
  if (
    facts.operation === TOOL.grep &&
    pattern &&
    SECRET_WORDS_RE.test(pattern) &&
    target.location !== "workspace"
  ) {
    hits.push({ rule: SECRET_SEARCH, evidence: `${quote(pattern)} in ${raw}` });
  }
  return hits.length > 0 ? { hits } : { hits, benign: { rule: FILES_READ, evidence: raw } };
}

export function fileWriteAnalysis(facts: ActionFacts): FileAnalysis {
  const raw = str(facts.input.path);
  const hits: RuleHit[] = [];
  const target: ResolvedPath = raw
    ? resolveToolPath(facts, raw)
    : { location: "unknown", path: "(no path)" };
  hits.push(...writePathHits(target, raw ?? "(no path)"));
  hits.push(...writtenContentHits(writtenContent(facts.input)));
  return hits.length > 0
    ? { hits }
    : { hits, benign: { rule: FILES_WORKSPACE_WRITE, evidence: raw ?? "" } };
}
