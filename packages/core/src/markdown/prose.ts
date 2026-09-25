/**
 * Whether a line that isn't a task may be addressed to the agent. Only such lines wake the
 * orchestrator by themselves (each wake is a model turn); every other line still reaches it in the
 * whole-note view of the next digest. Deliberately generous: the orchestrator makes the call.
 */
const QUESTION = /\?\s*$/;
const ADDRESS = /^(?:@\s*agent\b|agent\s*[:,]|@\w|todo\b|to do:|reminder\b|remind me\b)/i;
const REQUEST_LEAD =
  /^(?:please\s+)?(?:find|look\s*up|look\s+into|research|book|reserve|buy|order|schedule|plan|compare|check|figure\s+out|summari[sz]e|draft|write|email|message|text|send|translate|explain|recommend|suggest|get|renew|cancel|track|organi[sz]e|prepare|set\s+up|sign\s+up|remind|can\s+you|could\s+you|would\s+you|help\s+me)\b/i;

/** "Every morning, brief me on…": something to do again and again (a routine). */
const RECURRING_REQUEST =
  /^(?:every|each)\s+(?:\S+\s+){0,4}?(?:please\s+)?(?:brief|send|check|remind|tell|give|summari[sz]e|find|look|review|track|watch|monitor|write|draft|email|let|carry|move)\b/i;

export function mayBeRequest(line: string): boolean {
  const text = line
    .trim()
    .replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^#{1,6}\s+/, "");
  if (text.length < 3) return false;
  return (
    QUESTION.test(text) ||
    ADDRESS.test(text) ||
    REQUEST_LEAD.test(text) ||
    RECURRING_REQUEST.test(text)
  );
}
