import type { Thread, ThreadSummary } from "@ddl/core";
import type { RoutineDraft } from "../../state/ui-store";

const NAME_LENGTH = 60;
const NAME_FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

function withoutControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out;
}

/**
 * A file name from a task's text: characters a routine's name can't have become spaces, and a
 * long text is cut at a word, so the name is a readable start of the task.
 */
export function routineNameFor(text: string): string {
  const cleaned = withoutControlCharacters(text)
    .replace(NAME_FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trimEnd();
  const chars = [...cleaned];
  if (chars.length <= NAME_LENGTH) return cleaned;
  const cut = chars.slice(0, NAME_LENGTH).join("");
  const space = cut.lastIndexOf(" ");
  return (space >= NAME_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** "Repeat this" on a finished task: its text as the instructions; the user picks the schedule. */
export function repeatDraft(thread: Pick<Thread | ThreadSummary, "id" | "title">): RoutineDraft {
  const text = thread.title.replace(/\s+/g, " ").trim();
  return {
    name: routineNameFor(text),
    instructions: text,
    notify: "always",
    fromThreadId: thread.id,
  };
}
