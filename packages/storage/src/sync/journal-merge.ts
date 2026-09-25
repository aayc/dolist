/**
 * The SyncEngine's merge rule for the agent's append-only journals (`isJournalPath`): both copies
 * changed, so keep every line of both, once, in the order every reader folds them. Nothing else
 * about the format matters here: a line is an event when it is a JSON object with a string `id`
 * and numeric `epoch` and `seq`.
 *
 * - Events are unioned by `id` and ordered by `(epoch, seq, id)`; two different lines with the
 *   same id (never written by one app, but a disk can flip bits) keep the smaller one.
 * - Lines that aren't events (a line cut short by a crash, garbage) are kept too, once each, after
 *   the events: readers skip them as before, and nothing a device wrote is ever dropped.
 * - The result depends only on the set of lines, not on which side is which, so the two devices
 *   end with the same bytes and a merge never needs a conflict copy.
 */

interface JournalLine {
  id: string;
  epoch: number;
  seq: number;
  text: string;
}

export function mergeJournals(ours: string, theirs: string): string {
  const events = new Map<string, JournalLine>();
  const others = new Set<string>();
  for (const text of [...lines(ours), ...lines(theirs)]) {
    const event = parseEventLine(text);
    if (!event) {
      others.add(text);
      continue;
    }
    const known = events.get(event.id);
    if (!known || text < known.text) events.set(event.id, event);
  }
  const ordered = [...events.values()].sort(
    (a, b) =>
      a.epoch - b.epoch ||
      a.seq - b.seq ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  );
  const rest = [...others].sort();
  return [...ordered.map((event) => event.text), ...rest].map((text) => `${text}\n`).join("");
}

function lines(content: string): string[] {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() !== "") out.push(line);
  }
  return out;
}

function parseEventLine(text: string): JournalLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, epoch, seq } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return null;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return { id, epoch, seq, text };
}
