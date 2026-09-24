/**
 * What a text setting's draft saves, or null when there is nothing to save. Required settings (model
 * ids) save trimmed text and never blank text, so clearing the field to retype it saves nothing.
 */
export function draftToCommit(draft: string, value: string, required = false): string | null {
  const next = required ? draft.trim() : draft;
  if (next === value || (required && next === "")) return null;
  return next;
}
