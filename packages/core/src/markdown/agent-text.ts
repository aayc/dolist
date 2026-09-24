/**
 * Text the agent wrote into a note. Each such line ends with an Obsidian comment naming the thread
 * that wrote it, `%%agent:thr_abc%%` (`%%agent%%` without one). Obsidian hides the comment; our
 * editors hide it and draw the line as agent text, linked to its thread. The marker belongs to the
 * whole line and stays when the user edits the line (they can delete it to make the line theirs).
 */
// No leading `[ \t]*`: unanchored, it would rescan a long run of blanks from every position.
export const AGENT_MARKER_RE = /%%agent(?::([A-Za-z0-9_-]{1,64}))?%%[ \t]*$/;

export interface AgentLine {
  /** The line without its marker. */
  text: string;
  /** The thread that wrote it, when the marker names one. */
  threadId: string | null;
  /** Offset in the line where the marker (with the blanks before it) starts. */
  markerFrom: number;
}

/** The agent's authorship of `line`, or null for the user's lines. */
export function parseAgentLine(line: string): AgentLine | null {
  if (!line.includes("%%agent")) return null;
  const match = AGENT_MARKER_RE.exec(line);
  if (!match) return null;
  let from = match.index;
  while (from > 0 && (line[from - 1] === " " || line[from - 1] === "\t")) from--;
  return { text: line.slice(0, from), threadId: match[1] ?? null, markerFrom: from };
}

export function isAgentLine(line: string): boolean {
  return parseAgentLine(line) !== null;
}

/** `line` without an agent marker (unchanged when it has none). */
export function stripAgentMarker(line: string): string {
  return parseAgentLine(line)?.text ?? line;
}

export function agentMarker(threadId?: string | null): string {
  return threadId && /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? `%%agent:${threadId}%%` : "%%agent%%";
}

/**
 * `text` as a line the agent wrote. Blank lines stay unmarked (a marker alone would show up as an
 * empty agent line); an existing marker is replaced.
 */
export function markAgentLine(text: string, threadId?: string | null): string {
  const body = stripAgentMarker(text).replace(/[ \t]+$/, "");
  return body.trim() === "" ? body : `${body} ${agentMarker(threadId)}`;
}
