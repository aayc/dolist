import { formatDate, fromLocalDate, type LocalDate } from "./dates";

export interface TemplateContext {
  /** Title of the note being created (its file stem). */
  title: string;
  /** The note's date (for daily notes, the day the note represents). */
  date: LocalDate;
  /** Wall-clock time used for `{{time}}`. */
  now?: Date;
  dateFormat?: string;
  timeFormat?: string;
}

/**
 * Renders Obsidian core-template variables: `{{title}}`, `{{date}}`, `{{time}}`,
 * `{{date:FORMAT}}` and `{{time:FORMAT}}`. Unknown variables are left untouched.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const now = ctx.now ?? new Date();
  const noteDate = fromLocalDate(ctx.date);
  const dateFormat = ctx.dateFormat ?? "YYYY-MM-DD";
  const timeFormat = ctx.timeFormat ?? "HH:mm";
  return template.replace(
    /\{\{\s*(title|date|time)\s*(?::\s*([^}]+?))?\s*}}/gi,
    (whole, name: string, format: string | undefined) => {
      switch (name.toLowerCase()) {
        case "title":
          return ctx.title;
        case "date":
          return formatDate(noteDate, format ?? dateFormat);
        case "time":
          return formatDate(now, format ?? timeFormat);
        default:
          return whole;
      }
    },
  );
}
