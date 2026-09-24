import type { RuleHit } from "./types";
import { info } from "./types";

/**
 * `edit_note`: the agent writing in the user's notes. Its own text (new lines, lines it wrote
 * earlier) goes in directly, marked as the agent's; changing or deleting the user's text asks
 * first. `mine: true` is the agent's claim that it wrote a line — the tool refuses the edit when
 * the note says otherwise, so the claim can't be used to skip approval.
 */
export const NOTE_EDIT_OWN = info(
  "notes.edit.own",
  "file_write",
  "allow",
  "low",
  "Adds its own text to a note, or changes lines it wrote",
);
export const NOTE_EDIT_USER_TEXT = info(
  "notes.edit.user-text",
  "file_write",
  "require_approval",
  "medium",
  "Changes text you wrote in a note",
);
export const NOTE_EDIT_DELETE_USER_TEXT = info(
  "notes.edit.delete-user-text",
  "destructive",
  "require_approval",
  "medium",
  "Deletes text you wrote from a note",
);
export const NOTE_EDIT_UNREADABLE = info(
  "notes.edit.unreadable",
  "file_write",
  "require_approval",
  "medium",
  "A note edit the rules can't read",
);
export const NOTE_EDIT_HIDDEN = info(
  "notes.edit.hidden-path",
  "system",
  "deny",
  "critical",
  "Writes to the app's hidden state instead of a note",
);

export const NOTE_EDIT_RULES = [
  NOTE_EDIT_OWN,
  NOTE_EDIT_USER_TEXT,
  NOTE_EDIT_DELETE_USER_TEXT,
  NOTE_EDIT_UNREADABLE,
  NOTE_EDIT_HIDDEN,
] as const;

export function noteEditHits(input: Readonly<Record<string, unknown>>): RuleHit[] {
  const hits: RuleHit[] = [];
  const path = typeof input.notePath === "string" ? input.notePath : "";
  if (path.split("/").some((segment) => segment.startsWith("."))) {
    hits.push({ rule: NOTE_EDIT_HIDDEN, evidence: path });
  }
  const edits = Array.isArray(input.edits) ? input.edits : [];
  if (edits.length === 0) hits.push({ rule: NOTE_EDIT_UNREADABLE, evidence: "no edits" });
  for (const edit of edits) {
    if (typeof edit !== "object" || edit === null) {
      hits.push({ rule: NOTE_EDIT_UNREADABLE, evidence: "not an edit" });
      continue;
    }
    const e = edit as Record<string, unknown>;
    const mine = e.mine === true;
    const target = String(e.expect ?? e.taskId ?? "").slice(0, 120);
    switch (e.op) {
      case "add_under":
      case "insert_after":
      case "append":
        hits.push({ rule: NOTE_EDIT_OWN, evidence: String(e.op) });
        break;
      case "replace":
      case "set_checkbox":
        hits.push(
          mine
            ? { rule: NOTE_EDIT_OWN, evidence: `${e.op} (its own line)` }
            : { rule: NOTE_EDIT_USER_TEXT, evidence: `“${target}”` },
        );
        break;
      case "delete":
        hits.push(
          mine
            ? { rule: NOTE_EDIT_OWN, evidence: "delete (its own line)" }
            : { rule: NOTE_EDIT_DELETE_USER_TEXT, evidence: `“${target}”` },
        );
        break;
      default:
        hits.push({ rule: NOTE_EDIT_UNREADABLE, evidence: String(e.op ?? "no op") });
    }
  }
  return hits;
}
